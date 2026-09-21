import std/[os, random, strutils, tables, unittest]

include ../src/radio_chromite_backend

proc testTrack(id, artist, album: string, weight = 1.0): Track =
  Track(id: id, artist: artist, album: album, title: id,
    relativePath: id & ".mp3", filePath: id & ".mp3", size: 1, weight: weight)

proc resetLibrary(values: seq[Track]) =
  tracks = values
  sessions.clear()

proc testSession(id: string): SessionState = sessionState(id, 1_000)

randomize(42)

suite "hierarchical scheduler":
  test "folder and title parsing use the album folder as source of truth":
    check parseAlbumFolder("Nine Inch Nails - The Fragile") == ("Nine Inch Nails", "The Fragile")
    check parseAlbumFolder("Loose Tracks") == ("UNKNOWN ARTIST", "Loose Tracks")
    check parseTrackTitle("Orgy - Blue Monday.mp3", "Orgy") == "Blue Monday"
    check parseTrackTitle("Stitches.mp3", "Orgy") == "Stitches"

  test "artists are not weighted by their number of tracks":
    var values = @[testTrack("solo", "Solo", "Only")]
    for index in 0 ..< 20: values.add(testTrack("many" & $index, "Many", "Album"))
    resetLibrary(values)
    var counts = initCountTable[string]()
    for _ in 0 ..< 10_000:
      let state = SessionState(lastSeenAt: 1_000)
      counts.inc(selectNextTrack(state).artist)
    check abs(counts["Solo"] - counts["Many"]) < 700

  test "albums are not weighted by their number of tracks":
    var values = @[testTrack("small", "Artist", "Small")]
    for index in 0 ..< 20: values.add(testTrack("large" & $index, "Artist", "Large"))
    resetLibrary(values)
    var counts = initCountTable[string]()
    for _ in 0 ..< 10_000:
      let state = SessionState(lastSeenAt: 1_000)
      counts.inc(selectNextTrack(state).album)
    check abs(counts["Small"] - counts["Large"]) < 700

  test "track weights are cumulative and zero disables a track":
    let candidates = @[testTrack("one", "A", "X"), testTrack("two", "A", "X", 2),
      testTrack("zero", "A", "X", 0)]
    var counts = initCountTable[string]()
    for _ in 0 ..< 30_000: counts.inc(weightedRandomTrack(candidates).id)
    check counts["zero"] == 0
    check counts["two"] > counts["one"] * 18 div 10
    check counts["two"] < counts["one"] * 22 div 10

  test "recent artist album and track are rejected by normal windows":
    let recent = testTrack("recent", "Recent", "Recent album")
    resetLibrary(@[recent, testTrack("fresh", "Fresh", "Fresh album")])
    let state = testSession("same-session")
    recordSelection(state, recent)
    check artistWasRecent(state.selectionHistory, "Recent", ArtistRepeatWindow)
    check albumWasRecent(state.selectionHistory, "Recent", "Recent album", AlbumRepeatWindow)
    check trackWasRecent(state.selectionHistory, "recent", TrackRepeatWindow)
    check "Recent" notin eligibleArtists(state.selectionHistory, ArtistRepeatWindow)

  test "same session shares scheduler history across selections":
    resetLibrary(@[testTrack("one", "One", "Album one"), testTrack("two", "Two", "Album two")])
    let state = testSession("same-session")
    discard selectNextTrack(state)
    discard selectNextTrack(state)
    check state.selectionHistory.len == 2

  test "different sessions do not share artist album or track recency":
    let selected = testTrack("selected", "Artist", "Album")
    resetLibrary(@[selected, testTrack("other", "Other", "Other album")])
    let stateA = testSession("session-a")
    let stateB = testSession("session-b")
    recordSelection(stateA, selected)
    check artistWasRecent(stateA.selectionHistory, "Artist", ArtistRepeatWindow)
    check albumWasRecent(stateA.selectionHistory, "Artist", "Album", AlbumRepeatWindow)
    check trackWasRecent(stateA.selectionHistory, "selected", TrackRepeatWindow)
    check not artistWasRecent(stateB.selectionHistory, "Artist", ArtistRepeatWindow)
    check not albumWasRecent(stateB.selectionHistory, "Artist", "Album", AlbumRepeatWindow)
    check not trackWasRecent(stateB.selectionHistory, "selected", TrackRepeatWindow)

  test "fallback finds another playable track":
    let first = testTrack("first", "Only artist", "Only album")
    let second = testTrack("second", "Only artist", "Only album")
    resetLibrary(@[first, second])
    let stateA = testSession("fallback-a")
    let stateB = testSession("fallback-b")
    recordSelection(stateA, first)
    check selectNextTrack(stateA, "first").id == "second"
    check stateB.selectionHistory.len == 0

  test "session history is capped independently":
    resetLibrary(@[])
    let stateA = testSession("cap-a")
    let stateB = testSession("cap-b")
    for index in 0 ..< SessionHistoryLimit + 10:
      recordSelection(stateA, testTrack("a" & $index, "Artist", "Album"))
    recordSelection(stateB, testTrack("b", "Other", "Other album"))
    check stateA.selectionHistory.len == SessionHistoryLimit
    check stateA.selectionHistory[0].id == "a10"
    check stateB.selectionHistory.len == 1

  test "expired sessions are removed without deleting active sessions":
    resetLibrary(@[])
    discard sessionState("expired", 1_000)
    discard sessionState("active", 1_000 + SessionTtlSeconds)
    cleanupExpiredSessions(1_001 + SessionTtlSeconds)
    check not sessions.hasKey("expired")
    check sessions.hasKey("active")

  test "random-track requires a valid opaque session header":
    check isRandomTrackPath("/api/random-track")
    check isRandomTrackPath("/api/random-track/excluded")
    check not isRandomTrackPath("/api/health")
    check not validSessionId("")
    check not validSessionId("contains a space")
    check not validSessionId(repeat('a', SessionIdMaxLength + 1))
    check validSessionId("550e8400-e29b-41d4-a716-446655440000")

  test "priority loading tolerates invalid input and missing files":
    let testDirectory = getTempDir() / "radio-chromite-scheduler-tests"
    createDir(testDirectory)
    let prioritiesPath = testDirectory / "priorities.txt"
    writeFile(prioritiesPath, "# comment\nArtist - Album/One.mp3 | 2\ninvalid\nnegative.mp3 | -1\nzero.mp3 | 0\n")
    let loaded = loadPriorities(prioritiesPath)
    check loaded.len == 2
    check loaded[normalizePath("Artist - Album\\One.mp3")] == 2
    check loaded[normalizePath("zero.mp3")] == 0
    check loadPriorities(testDirectory / "missing.txt").len == 0
    removeFile(prioritiesPath)
    removeDir(testDirectory)
