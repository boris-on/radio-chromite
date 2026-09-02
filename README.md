# RADIO CHROMITE

Next.js frontend and Nim audio streaming backend.

## Linux server with Docker Compose

The deployment contains two containers:

- `frontend` — public Next.js interface on port `3000` by default;
- `backend` — Nim audio server with FFmpeg on public port `8789` by default.

The browser uses same-origin `/api` requests through the frontend proxy. Port `8789` is also published for direct API access from the local network.

### 1. Configure the music directory

```bash
cp .env.example .env
nano .env
```

Set an absolute Linux path:

```dotenv
MUSIC_PATH=/srv/radio-chromite/music
WEB_PORT=3000
BACKEND_PORT=8789
```

`MUSIC_PATH` must contain album directories with MP3 files. It is mounted inside the backend container as `/music` in read-only mode.

```text
/srv/radio-chromite/music/
├── Album One/
│   ├── Artist - Track One.mp3
│   └── Artist - Track Two.mp3
└── Album Two/
    └── Artist - Track Three.mp3
```

Make sure the container can read the library:

```bash
chmod -R a+rX /srv/radio-chromite/music
```

### 2. Build and start

```bash
docker compose up -d --build
```

Open `http://SERVER_IP:3000`. If `WEB_PORT` is changed, use that port instead.

### 3. Status and logs

```bash
docker compose ps
docker compose logs -f backend frontend
curl http://127.0.0.1:3000/api/health
```

### Updating and stopping

```bash
git pull
docker compose up -d --build
```

```bash
docker compose down
```

The extracted cover cache is kept in the named volume `cover-cache`. `docker compose down` preserves it; `docker compose down -v` removes it.

## Local development

```powershell
npm install
npm run dev:frontend
```

```
cd "C:\Users\Admin\Downloads\metalheart-radio(3)\metalheart-radio\backend-nim"
.\run.ps1
```
