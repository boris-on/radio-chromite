# RADIO CHROMITE

Next.js frontend and Nim audio streaming backend.

## Configuration

Copy `.env.example` to `.env`. The root `.env` file is the single place for
machine-specific paths:

```dotenv
MUSIC_LIBRARY_PATH=/srv/radio-chromite/music
# NORMALIZED_LIBRARY_PATH=/srv/radio-chromite/music-normalized
# NIM_BIN_DIR=/opt/nim/bin
# C_COMPILER_BIN_DIR=/opt/gcc/bin
# FFMPEG_BIN_DIR=/opt/ffmpeg/bin
RADIO_DOMAIN=radio.example.com
```

On Windows, use native paths instead:

```dotenv
MUSIC_LIBRARY_PATH=C:\Music\Radio
# NORMALIZED_LIBRARY_PATH=C:\Music\Radio-normalized
# NIM_BIN_DIR=C:\nim\nim-2.2.10\bin
# C_COMPILER_BIN_DIR=C:\msys64\mingw64\bin
# FFMPEG_BIN_DIR=C:\ffmpeg\bin
RADIO_DOMAIN=radio.example.com
```

Relative paths are resolved from the project directory. If no music path is set,
the local fallback is the `music` directory in the project root.

## Linux server with Docker Compose

The deployment contains three containers:

- `caddy` — public HTTPS reverse proxy on ports `80` and `443`;
- `frontend` — internal Next.js interface;
- `backend` — internal Nim audio server with FFmpeg.

The browser uses same-origin `/api` requests through the frontend proxy. The
frontend and backend ports are not exposed publicly.

### 1. Configure the server

```bash
cp .env.example .env
nano .env
```

Set at least:

```dotenv
MUSIC_LIBRARY_PATH=/srv/radio-chromite/music
RADIO_DOMAIN=radio.example.com
```

The library must contain album directories with MP3 files:

```text
/srv/radio-chromite/music/
├── Album One/
│   ├── Artist - Track One.mp3
│   └── Artist - Track Two.mp3
└── Album Two/
    └── Artist - Track Three.mp3
```

Make sure Docker can read it:

```bash
chmod -R a+rX /srv/radio-chromite/music
```

### 2. Build and start

```bash
docker compose up -d --build
```

Create an `A` DNS record (and `AAAA` when IPv6 is configured) for
`RADIO_DOMAIN`. Allow inbound TCP ports `80` and `443`, plus UDP `443` for
HTTP/3. Caddy obtains and renews the HTTPS certificate automatically.

Until `RADIO_DOMAIN` is configured, Compose still starts and Caddy serves the
site over plain HTTP on port `80`. After adding the domain to `.env`, run
`docker compose up -d` again to enable automatic HTTPS.

### 3. Status and logs

```bash
docker compose ps
docker compose logs -f caddy backend frontend
curl https://radio.example.com/api/health
```

Update or stop:

```bash
git pull
docker compose up -d --build
docker compose down
```

The cover cache and Caddy certificates are stored in named volumes. A normal
`docker compose down` preserves them; `docker compose down -v` removes them.

The backend rescans the active music directory every 30 seconds, so newly added
MP3 files appear without restarting the container.

## Local development

Install Node.js, Nim, FFmpeg and FFprobe, then create `.env` as described above.

Start the frontend:

```bash
npm install
npm run dev:frontend
```

Start the backend in a second terminal:

```bash
npm run backend
```

If a local tool is not available through `PATH`, set `NIM_BIN_DIR`,
`C_COMPILER_BIN_DIR` or `FFMPEG_BIN_DIR` in the root `.env` file.

The same commands work on Windows and Linux. There are also compatibility
launchers:

```powershell
.\backend-nim\run.ps1
```

```bash
sh backend-nim/run.sh
```

Normalize the configured library on either platform:

```bash
npm run normalize
```
