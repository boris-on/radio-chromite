version       = "1.0.0"
author        = "Radio Chromite"
description   = "Independent Nim audio streaming backend"
license       = "MIT"
srcDir        = "src"
bin           = @["radio_chromite_backend"]

requires "nim >= 2.0.0"

task run, "Run the audio backend":
  exec "nim c -r -d:release src/radio_chromite_backend.nim"
