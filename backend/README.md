# Local audio backend

Scans `C:\Users\Admin\Desktop\vk` by default and streams MP3 files with HTTP Range support.

Environment variables:

- `MUSIC_LIBRARY_PATH` — alternate music library path.
- `AUDIO_SERVER_PORT` — backend port, defaults to `8787`.
- `NEXT_PUBLIC_AUDIO_API_URL` — frontend API URL, defaults to `http://localhost:8787`.

Run both services from the project root with `npm run dev`.
