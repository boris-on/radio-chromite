# Radio Chromite Nim backend

Independent asynchronous Nim implementation. Existing Node and Lua backends are not modified.

## API

- `GET /api/health`
- `GET /api/tracks`
- `GET|HEAD /api/stream/:id` with HTTP Range
- `GET|HEAD /api/cover/:id`
- `GET /api/metadata/:id`

Audio is streamed asynchronously in 64 KB chunks. Covers are cached on disk. No more than five metadata objects are cached in memory; MP3 contents are never retained in memory.

## Install

Nim 2.x is installed under `C:\nim`. Confirm it with:

```powershell
C:\nim\nim-2.2.10\bin\nim.exe --version
C:\nim\nim-2.2.10\bin\nimble.exe --version
```

No third-party Nim packages are required. FFmpeg and FFprobe are already installed.

## Run

```powershell
cd backend-nim
.\run.ps1
```

`run.ps1` automatically adds the installed Nim and MSYS2 MinGW directories to the process PATH before compiling and starting the server.

The server listens on all network interfaces at port `8789` by default. From another device on the LAN it is available at `http://COMPUTER_IP:8789`.

The frontend uses its same-origin `/api` proxy by default, so no public API URL is required. To connect directly instead:

```powershell
$env:NEXT_PUBLIC_AUDIO_API_URL='http://localhost:8789'
npm run dev:frontend
```

## Environment variables

- `AUDIO_SERVER_PORT` — default `8789`
- `MUSIC_LIBRARY_PATH` — explicit library path
- `SOURCE_LIBRARY_PATH` — default `C:\Users\Admin\Desktop\vk`
- `NORMALIZED_LIBRARY_PATH` — default `<source>-normalized`

The normalized library is selected only after `.normalization-complete` exists.
