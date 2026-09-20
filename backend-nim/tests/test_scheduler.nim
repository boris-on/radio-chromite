import std/[os, random, strutils, tables, unittest]

include ../src/radio_chromite_backend

proc testTrack(id, artist, album: string, weight = 1.0): Track =
  Track(id: id, artist: artist, album: album, title: id,
    relativePath: id & ".mp3", filePath: id & ".mp3", size: 1, weight: weight)

proc resetLibrary(values: seq[Track]) =
  tracks = values
  selectionHistory.setLen(0)

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
      selectionHistory.setLen(0)
      counts.inc(selectNextTrack().artist)
    check abs(counts["Solo"] - counts["Many"]) < 700

  test "albums are not weighted by their number of tracks":
    var values = @[testTrack("small", "Artist", "Small")]
    for index in 0 ..< 20: values.add(testTrack("large" & $index, "Artist", "Large"))
    resetLibrary(values)
    var counts = initCountTable[string]()
    for _ in 0 ..< 10_000:
      selectionHistory.setLen(0)
      counts.inc(selectNextTrack().album)
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
    selectionHistory.add(recent)
    check artistWasRecent("Recent", ArtistRepeatWindow)
    check albumWasRecent("Recent", "Recent album", AlbumRepeatWindow)
    check trackWasRecent("recent", TrackRepeatWindow)
    check "Recent" notin eligibleArtists(ArtistRepeatWindow)

  test "fallback finds another playable track":
    let first = testTrack("first", "Only artist", "Only album")
    let second = testTrack("second", "Only artist", "Only album")
    resetLibrary(@[first, second])
    selectionHistory.add(first)
    check selectNextTrack("first").id == "second"

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
