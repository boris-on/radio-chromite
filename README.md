# NULLWAVE / Metalheart-style Web Radio

A complete responsive Next.js + React + Tailwind web-radio interface inspired by experimental 2000–2003 Flash / demoscene / cyber-industrial design.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Set the radio stream

Edit `app/page.tsx` and replace:

```ts
export const RADIO_STREAM_URL = "https://example.com/replace-with-your-radio-stream.mp3";
```

with your Icecast/Shoutcast/direct audio stream URL.

## Visual assets

The large metallic renders are loaded remotely from Pixabay and are marked on their source pages as free for use under the Pixabay Content License:

- https://pixabay.com/illustrations/chrome-3d-render-metal-silver-649761/
- https://pixabay.com/illustrations/metal-shiny-3d-reflection-silver-1453399/
- https://pixabay.com/illustrations/chrome-metal-cubic-metallic-298841/
- https://pixabay.com/vectors/dvd-cd-rom-compact-disc-cd-digital-152917/

The CSS intentionally crops, layers, desaturates and overlaps them to emulate early-2000s Flash compositions.
