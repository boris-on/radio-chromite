# RADIO CHROMITE

Next.js frontend and Nim audio streaming backend.

## Linux server with Docker Compose

The deployment contains three containers:

- `caddy` — public HTTPS reverse proxy on ports `80` and `443`;
- `frontend` — internal Next.js interface;
- `backend` — internal Nim audio server with FFmpeg.

The browser uses same-origin `/api` requests through the frontend proxy. The frontend and backend ports are not exposed publicly.

### 1. Configure the music directory

```bash
cp .env.example .env
nano .env
```

Set an absolute Linux path:

```dotenv
MUSIC_PATH=/srv/radio-chromite/music
RADIO_DOMAIN=radio.example.com
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

Create an `A` DNS record (and `AAAA` when IPv6 is configured) for `RADIO_DOMAIN` pointing to the server. Allow inbound TCP ports `80` and `443`, plus UDP `443` for HTTP/3. Then open `https://RADIO_DOMAIN`. Caddy obtains and renews the certificate automatically; the first issuance can take a short time after DNS propagation.

### 3. Status and logs

```bash
docker compose ps
docker compose logs -f caddy backend frontend
curl https://RADIO_DOMAIN/api/health
```

### Updating and stopping

```bash
git pull
docker compose up -d --build
```

```bash
docker compose down
```

The extracted cover cache and Caddy certificates are kept in named volumes. `docker compose down` preserves them; `docker compose down -v` removes them. Do not use `-v` unless certificate and cover-cache removal is intended.

The Nim backend rescans the active music directory every 30 seconds. Newly added
MP3 files become available automatically without restarting the container.

## Local development

```powershell
npm install
npm run dev:frontend
```

```
cd "C:\Users\Admin\Downloads\metalheart-radio(3)\metalheart-radio\backend-nim"
.\run.ps1
```
