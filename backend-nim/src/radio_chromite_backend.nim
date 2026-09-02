import std/[algorithm, asynchttpserver, asyncdispatch, asyncnet, httpcore, json, nativesockets, os, osproc, sequtils, sha1, strformat, strutils, tables, times]

type
  Track = ref object
    id, artist, title, album, filePath: string
    size: int64

  ServerMetrics = object
    totalRequests, packetsRx, bytesRx, openStreams: int64
    httpStatus: int
    requestId: string

const
  DefaultSource = r"C:\Users\Admin\Desktop\vk"
  ChunkSize = 64 * 1024
  MetadataCacheLimit = 5

let
  port = Port(parseInt(getEnv("AUDIO_SERVER_PORT", "8789")))
  sourceLibrary = getEnv("SOURCE_LIBRARY_PATH", DefaultSource)
  normalizedLibrary = getEnv("NORMALIZED_LIBRARY_PATH", sourceLibrary & "-normalized")
  explicitLibrary = getEnv("MUSIC_LIBRARY_PATH")
  musicLibrary = if explicitLibrary.len > 0: explicitLibrary elif fileExists(normalizedLibrary / ".normalization-complete"): normalizedLibrary else: sourceLibrary
  cacheDirectory = getCurrentDir() / ".cover-cache"
  startedAt = epochTime()

var
  tracks: seq[Track]
  tracksById = initTable[string, Track]()
  metadataCache = initOrderedTable[string, JsonNode]()
  metrics = ServerMetrics(httpStatus: 200, requestId: "RX-000000")
  trackCatalogueJson = "[]"

proc splitTrackName(fileName: string): tuple[artist, title: string] =
  let base = splitFile(fileName).name
  let marker = base.find(" - ")
  if marker < 0: ("UNKNOWN ARTIST", base)
  else: (base[0 ..< marker].strip(), base[marker + 3 .. ^1].strip())

proc trackId(relativePath: string): string =
  ($secureHash(relativePath.toLowerAscii()))[0 .. 15].toLowerAscii()

proc scanLibrary() =
  if not dirExists(musicLibrary): raise newException(IOError, "Music library not found: " & musicLibrary)
  for filePath in walkDirRec(musicLibrary):
    if filePath.splitFile.ext.toLowerAscii() != ".mp3": continue
    let relativeName = relativePath(filePath, musicLibrary)
    let parsed = splitTrackName(filePath.extractFilename())
    var album = relativeName.parentDir.lastPathPart()
    let separator = album.find(" - ")
    if separator >= 0: album = album[separator + 3 .. ^1]
    let track = Track(id: trackId(relativeName), artist: parsed.artist, title: parsed.title,
      album: album, filePath: filePath, size: getFileSize(filePath))
    tracks.add(track)
  tracks.sort(proc(a, b: Track): int =
    result = cmp(a.artist.toLowerAscii(), b.artist.toLowerAscii())
    if result == 0: result = cmp(a.title.toLowerAscii(), b.title.toLowerAscii()))
  for track in tracks: tracksById[track.id] = track

proc corsHeaders(contentType = "application/json; charset=utf-8"): HttpHeaders =
  result = newHttpHeaders()
  result["Access-Control-Allow-Origin"] = "*"
  result["Access-Control-Allow-Headers"] = "Range, Content-Type"
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

proc publicTracks(): JsonNode =
  result = newJArray()
  for track in tracks:
    result.add(%*{"id":track.id,"artist":track.artist,"title":track.title,"album":track.album,
      "size":track.size,"streamUrl":"/api/stream/" & track.id,"coverUrl":"/api/cover/" & track.id})

proc callback(request: Request) {.async.} =
  request.client.setSockOpt(OptNoDelay, true)
  inc metrics.totalRequests
  metrics.requestId = &"RX-{metrics.totalRequests:06X}"
  let path = request.url.path
  try:
    if request.reqMethod == HttpOptions:
      var headers = corsHeaders(); headers["Content-Length"] = "0"
      await request.respond(Http204, "", headers)
    elif path == "/api/health":
      await sendJson(request,Http200,%*{"ok":true,"tracks":tracks.len,"library":musicLibrary,"backend":"nim","metrics":{
        "requestId":metrics.requestId,"totalRequests":metrics.totalRequests,"packetsRx":metrics.packetsRx,
        "bytesRx":metrics.bytesRx,"openStreams":metrics.openStreams,"httpStatus":metrics.httpStatus,
        "uptimeSeconds":int(epochTime()-startedAt),"memRss":getOccupiedMem()}})
    elif path == "/api/tracks": await sendJsonText(request, Http200, trackCatalogueJson)
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

createDir(cacheDirectory)
scanLibrary()
trackCatalogueJson = $publicTracks()
echo &"[audio-server-nim] {tracks.len} tracks from {musicLibrary}"
echo &"[audio-server-nim] listening on http://localhost:{port.int}"
var server = newAsyncHttpServer()
let serverCallback = proc(request: Request): Future[void] {.gcsafe.} =
  {.cast(gcsafe).}:
    result = callback(request)
waitFor server.serve(port, serverCallback, address="0.0.0.0")
