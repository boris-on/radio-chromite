"use client";

import { useEffect, useRef, useState } from "react";

const AUDIO_API = process.env.NEXT_PUBLIC_AUDIO_API_URL || "http://localhost:8787";

type Track = {
  id: string;
  artist: string;
  title: string;
  album: string;
  size: number;
  streamUrl: string;
  coverUrl: string;
};

type TechnicalMetadata = {
  format: string; version: string; layer: string; mode: string; channels: number;
  frequency: number; bitrate: number; rateMode: string; frameRate: number; frameCount: number; frameSize: number;
  samplesPerFrame: number; samples: number; padFrames: number; padRatio: number; dataOffset: number; dataLength: number;
  fileLength: number; fileSizeMb: number; id3v1: boolean; id3v2: boolean; xing: boolean; vbri: boolean;
  crc32: string; sha1: string; playTime: number;
};

type ServerMetrics = {
  requestId: string; totalRequests: number; packetsRx: number; bytesRx: number;
  openStreams: number; httpStatus: number; uptimeSeconds: number; memRss: number;
};

const apiUrl = (path: string) => `${AUDIO_API}${path}`;
const audioEndpoint = AUDIO_API.replace(/^https?:\/\//, "").toUpperCase();
const audioProtocol = AUDIO_API.startsWith("https://") ? "HTTPS" : "HTTP";
const pad = (value: number, length = 2) => Math.max(0, Math.round(value)).toString().padStart(length, "0");
const hex = (value: number) => `0x${Math.max(0, Math.round(value)).toString(16).toUpperCase().padStart(8, "0")}`;
const formatTime = (seconds: number) => `${pad(Math.floor(seconds / 60))}:${pad(Math.floor(seconds % 60))}`;
const formatUptime = (seconds: number) => `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds % 3600 / 60))}:${pad(seconds % 60)}`;

function TelemetryRow({ label, value, active = false }: { label: string; value: string; active?: boolean }) {
  return (
    <div className="telemetry-row">
      <span>{label}</span>
      <span className={active ? "telemetry-active" : ""}>{value}</span>
    </div>
  );
}

function MetalAsset({ src, className, alt }: { src: string; className: string; alt: string }) {
  return (
    <div className={`metal-asset ${className}`} aria-hidden="true">
      {/* External asset: Pixabay Content License */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} draggable={false} />
    </div>
  );
}

export default function Home() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const currentTrackRef = useRef<Track | null>(null);
  const upcomingTrackRef = useRef<Track | null>(null);
  const previousLatencyRef = useRef<number | null>(null);
  const serverStateKnownRef = useRef(false);
  const wasServerOnlineRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const [volume, setVolume] = useState(0.25);
  const [clock, setClock] = useState("00:00:00");
  const [library, setLibrary] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [history, setHistory] = useState<Track[]>([]);
  const [forwardHistory, setForwardHistory] = useState<Track[]>([]);
  const [playedTracks, setPlayedTracks] = useState<Track[]>([]);
  const [libraryError, setLibraryError] = useState(false);
  const [currentSecond, setCurrentSecond] = useState(0);
  const [duration, setDuration] = useState(0);
  const [technical, setTechnical] = useState<TechnicalMetadata | null>(null);
  const [serverOnline, setServerOnline] = useState(false);
  const [serverLatency, setServerLatency] = useState<number | null>(null);
  const [lastServerSync, setLastServerSync] = useState("--:--:--");
  const [serverMetrics, setServerMetrics] = useState<ServerMetrics | null>(null);
  const [jitter, setJitter] = useState(0);
  const [reconnects, setReconnects] = useState(0);
  const [bufferAhead, setBufferAhead] = useState(0);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-GB", { hour12: false }));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let active = true;
    const checkServer = async () => {
      const startedAt = performance.now();
      try {
        const response = await fetch(apiUrl("/api/health"), { cache: "no-store" });
        if (!response.ok) throw new Error("Server unavailable");
        const health = await response.json() as { metrics?: ServerMetrics };
        if (!active) return;
        const latency = Math.max(0, Math.round(performance.now() - startedAt));
        if (previousLatencyRef.current !== null) setJitter(Math.abs(latency - previousLatencyRef.current));
        previousLatencyRef.current = latency;
        if (serverStateKnownRef.current && !wasServerOnlineRef.current) setReconnects((count) => count + 1);
        serverStateKnownRef.current = true;
        wasServerOnlineRef.current = true;
        setServerOnline(true);
        setServerLatency(latency);
        setServerMetrics(health.metrics || null);
        setLastServerSync(new Date().toLocaleTimeString("en-GB", { hour12: false }));
      } catch {
        if (!active) return;
        serverStateKnownRef.current = true;
        wasServerOnlineRef.current = false;
        setServerOnline(false);
        setServerLatency(null);
      }
    };
    void checkServer();
    const interval = window.setInterval(checkServer, 10000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (!currentTrack) return;
    const controller = new AbortController();
    setTechnical(null);
    fetch(apiUrl(`/api/metadata/${currentTrack.id}`), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Metadata unavailable");
        return response.json() as Promise<TechnicalMetadata>;
      })
      .then((metadata) => {
        setTechnical(metadata);
        if (!duration && metadata.playTime) setDuration(metadata.playTime);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [currentTrack]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(apiUrl("/api/tracks"), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Library unavailable");
        return response.json() as Promise<Track[]>;
      })
      .then((tracks) => {
        setLibrary(tracks);
        const initialTrack = tracks[Math.floor(Math.random() * tracks.length)] || null;
        const upcomingCandidates = initialTrack ? tracks.filter((track) => track.id !== initialTrack.id) : tracks;
        upcomingTrackRef.current = upcomingCandidates[Math.floor(Math.random() * upcomingCandidates.length)] || null;
        currentTrackRef.current = initialTrack;
        setCurrentTrack(initialTrack);
        setPlayedTracks(initialTrack ? [initialTrack] : []);
        if (initialTrack && audioRef.current) {
          audioRef.current.src = apiUrl(initialTrack.streamUrl);
          audioRef.current.load();
        }
        setLibraryError(tracks.length === 0);
      })
      .catch((error: unknown) => {
        if ((error as Error).name !== "AbortError") setLibraryError(true);
      });
    return () => controller.abort();
  }, []);

  const randomTrack = (excludeId?: string) => {
    if (library.length === 0) return null;
    const candidates = library.length > 1 ? library.filter((track) => track.id !== excludeId) : library;
    return candidates[Math.floor(Math.random() * candidates.length)] || null;
  };

  const setUpcomingTrack = (excludeId?: string) => {
    const upcoming = randomTrack(excludeId);
    upcomingTrackRef.current = upcoming;
    return upcoming;
  };

  const switchTrack = async (track: Track, shouldPlay: boolean, rememberCurrent = true, updateRecent = true) => {
    const audio = audioRef.current;
    const previous = currentTrackRef.current;
    if (rememberCurrent && previous && previous.id !== track.id) {
      setHistory((items) => [...items, previous].slice(-5));
    }

    currentTrackRef.current = track;
    setCurrentTrack(track);
    setCurrentSecond(0);
    setDuration(0);
    if (updateRecent) {
      setPlayedTracks((items) => [track, ...items.filter((item) => item.id !== track.id)].slice(0, 5));
    }
    setPlaybackError(false);
    if (!audio) return;

    audio.pause();
    setBuffering(shouldPlay);
    audio.src = apiUrl(track.streamUrl);
    audio.volume = volume;
    audio.load();
    if (!shouldPlay) {
      setIsPlaying(false);
      return;
    }

    try {
      setBuffering(true);
      await audio.play();
      setIsPlaying(true);
      setHasStarted(true);
    } catch {
      setPlaybackError(true);
      setIsPlaying(false);
    } finally {
      setBuffering(false);
    }
  };

  const nextTrack = async (forcePlay = isPlaying) => {
    const forwardTrack = forwardHistory.at(-1);
    if (forwardTrack) {
      setForwardHistory((items) => items.slice(0, -1));
      await switchTrack(forwardTrack, forcePlay, true, false);
      return;
    }

    const next = upcomingTrackRef.current || randomTrack(currentTrackRef.current?.id);
    if (next) {
      setForwardHistory([]);
      setUpcomingTrack(next.id);
      await switchTrack(next, forcePlay);
    }
  };

  const previousTrack = async () => {
    const previous = history.at(-1);
    if (!previous) return;
    const current = currentTrackRef.current;
    setHistory((items) => items.slice(0, -1));
    if (current) setForwardHistory((items) => [...items, current].slice(-5));
    await switchTrack(previous, isPlaying, false, false);
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      setBuffering(false);
      return;
    }

    try {
      setPlaybackError(false);
      setBuffering(true);
      audio.volume = volume;
      await audio.play();
      setIsPlaying(true);
      setHasStarted(true);
    } catch {
      setIsPlaying(false);
      setPlaybackError(true);
    } finally {
      setBuffering(false);
    }
  };

  const readingMetadata = "READING MPEG FRAME DATA...";
  const metadataValue = (format: (metadata: TechnicalMetadata) => string) => technical ? format(technical) : readingMetadata;

  return (
    <main className={`site-shell ${isPlaying ? "is-playing" : ""}`}>
      <audio
        ref={audioRef}
        preload="none"
        onPlaying={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onWaiting={() => setBuffering(true)}
        onCanPlay={() => setBuffering(false)}
        onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          setCurrentSecond(audio.currentTime);
          setBufferAhead(audio.buffered.length ? Math.max(0, audio.buffered.end(audio.buffered.length - 1) - audio.currentTime) : 0);
        }}
        onProgress={(event) => {
          const audio = event.currentTarget;
          setBufferAhead(audio.buffered.length ? Math.max(0, audio.buffered.end(audio.buffered.length - 1) - audio.currentTime) : 0);
        }}
        onEnded={() => void nextTrack(true)}
        onError={() => {
          setBuffering(false);
          setIsPlaying(false);
          setPlaybackError(true);
        }}
      />

      <div className="blueprint-grid" aria-hidden="true" />
      <div className="wireframe-sphere sphere-a" aria-hidden="true" />
      <div className="wireframe-sphere sphere-b" aria-hidden="true" />
      <div className="scanlines" aria-hidden="true" />
      <div className="crt-vignette" aria-hidden="true" />

      <MetalAsset
        src="https://cdn.pixabay.com/photo/2015/02/25/23/56/chrome-649761_1280.jpg"
        className="metal-a"
        alt=""
      />
      <MetalAsset
        src="https://cdn.pixabay.com/photo/2016/06/13/00/33/metal-1453399_1280.jpg"
        className="metal-b"
        alt=""
      />
      <MetalAsset
        src="https://cdn.pixabay.com/photo/2014/03/26/17/47/chrome-298841_1280.jpg"
        className="metal-c"
        alt=""
      />
      <MetalAsset
        src="https://cdn.pixabay.com/photo/2015/02/25/23/56/chrome-649761_1280.jpg"
        className="metal-d"
        alt=""
      />
      <MetalAsset
        src="https://cdn.pixabay.com/photo/2016/06/13/00/33/metal-1453399_1280.jpg"
        className="metal-e"
        alt=""
      />

      <div className="mechanical-rail rail-left" aria-hidden="true">
        {Array.from({ length: 22 }).map((_, i) => <i key={i} />)}
      </div>
      <div className="mechanical-rail rail-right" aria-hidden="true">
        {Array.from({ length: 18 }).map((_, i) => <i key={i} />)}
      </div>

      <header className="topline">
        <div className="brand-block">
          <div className="brand-mark"><span>N</span><span>W</span></div>
          <div>
            <div className="brand-title">NULLWAVE // RADIO</div>
            <div className="brand-sub">EXPERIMENTAL TRANSMISSION NODE_001</div>
          </div>
        </div>
        <div className="top-status">
          <span className="blink-dot" /> SIGNAL // {isPlaying ? "ACTIVE" : "STANDBY"}
          <b>{clock}</b>
        </div>
      </header>

      <section className="micro-left" aria-hidden="true">
        <div>NODE 44.100 // RECEIVER_02</div>
        <div>CRC 08A7:DE44:F091</div>
        <div>X 512.00 / Y 512.00</div>
        <div className="ruler"><i/><i/><i/><i/><i/><i/><i/><i/></div>
      </section>

      <section id="radio" className="radio-zone">
        <div className="disc-assembly">
          <div className="disc-axis axis-horizontal" aria-hidden="true" />
          <div className="disc-axis axis-vertical" aria-hidden="true" />
          <button className={`cd-disc ${hasStarted ? "disc-spinning" : ""} ${hasStarted && !isPlaying ? "disc-paused" : ""}`} onClick={togglePlayback} aria-label={isPlaying ? "Pause radio" : "Play radio"}>
            {/* External CD artwork: Pixabay Content License */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cd-image" src="https://cdn.pixabay.com/photo/2013/07/12/18/04/dvd-152917_1280.png" alt="" draggable={false} />
            {currentTrack && <img className="cd-cover" src={apiUrl(currentTrack.coverUrl)} alt="" draggable={false} />}
            <span className="cd-inner-ring" />
            <span className="cd-track-ring ring-1" />
            <span className="cd-track-ring ring-2" />
            <span className="cd-track-ring ring-3" />
            <span className="cd-arc arc-a">RADIO_TRANSMISSION // NODE_001 // 44.100</span>
            <span className="cd-arc arc-b">STREAM.PROTOCOL / DIGITAL AUDIO / 320KBPS</span>
            <span className="cd-serial">NW-RX02 / 00193-A</span>
            <span className="cd-hole">
              <span className={isPlaying ? "pause-glyph" : "play-glyph"} />
            </span>
          </button>

          <div className="disc-caption">DISC MODULE // PHYSICAL CONTROL SURFACE</div>
        </div>

        <aside className="now-playing">
          <div className="panel-index">AUDIO NODE / 001</div>
          <div className="panel-rule"><span /></div>
          <h1>NOW PLAYING</h1>
          <div className="track-identity">
            <div>
              <p className="artist">{currentTrack?.artist || "LIBRARY OFFLINE"}</p>
              <p className="track">{currentTrack?.title || "START THE AUDIO BACKEND"}</p>
              <p className="album-name">{currentTrack?.album || "NO LOCAL TRACKS FOUND"}</p>
            </div>
          </div>
          <div className="track-code">TRK_{currentTrack?.id.slice(0, 6).toUpperCase() || "------"} / LOCAL MP3 / RANGE STREAM</div>
          <div className="telemetry-block">
            <TelemetryRow label="STREAM STATUS" value={playbackError ? "RETRY" : buffering ? "BUFFERING" : isPlaying ? "LOCKED" : "IDLE"} active={isPlaying} />
            <TelemetryRow label="SOURCE" value="LOCAL LIBRARY" />
            <TelemetryRow label="SAMPLE RATE" value="44.1 KHZ" />
            <TelemetryRow label="SIGNAL" value={isPlaying ? "-07 DB" : "-- DB"} active={isPlaying} />
          </div>
          <div className="playback-time" aria-label="Track playback time">
            <b>{formatTime(currentSecond)}/{formatTime(duration)}</b>
          </div>
          <div className="transport-controls">
            <button type="button" onClick={() => void previousTrack()} disabled={history.length === 0} aria-label="Previous track"><span>◀◀</span><small>PREV</small></button>
            <button type="button" onClick={togglePlayback} disabled={!currentTrack} aria-label={isPlaying ? "Pause radio" : "Play radio"}><span>{isPlaying ? "Ⅱ" : "▶"}</span><small>{isPlaying ? "PAUSE" : "PLAY"}</small></button>
            <button type="button" onClick={() => void nextTrack()} disabled={library.length < 2} aria-label="Next track"><span>▶▶</span><small>NEXT</small></button>
          </div>
          <label className="volume-control">
            <span>OUTPUT LEVEL</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              aria-label="Radio volume"
            />
            <output>{Math.round(volume * 100)}%</output>
          </label>
          <section className="audio-inspector" aria-label="Current track technical information">
            <div className="audio-inspector-title">AUDIO_STREAM // NODE_00412</div>
            <div className={`audio-inspector-grid ${technical ? "is-ready" : "is-reading"}`}>
              <div>
                <TelemetryRow label="FORMAT" value={metadataValue((item) => item.format)} /><TelemetryRow label="VERSION" value={metadataValue((item) => item.version)} />
                <TelemetryRow label="LAYER" value={metadataValue((item) => item.layer)} /><TelemetryRow label="MODE" value={metadataValue((item) => item.mode)} />
                <TelemetryRow label="CHANNELS" value={metadataValue((item) => pad(item.channels))} />
              </div>
              <div>
                <TelemetryRow label="FREQ" value={metadataValue((item) => `${(item.frequency / 1000).toFixed(3)} KHZ`)} />
                <TelemetryRow label="BITRATE" value={metadataValue((item) => `${(item.bitrate / 1000).toFixed(3)} KBPS`)} />
                <TelemetryRow label="RATE_MODE" value={metadataValue((item) => item.rateMode)} />
                <TelemetryRow label="FRAME_RATE" value={metadataValue((item) => `${item.frameRate.toFixed(3)} FPS`)} />
                <TelemetryRow label="FRAME_COUNT" value={metadataValue((item) => pad(item.frameCount, 6))} />
                <TelemetryRow label="FRAME_SIZE" value={metadataValue((item) => `~${item.frameSize} B`)} />
                <TelemetryRow label="SAMPLES/FR" value={metadataValue((item) => pad(item.samplesPerFrame, 5))} />
                <TelemetryRow label="SAMPLES" value={metadataValue((item) => String(item.samples))} />
              </div>
              <div>
                <TelemetryRow label="PAD_FRAMES" value={metadataValue((item) => pad(item.padFrames, 5))} />
                <TelemetryRow label="PAD_RATIO" value={metadataValue((item) => `${item.padRatio.toFixed(3)}%`)} />
              </div>
              <div>
                <TelemetryRow label="DATA_OFFSET" value={metadataValue((item) => hex(item.dataOffset))} /><TelemetryRow label="DATA_LENGTH" value={metadataValue((item) => hex(item.dataLength))} />
                <TelemetryRow label="FILE_LENGTH" value={metadataValue((item) => hex(item.fileLength))} /><TelemetryRow label="FILE_SIZE" value={metadataValue((item) => `${item.fileSizeMb.toFixed(3)} MB`)} />
                <TelemetryRow label="ID3V1" value={metadataValue((item) => item.id3v1 ? "DETECTED" : "NOT_FOUND")} /><TelemetryRow label="ID3V2" value={metadataValue((item) => item.id3v2 ? "DETECTED" : "NOT_FOUND")} />
                <TelemetryRow label="XING" value={metadataValue((item) => item.xing ? "DETECTED" : "NOT_FOUND")} /><TelemetryRow label="VBRI" value={metadataValue((item) => item.vbri ? "DETECTED" : "NOT_FOUND")} />
                <TelemetryRow label="CRC32" value={metadataValue((item) => item.crc32)} /><TelemetryRow label="SHA1" value={metadataValue((item) => `${item.sha1.slice(0, 16)}...`)} />
                <TelemetryRow label="PLAY_TIME" value={metadataValue((item) => `${item.playTime.toFixed(3)} SEC`)} />
              </div>
            </div>
          </section>
          <div className="tiny-copy">
            DIRECT AUDIO PATH / RANDOM SEQUENCE / RANGE DELIVERY<br />
            {libraryError ? "BACKEND OFFLINE / RUN NPM RUN DEV." : "LOCAL LIBRARY ONLINE / CLICK DISC TO PLAY OR PAUSE."}
          </div>
        </aside>
      </section>

      <aside className="right-column" id="archive">
        <div className="column-head">
          <span>RECENT_TRANSMISSIONS</span><b>LOG / 05</b>
        </div>
        <div className="recent-list">
          {playedTracks.map((item, i) => (
            <div className="recent-item" key={item.id}>
              <span className="recent-no">0{i + 1}</span>
              <img src={apiUrl(item.coverUrl)} alt="" />
              <div>
                <time>{i === 0 ? "LAST PLAYED" : "HISTORY"}</time>
                <strong>{item.artist}</strong>
                <em>{item.title}</em>
              </div>
            </div>
          ))}
        </div>

        <div className="system-panel" id="schedule">
          <div className="system-title">STREAM.PROTOCOL</div>
          <div className="system-grid">
            <span>STATUS</span><b className={serverOnline ? "connection-online" : "connection-offline"}>{serverOnline ? "CONNECTED" : "OFFLINE"}</b>
            <span>ENDPOINT</span><b>{audioEndpoint}</b>
            <span>PROTOCOL</span><b>{audioProtocol}/1.1</b>
            <span>TRANSPORT</span><b>HTTP RANGE</b>
            <span>LATENCY</span><b>{serverLatency === null ? "--- MS" : `${pad(serverLatency, 3)} MS`}</b>
            <span>NETWORK</span><b>{serverOnline ? "ONLINE" : "NO LINK"}</b>
            <span>RANGE</span><b>BYTES ENABLED</b>
            <span>LAST_SYNC</span><b>{lastServerSync}</b>
            <span>STREAM</span><b>{buffering ? "BUFFERING" : isPlaying ? "RECEIVING" : "STANDBY"}</b>
            <span>CODEC</span><b>MP3</b>
            <span>HTTP_STATUS</span><b>{serverMetrics?.httpStatus || 200} {serverMetrics?.httpStatus === 206 ? "PARTIAL" : "OK"}</b>
            <span>BUFFER_AHEAD</span><b>{bufferAhead.toFixed(3)} SEC</b>
            <span>PACKETS_RX</span><b>{pad(serverMetrics?.packetsRx || 0, 6)}</b>
            <span>BYTES_RX</span><b>{hex(serverMetrics?.bytesRx || 0)}</b>
            <span>RECONNECTS</span><b>{pad(reconnects, 3)}</b>
            <span>JITTER</span><b>{pad(jitter, 3)} MS</b>
            <span>SERVER_UPTIME</span><b>{formatUptime(serverMetrics?.uptimeSeconds || 0)}</b>
            <span>OPEN_STREAMS</span><b>{pad(serverMetrics?.openStreams || 0)}</b>
            <span>MEM_RSS</span><b>{((serverMetrics?.memRss || 0) / 1_000_000).toFixed(1)} MB</b>
            <span>REQUEST_ID</span><b>{serverMetrics?.requestId || "RX-000000"}</b>
          </div>
        </div>

        <div className="barcode" aria-hidden="true"><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/><i/></div>
        <div className="column-foot">RX/02 // ARCHIVE INDEX // READ ONLY</div>
      </aside>

      <section className="bottom-data" id="about">
        <div className="data-a">
          <span>TRANSMISSION ENVIRONMENT</span>
          <b>METALHEART // 2002 EMULATION</b>
        </div>
        <div className="data-stream">
          01100101 10011100 00101001 // packet:48F1 // sync:001 // checksum:7AA4 // node-sequence 03.14.15
        </div>
        <div className="data-b">FREQ 44.100 / CYAN CHANNEL</div>
      </section>

      <footer id="contact" className="footer-strip">
        <span>NULLWAVE RADIO // TRANSMISSION INTERFACE</span>
        <span>VISUAL ASSETS: PIXABAY CONTENT LICENSE</span>
        <span>CONTACT // STUDIO@NULLWAVE.LOCAL</span>
      </footer>
    </main>
  );
}
