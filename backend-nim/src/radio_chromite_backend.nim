import std/[algorithm, asynchttpserver, asyncdispatch, asyncnet, httpcore, json, math, nativesockets, os, osproc, random, sequtils, sha1, strformat, strutils, tables, times]

type
  Track = ref object
    id, artist, album, title, relativePath, filePath: string
    size: int64
    weight: float64

  ServerMetrics = object
    totalRequests, packetsRx, bytesRx, openStreams: int64
    httpStatus: int
    requestId: string

  SessionState = ref object
    selectionHistory: seq[Track]
    lastSeenAt: float

const
  ChunkSize = 64 * 1024
  MetadataCacheLimit = 5
  ArtistRepeatWindow = 5
  AlbumRepeatWindow = 12
  TrackRepeatWindow = 50
  SessionHistoryLimit = TrackRepeatWindow
  SessionTtlSeconds = 24 * 60 * 60
  SessionCleanupIntervalMs = 10 * 60 * 1000
  SessionIdMaxLength = 128
  LibraryRescanIntervalMs = 30_000
  FallbackRuleSets = [
    (artistWindow: 5, albumWindow: 12, trackWindow: 50),
    (artistWindow: 3, albumWindow: 8, trackWindow: 40),
    (artistWindow: 1, albumWindow: 4, trackWindow: 20),
    (artistWindow: 0, albumWindow: 0, trackWindow: 0)
  ]

let
  projectRoot = getAppDir().parentDir
  port = Port(parseInt(getEnv("AUDIO_SERVER_PORT", "8789")))
  sourceLibrary = absolutePath(getEnv("MUSIC_LIBRARY_PATH", projectRoot / "music"), projectRoot)
  normalizedLibrary = absolutePath(getEnv("NORMALIZED_LIBRARY_PATH", sourceLibrary & "-normalized"), projectRoot)
  musicLibrary = normalizedLibrary
  priorityFile = sourceLibrary / "priorities.txt"
  cacheDirectory = getCurrentDir() / ".cover-cache"
  startedAt = epochTime()

var
  tracks: seq[Track]
  tracksById = initTable[string, Track]()
  metadataCache = initOrderedTable[string, JsonNode]()
  metrics = ServerMetrics(httpStatus: 200, requestId: "RX-000000")
  trackCatalogueJson = "[]"
  sessions = initTable[string, SessionState]()
  priorityEntryCount: int
  libraryScanCount: int64
  lastLibraryScanAt: float

proc normalizePath(path: string): string =
  result = path.replace('\\', '/').strip()
  while result.startsWith("./"): result = result[2 .. ^1]
  result = result.toLowerAscii()

proc parseAlbumFolder(folderName: string): tuple[artist, album: string] =
  let marker = folderName.find(" - ")
  if marker < 0:
    ("UNKNOWN ARTIST", folderName.strip())
  else:
    (folderName[0 ..< marker].strip(), folderName[marker + 3 .. ^1].strip())

proc parseTrackTitle(fileName, artist: string): string =
  result = splitFile(fileName).name.strip()
  let prefix = artist & " - "
  if result.toLowerAscii().startsWith(prefix.toLowerAscii()):
    result = result[prefix.len .. ^1].strip()

proc loadPriorities(filePath = priorityFile): Table[string, float64] =
  result = initTable[string, float64]()
  if not fileExists(filePath): return

  var lineNumber = 0
  for rawLine in lines(filePath):
    inc lineNumber
    let line = rawLine.strip()
    if line.len == 0 or line.startsWith("#"): continue
    let separator = line.rfind('|')
    if separator < 1 or separator == line.high:
      stderr.writeLine(&"[audio-server-nim] invalid priority line {lineNumber}: {line}")
      continue
    let relativeName = normalizePath(line[0 ..< separator])
    try:
      let weight = parseFloat(line[separator + 1 .. ^1].strip())
      if weight < 0 or weight.classify in {fcNan, fcInf, fcNegInf}:
        stderr.writeLine(&"[audio-server-nim] invalid priority line {lineNumber}: {line}")
      else:
        result[relativeName] = weight
    except ValueError:
      stderr.writeLine(&"[audio-server-nim] invalid priority line {lineNumber}: {line}")
  echo &"[audio-server-nim] priorities loaded: {result.len} overrides"

proc trackId(relativePath: string): string =
  ($secureHash(relativePath.toLowerAscii()))[0 .. 15].toLowerAscii()

proc scanLibrary(priorities: Table[string, float64]) =
  if not dirExists(musicLibrary): raise newException(IOError, "Music library not found: " & musicLibrary)
  var scannedTracks: seq[Track]
  var scannedById = initTable[string, Track]()
  for filePath in walkDirRec(musicLibrary):
    if filePath.splitFile.ext.toLowerAscii() != ".mp3": continue
    let relativeName = relativePath(filePath, musicLibrary)
    let parsed = parseAlbumFolder(relativeName.parentDir.lastPathPart())
    let title = parseTrackTitle(filePath.extractFilename(), parsed.artist)
    let weight = priorities.getOrDefault(normalizePath(relativeName), 1.0)
    let track = Track(id: trackId(relativeName), artist: parsed.artist, album: parsed.album,
      title: title, relativePath: relativeName, filePath: filePath,
      size: getFileSize(filePath), weight: weight)
    scannedTracks.add(track)
  scannedTracks.sort(proc(a, b: Track): int =
    result = cmp(a.artist.toLowerAscii(), b.artist.toLowerAscii())
    if result == 0: result = cmp(a.title.toLowerAscii(), b.title.toLowerAscii()))
  for track in scannedTracks: scannedById[track.id] = track
  tracks = scannedTracks
  tracksById = scannedById

proc corsHeaders(contentType = "application/json; charset=utf-8"): HttpHeaders =
  result = newHttpHeaders()
  result["Access-Control-Allow-Origin"] = "*"
  result["Access-Control-Allow-Headers"] = "Range, Content-Type, X-Radio-Session"
  result["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
  result["Access-Control-Expose-Headers"] = "Content-Length, Content-Range, Accept-Ranges"
  result["Content-Type"] = contentType

proc sendJsonText(request: Request, code: HttpCode, body: string) {.async.} =
  var headers = corsHeaders()
  headers["Cache-Control"] = "no-store"
  headers["Content-Length"] = $body.len
  await request.respond(code, body, headers)

proc sendJson(request: Request, code: HttpCode, value: JsonNode) {.async.} =
  await sendJsonText(request, code, $value)

proc statusLine(code: HttpCode): string =
  case code
  of Http200: "HTTP/1.1 200 OK\r\n"
  of Http206: "HTTP/1.1 206 Partial Content\r\n"
  of Http204: "HTTP/1.1 204 No Content\r\n"
  of Http404: "HTTP/1.1 404 Not Found\r\n"
  of Http416: "HTTP/1.1 416 Range Not Satisfiable\r\n"
  else: "HTTP/1.1 500 Internal Server Error\r\n"

proc sendFile(request: Request, filePath, contentType: string, first, last: int64,
              code: HttpCode, extra: seq[(string, string)] = @[]) {.async.} =
  let length = last - first + 1
  var raw = statusLine(code)
  var headers = corsHeaders(contentType)
  headers["Content-Length"] = $length
  headers["Accept-Ranges"] = "bytes"
  headers["Cache-Control"] = if contentType == "image/jpeg": "public, max-age=86400" else: "no-cache"
  for (key, value) in extra: headers[key] = value
  for key, value in headers.pairs: raw.add(key & ": " & value & "\r\n")
  raw.add("\r\n")
  await request.client.send(raw)
  if request.reqMethod == HttpHead: return

  var file = open(filePath, fmRead)
  defer: file.close()
  file.setFilePos(first)
  var remaining = length
  if contentType == "audio/mpeg": inc metrics.openStreams
  defer:
    if contentType == "audio/mpeg": metrics.openStreams = max(0'i64, metrics.openStreams - 1)
  var buffer = newString(ChunkSize)
  while remaining > 0:
    let wanted = min(remaining, ChunkSize.int64).int
    let count = file.readBuffer(addr buffer[0], wanted)
    if count <= 0: break
    await request.client.send(buffer[0 ..< count])
    remaining -= count

proc streamTrack(request: Request, track: Track) {.async.} =
  let rangeHeader = $request.headers.getOrDefault("Range")
  if rangeHeader.len == 0:
    metrics.httpStatus = 200
    if request.reqMethod != HttpHead:
      inc metrics.packetsRx
      metrics.bytesRx += track.size
    await sendFile(request, track.filePath, "audio/mpeg", 0, track.size - 1, Http200)
    return

  if not rangeHeader.startsWith("bytes=") or '-' notin rangeHeader:
    await sendJson(request, Http416, %*{"error": "Invalid range"})
    return
  let parts = rangeHeader[6 .. ^1].split('-', 1)
  let first = if parts[0].len > 0: parseBiggestInt(parts[0]) else: 0
  let requestedLast = if parts.len > 1 and parts[1].len > 0: parseBiggestInt(parts[1]) else: track.size - 1
  let last = min(requestedLast, track.size - 1)
  if first < 0 or first > last or first >= track.size:
    await sendJson(request, Http416, %*{"error": "Range outside file"})
    return
  metrics.httpStatus = 206
  if request.reqMethod != HttpHead:
    inc metrics.packetsRx
    metrics.bytesRx += last - first + 1
  await sendFile(request, track.filePath, "audio/mpeg", first, last, Http206,
    @[("Content-Range", &"bytes {first}-{last}/{track.size}")])

proc waitForProcess(process: Process) {.async.} =
  while process.peekExitCode() == -1: await sleepAsync(15)

proc coverPath(track: Track): Future[string] {.async.} =
  let target = cacheDirectory / (track.id & ".jpg")
  if fileExists(target): return target
  let process = startProcess("ffmpeg", args = @["-v", "error", "-y", "-i", track.filePath,
    "-map", "0:v:0", "-frames:v", "1", "-q:v", "2", target], options = {poUsePath, poStdErrToStdOut})
  await waitForProcess(process)
  process.close()
  return if fileExists(target): target else: ""

proc crc32(filePath: string): string =
  var table: array[256, uint32]
  for value in 0 .. 255:
    var crc = value.uint32
    for _ in 0 .. 7: crc = if (crc and 1) != 0: (crc shr 1) xor 0xedb88320'u32 else: crc shr 1
    table[value] = crc
  var crc = 0xffffffff'u32
  var file = open(filePath, fmRead)
  defer: file.close()
  var buffer = newString(ChunkSize)
  while true:
    let count = file.readBuffer(addr buffer[0], buffer.len)
    if count <= 0: break
    for index in 0 ..< count: crc = table[((crc xor buffer[index].uint8.uint32) and 0xff).int] xor (crc shr 8)
  toHex(not crc, 8)

proc probe(filePath: string): Table[string, string] =
  let output = execProcess("ffprobe", args = @["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels,channel_layout,bit_rate,duration:format=duration,size,bit_rate",
    "-of", "default=noprint_wrappers=1", filePath], options = {poUsePath, poStdErrToStdOut})
  result = initTable[string, string]()
  for line in output.splitLines():
    let marker = line.find('=')
    if marker > 0: result[line[0 ..< marker]] = line[marker + 1 .. ^1]

proc number(values: Table[string, string], key: string, fallback: float): float =
  try: parseFloat(values.getOrDefault(key, $fallback)) except ValueError: fallback

proc readMetadata(track: Track): JsonNode =
  let values = probe(track.filePath)
  let duration = number(values, "duration", 0)
  let sampleRate = number(values, "sample_rate", 44100)
  let bitRate = number(values, "bit_rate", 0)
  let frameRate = sampleRate / 1152
  let frameCount = int(duration * frameRate + 0.5)
  let frameSize = if frameCount > 0: int(track.size div frameCount) else: 0
  result = %*{
    "format":"MPEG AUDIO", "version":"MPEG-1", "layer":"III", "mode":"JOINT_STEREO",
    "channels": int(number(values,"channels",2)), "frequency":sampleRate, "bitrate":bitRate,
    "rateMode":"CBR", "frameRate":frameRate, "frameCount":frameCount, "frameSize":frameSize,
    "samplesPerFrame":1152, "samples":frameCount*1152, "padFrames":0, "padRatio":0.0,
    "dataOffset":0, "dataLength":track.size, "fileLength":track.size, "fileSizeMb":track.size.float/1_000_000,
    "id3v1":false, "id3v2":true, "xing":false, "vbri":false,
    "crc32":crc32(track.filePath), "sha1":($secureHashFile(track.filePath)).toUpperAscii(), "playTime":duration
  }

proc cachedMetadata(track: Track): JsonNode =
  if metadataCache.hasKey(track.id): return metadataCache[track.id]
  result = readMetadata(track)
  metadataCache[track.id] = result
  while metadataCache.len > MetadataCacheLimit: metadataCache.del(metadataCache.keys.toSeq()[0])

proc publicTrack(track: Track): JsonNode =
  %*{"id":track.id,"artist":track.artist,"title":track.title,"album":track.album,
    "size":track.size,"streamUrl":"/api/stream/" & track.id,"coverUrl":"/api/cover/" & track.id}

proc publicTracks(): JsonNode =
  result = newJArray()
  for track in tracks:
    result.add(publicTrack(track))

proc refreshLibrary() =
  let previousCount = tracks.len
  let priorities = loadPriorities()
  priorityEntryCount = priorities.len
  scanLibrary(priorities)
  trackCatalogueJson = $publicTracks()
  inc libraryScanCount
  lastLibraryScanAt = epochTime()
  if tracks.len != previousCount:
    echo &"[audio-server-nim] library refreshed: {previousCount} -> {tracks.len} tracks"

proc libraryRefreshLoop() {.async.} =
  while true:
    await sleepAsync(LibraryRescanIntervalMs)
    try:
      refreshLibrary()
    except CatchableError as error:
      stderr.writeLine("[audio-server-nim] library refresh failed: " & error.msg)

proc normalized(value: string): string = value.strip().toLowerAscii()

proc albumKey(artist, album: string): string =
  normalized(artist) & "\x1f" & normalized(album)

proc albumKey(track: Track): string =
  albumKey(track.artist, track.album)

proc trackWasRecent(history: seq[Track], id: string, window: int): bool =
  let first = max(0, history.len - window)
  for index in first ..< history.len:
    if history[index].id == id: return true

proc artistWasRecent(history: seq[Track], artist: string, window: int): bool =
  let wanted = normalized(artist)
  let first = max(0, history.len - window)
  for index in first ..< history.len:
    if normalized(history[index].artist) == wanted: return true

proc albumWasRecent(history: seq[Track], artist, album: string, window: int): bool =
  let wanted = albumKey(artist, album)
  let first = max(0, history.len - window)
  for index in first ..< history.len:
    if albumKey(history[index]) == wanted: return true

proc uniqueArtists(): seq[string] =
  var seen = initTable[string, bool]()
  for track in tracks:
    if track.weight <= 0: continue
    let key = normalized(track.artist)
    if not seen.hasKey(key):
      seen[key] = true
      result.add(track.artist)

proc uniqueAlbums(artist: string): seq[string] =
  let wantedArtist = normalized(artist)
  var seen = initTable[string, bool]()
  for track in tracks:
    if track.weight <= 0 or normalized(track.artist) != wantedArtist: continue
    let key = albumKey(track)
    if not seen.hasKey(key):
      seen[key] = true
      result.add(track.album)

proc eligibleArtists(history: seq[Track], window: int): seq[string] =
  for artist in uniqueArtists():
    if not artistWasRecent(history, artist, window): result.add(artist)

proc eligibleAlbums(history: seq[Track], artist: string, window: int): seq[string] =
  for album in uniqueAlbums(artist):
    if not albumWasRecent(history, artist, album, window): result.add(album)

proc eligibleTracks(history: seq[Track], artist, album: string, window: int, excludeId: string): seq[Track] =
  let wantedArtist = normalized(artist)
  let wantedAlbum = albumKey(artist, album)
  for track in tracks:
    if track.weight <= 0 or track.id == excludeId: continue
    if normalized(track.artist) != wantedArtist or albumKey(track) != wantedAlbum: continue
    if not trackWasRecent(history, track.id, window): result.add(track)

proc weightedRandomTrack(candidates: seq[Track]): Track =
  var total = 0.0
  for track in candidates: total += track.weight
  if total <= 0: return nil
  let target = rand(total)
  var cumulative = 0.0
  for track in candidates:
    cumulative += track.weight
    if target < cumulative: return track
  candidates[^1]

proc recordSelection(state: SessionState, track: Track) =
  state.selectionHistory.add(track)
  if state.selectionHistory.len > SessionHistoryLimit:
    state.selectionHistory.delete(0 .. state.selectionHistory.len - SessionHistoryLimit - 1)

proc selectNextTrack(state: SessionState, excludeId = ""): Track =
  let history = state.selectionHistory
  for fallbackLevel, rules in FallbackRuleSets:
    var artists = eligibleArtists(history, rules.artistWindow)
    artists.shuffle()
    for artist in artists:
      var albums = eligibleAlbums(history, artist, rules.albumWindow)
      albums.shuffle()
      for album in albums:
        let candidates = eligibleTracks(history, artist, album, rules.trackWindow, excludeId)
        if candidates.len == 0: continue
        result = weightedRandomTrack(candidates)
        if not result.isNil:
          if fallbackLevel > 0:
            echo &"[audio-server-nim] scheduler fallback level={fallbackLevel}"
          recordSelection(state, result)
          return

proc validSessionId(value: string): bool =
  if value.len == 0 or value.len > SessionIdMaxLength or value != value.strip(): return false
  for character in value:
    if not (character.isAlphaNumeric or character in {'-', '_', '.', ':'}): return false
  true

proc isRandomTrackPath(path: string): bool =
  path == "/api/random-track" or path.startsWith("/api/random-track/")

proc sessionState(sessionId: string, now = epochTime()): SessionState =
  if not sessions.hasKey(sessionId):
    sessions[sessionId] = SessionState(lastSeenAt: now)
  result = sessions[sessionId]
  result.lastSeenAt = now

proc cleanupExpiredSessions(now = epochTime()) =
  for sessionId in sessions.keys.toSeq():
    if now - sessions[sessionId].lastSeenAt > SessionTtlSeconds.float:
      sessions.del(sessionId)

proc sessionCleanupLoop() {.async.} =
  while true:
    await sleepAsync(SessionCleanupIntervalMs)
    cleanupExpiredSessions()

proc callback(request: Request) {.async.} =
  inc metrics.totalRequests
  metrics.requestId = &"RX-{metrics.totalRequests:06X}"
  let path = request.url.path
  try:
    if request.reqMethod == HttpOptions:
      var headers = corsHeaders(); headers["Content-Length"] = "0"
      await request.respond(Http204, "", headers)
    elif path == "/api/health":
      await sendJson(request,Http200,%*{"ok":true,"tracks":tracks.len,"library":musicLibrary,"backend":"nim","scheduler":{
        "activeSessions":sessions.len,"artistWindow":ArtistRepeatWindow,
        "albumWindow":AlbumRepeatWindow,"trackWindow":TrackRepeatWindow,
        "priorityFile":"priorities.txt","priorityEntries":priorityEntryCount},"libraryWatcher":{
        "intervalSeconds":LibraryRescanIntervalMs div 1000,"scanCount":libraryScanCount,
        "lastScanAt":lastLibraryScanAt},"metrics":{
        "requestId":metrics.requestId,"totalRequests":metrics.totalRequests,"packetsRx":metrics.packetsRx,
        "bytesRx":metrics.bytesRx,"openStreams":metrics.openStreams,"httpStatus":metrics.httpStatus,
        "uptimeSeconds":int(epochTime()-startedAt),"memRss":getOccupiedMem()}})
    elif path == "/api/tracks": await sendJsonText(request, Http200, trackCatalogueJson)
    elif isRandomTrackPath(path):
      let sessionId = $request.headers.getOrDefault("X-Radio-Session")
      if not validSessionId(sessionId):
        await sendJson(request, Http400, %*{"error":"Missing or invalid X-Radio-Session"})
        return
      let excludeId = if path.len > 18: path[18 .. ^1] else: ""
      let selected = selectNextTrack(sessionState(sessionId), excludeId)
      if selected.isNil:
        await sendJson(request, Http503, %*{
          "error":"No other playable track is available",
          "limits":{"album":AlbumRepeatWindow,"artist":ArtistRepeatWindow,"track":TrackRepeatWindow}})
      else:
        await sendJson(request, Http200, publicTrack(selected))
    elif path.startsWith("/api/stream/"):
      let id = path[12 .. ^1]
      if tracksById.hasKey(id):
        await streamTrack(request, tracksById[id])
      else:
        await sendJson(request, Http404, %*{"error": "Track not found"})
    elif path.startsWith("/api/cover/"):
      let id = path[11 .. ^1]
      if not tracksById.hasKey(id):
        await sendJson(request, Http404, %*{"error": "Cover not found"})
      else:
        let target = await coverPath(tracksById[id])
        if target.len > 0:
          await sendFile(request, target, "image/jpeg", 0, getFileSize(target) - 1, Http200)
        else:
          await sendJson(request, Http404, %*{"error": "Embedded cover not found"})
    elif path.startsWith("/api/metadata/"):
      let id = path[14 .. ^1]
      if tracksById.hasKey(id):
        await sendJson(request, Http200, cachedMetadata(tracksById[id]))
      else:
        await sendJson(request, Http404, %*{"error": "Track not found"})
    else:
      await sendJson(request, Http404, %*{"error": "Not found"})
  except CatchableError as error:
    stderr.writeLine("[audio-server-nim] " & error.msg)
    if not request.client.isClosed:
      try:
        await sendJson(request, Http500, %*{"error": "Internal server error"})
      except CatchableError:
        discard

when not defined(schedulerTests):
  createDir(cacheDirectory)
  randomize()
  refreshLibrary()
  echo &"[audio-server-nim] {tracks.len} tracks from {musicLibrary}"
  echo &"[audio-server-nim] listening on http://localhost:{port.int}"
  var server = newAsyncHttpServer()
  let serverCallback = proc(request: Request): Future[void] {.gcsafe.} =
    {.cast(gcsafe).}:
      result = callback(request)
  asyncCheck libraryRefreshLoop()
  asyncCheck sessionCleanupLoop()
  waitFor server.serve(port, serverCallback, address="0.0.0.0")
