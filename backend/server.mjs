import { createHash } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join, relative } from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.AUDIO_SERVER_PORT || 8787);
const SOURCE_LIBRARY_PATH = "C:\\Users\\Admin\\Desktop\\vk";
const NORMALIZED_LIBRARY_PATH = `${SOURCE_LIBRARY_PATH}-normalized`;
const NORMALIZED_LIBRARY_READY = join(NORMALIZED_LIBRARY_PATH, ".normalization-complete");
const MUSIC_LIBRARY_PATH = process.env.MUSIC_LIBRARY_PATH || (existsSync(NORMALIZED_LIBRARY_READY) ? NORMALIZED_LIBRARY_PATH : SOURCE_LIBRARY_PATH);

function splitTrackName(fileName) {
  const base = basename(fileName, extname(fileName));
  const separator = base.indexOf(" - ");
  return separator === -1
    ? { artist: "UNKNOWN ARTIST", title: base }
    : { artist: base.slice(0, separator).trim(), title: base.slice(separator + 3).trim() };
}

function scanLibrary() {
  if (!existsSync(MUSIC_LIBRARY_PATH)) {
    throw new Error(`Music library not found: ${MUSIC_LIBRARY_PATH}`);
  }

  const tracks = [];
  for (const albumEntry of readdirSync(MUSIC_LIBRARY_PATH, { withFileTypes: true })) {
    if (!albumEntry.isDirectory()) continue;
    const albumPath = join(MUSIC_LIBRARY_PATH, albumEntry.name);
    for (const fileEntry of readdirSync(albumPath, { withFileTypes: true })) {
      if (!fileEntry.isFile() || extname(fileEntry.name).toLowerCase() !== ".mp3") continue;
      const filePath = join(albumPath, fileEntry.name);
      const relativePath = relative(MUSIC_LIBRARY_PATH, filePath);
      const { artist, title } = splitTrackName(fileEntry.name);
      tracks.push({
        id: createHash("sha1").update(relativePath).digest("hex").slice(0, 16),
        artist,
        title,
        album: albumEntry.name.includes(" - ") ? albumEntry.name.split(" - ").slice(1).join(" - ") : albumEntry.name,
        filePath,
        size: statSync(filePath).size,
      });
    }
  }
  return tracks.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
}

const tracks = scanLibrary();
const tracksById = new Map(tracks.map((track) => [track.id, track]));
const metadataCache = new Map();
const serverStartedAt = Date.now();
let totalRequests = 0;
let streamRequests = 0;
let bytesServed = 0;
let openStreams = 0;
let lastStreamStatus = 200;
let lastRequestId = "RX-000000";

function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,codec_long_name,profile,sample_rate,channels,channel_layout,bit_rate,duration:format=duration,size,bit_rate,format_name", "-of", "json", filePath], { windowsHide: true });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error || `ffprobe exited with ${code}`)));
  });
}

function inspectId3(filePath, size) {
  const fd = openSync(filePath, "r");
  try {
    const head = Buffer.alloc(Math.min(size, 65536));
    readSync(fd, head, 0, head.length, 0);
    const hasId3v2 = head.subarray(0, 3).toString() === "ID3";
    const dataOffset = hasId3v2 && head.length >= 10
      ? 10 + ((head[6] & 0x7f) << 21) + ((head[7] & 0x7f) << 14) + ((head[8] & 0x7f) << 7) + (head[9] & 0x7f)
      : 0;
    const tail = Buffer.alloc(Math.min(128, size));
    readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
    const hasId3v1 = tail.length === 128 && tail.subarray(0, 3).toString() === "TAG";
    const scanEnd = Math.min(head.length - 4, dataOffset + 8192);
    let header = null;
    for (let index = dataOffset; index < scanEnd; index++) {
      if (head[index] === 0xff && (head[index + 1] & 0xe0) === 0xe0) {
        header = head.readUInt32BE(index);
        break;
      }
    }
    const probeText = head.subarray(dataOffset, Math.min(head.length, dataOffset + 8192)).toString("latin1");
    return { hasId3v1, hasId3v2, dataOffset, header, hasXing: probeText.includes("Xing") || probeText.includes("Info"), hasVbri: probeText.includes("VBRI") };
  } finally {
    closeSync(fd);
  }
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const sha1 = createHash("sha1");
    let crc = 0xffffffff;
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => {
      sha1.update(chunk);
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ sha1: sha1.digest("hex").toUpperCase(), crc32: ((crc ^ 0xffffffff) >>> 0).toString(16).toUpperCase().padStart(8, "0") }));
  });
}

async function readTrackMetadata(track) {
  if (metadataCache.has(track.id)) return metadataCache.get(track.id);
  const job = (async () => {
    const [probe, hashes] = await Promise.all([runFfprobe(track.filePath), hashFile(track.filePath)]);
    const stream = probe.streams?.[0] || {};
    const duration = Number(stream.duration || probe.format?.duration || 0);
    const sampleRate = Number(stream.sample_rate || 44100);
    const bitRate = Number(stream.bit_rate || probe.format?.bit_rate || 0);
    const id3 = inspectId3(track.filePath, track.size);
    const header = id3.header;
    const padding = header === null ? 0 : (header >>> 9) & 1;
    const modeIndex = header === null ? 1 : (header >>> 6) & 3;
    const modes = ["STEREO", "JOINT_STEREO", "DUAL_CHANNEL", "MONO"];
    const samplesPerFrame = 1152;
    const frameRate = sampleRate / samplesPerFrame;
    const frameCount = Math.round(duration * frameRate);
    const dataLength = Math.max(0, track.size - id3.dataOffset - (id3.hasId3v1 ? 128 : 0));
    const baseFrameSize = bitRate && sampleRate ? Math.floor(144 * bitRate / sampleRate) : 0;
    const padFrames = baseFrameSize && frameCount ? Math.max(0, Math.min(frameCount, dataLength - baseFrameSize * frameCount)) : padding;
    return {
      format: "MPEG AUDIO", version: "MPEG-1", layer: "III", mode: modes[modeIndex], channels: Number(stream.channels || 2),
      frequency: sampleRate, bitrate: bitRate, rateMode: id3.hasXing || id3.hasVbri ? "VBR" : "CBR",
      frameRate, frameCount, frameSize: frameCount ? Math.round(dataLength / frameCount) : 0,
      samplesPerFrame, samples: frameCount * samplesPerFrame,
      padFrames, padRatio: frameCount ? padFrames / frameCount * 100 : 0,
      dataOffset: id3.dataOffset, dataLength, fileLength: track.size, fileSizeMb: track.size / 1_000_000,
      id3v1: id3.hasId3v1, id3v2: id3.hasId3v2, xing: id3.hasXing, vbri: id3.hasVbri,
      ...hashes, playTime: duration,
    };
  })();
  metadataCache.set(track.id, job);
  while (metadataCache.size > 5) metadataCache.delete(metadataCache.keys().next().value);
  try { return await job; } catch (error) { metadataCache.delete(track.id); throw error; }
}

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  response.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
}

function sendJson(response, status, data) {
  setCors(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

function streamTrack(request, response, track) {
  const range = request.headers.range;
  const commonHeaders = { "Content-Type": "audio/mpeg", "Accept-Ranges": "bytes", "Cache-Control": "no-cache" };
  setCors(response);

  if (!range) {
    lastStreamStatus = 200;
    response.writeHead(200, { ...commonHeaders, "Content-Length": track.size });
    if (request.method === "HEAD") return response.end();
    streamRequests++;
    bytesServed += track.size;
    openStreams++;
    response.once("close", () => { openStreams = Math.max(0, openStreams - 1); });
    return createReadStream(track.filePath).pipe(response);
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${track.size}` });
    return response.end();
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), track.size - 1) : track.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= track.size) {
    response.writeHead(416, { "Content-Range": `bytes */${track.size}` });
    return response.end();
  }

  lastStreamStatus = 206;
  response.writeHead(206, {
    ...commonHeaders,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${track.size}`,
  });
  if (request.method === "HEAD") return response.end();
  streamRequests++;
  bytesServed += end - start + 1;
  openStreams++;
  response.once("close", () => { openStreams = Math.max(0, openStreams - 1); });
  createReadStream(track.filePath, { start, end }).pipe(response);
}

function streamCover(response, track) {
  setCors(response);
  response.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400" });
  const ffmpeg = spawn("ffmpeg", ["-v", "error", "-i", track.filePath, "-map", "0:v:0", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], { windowsHide: true });
  ffmpeg.stdout.pipe(response);
  ffmpeg.on("error", () => response.destroy());
  ffmpeg.stderr.on("data", () => {});
}

export const server = createServer((request, response) => {
  totalRequests++;
  lastRequestId = `RX-${totalRequests.toString(16).toUpperCase().padStart(6, "0")}`;
  if (request.method === "OPTIONS") {
    setCors(response);
    response.writeHead(204);
    return response.end();
  }

  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  if (url.pathname === "/api/health") return sendJson(response, 200, {
    ok: true,
    tracks: tracks.length,
    library: MUSIC_LIBRARY_PATH,
    metrics: {
      requestId: lastRequestId,
      totalRequests,
      packetsRx: streamRequests,
      bytesRx: bytesServed,
      openStreams,
      httpStatus: lastStreamStatus,
      uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
      memRss: process.memoryUsage().rss,
    },
  });
  if (url.pathname === "/api/tracks") {
    return sendJson(response, 200, tracks.map(({ filePath, ...track }) => ({ ...track, streamUrl: `/api/stream/${track.id}`, coverUrl: `/api/cover/${track.id}` })));
  }

  const streamMatch = /^\/api\/stream\/([a-f0-9]+)$/.exec(url.pathname);
  if (streamMatch) {
    const track = tracksById.get(streamMatch[1]);
    return track ? streamTrack(request, response, track) : sendJson(response, 404, { error: "Track not found" });
  }

  const coverMatch = /^\/api\/cover\/([a-f0-9]+)$/.exec(url.pathname);
  if (coverMatch) {
    const track = tracksById.get(coverMatch[1]);
    return track ? streamCover(response, track) : sendJson(response, 404, { error: "Cover not found" });
  }

  const metadataMatch = /^\/api\/metadata\/([a-f0-9]+)$/.exec(url.pathname);
  if (metadataMatch) {
    const track = tracksById.get(metadataMatch[1]);
    if (!track) return sendJson(response, 404, { error: "Track not found" });
    return readTrackMetadata(track)
      .then((metadata) => sendJson(response, 200, metadata))
      .catch(() => sendJson(response, 500, { error: "Metadata unavailable" }));
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[audio-server] ${tracks.length} tracks from ${MUSIC_LIBRARY_PATH}`);
  console.log(`[audio-server] listening on http://localhost:${PORT}`);
});
