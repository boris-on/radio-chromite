"use client";

import { useEffect, useRef, type RefObject } from "react";

type SignalSpectrumProps = {
  audioRef: RefObject<HTMLAudioElement | null>;
};

type AudioGraph = {
  context: AudioContext;
  analyser: AnalyserNode;
  source: MediaElementAudioSourceNode;
  scratchTrackUrl?: string;
  scratchTrackReady?: boolean;
  scratchTrackDuration?: number;
  scratchTrackPromise?: Promise<boolean>;
  scratchNode?: AudioWorkletNode;
  scratchGain?: GainNode;
  scratchWorkletPromise?: Promise<AudioWorkletNode | undefined>;
  scratchRequestedActive?: boolean;
  scratchRequestedPosition?: number;
};

const audioGraphProperty = "__radioChromiteAudioGraph" as const;
type SpectrumAudioElement = HTMLAudioElement & {
  [audioGraphProperty]?: AudioGraph;
};

function getAudioGraph(audio: SpectrumAudioElement): AudioGraph {
  const existing = audio[audioGraphProperty];
  if (existing) return existing;

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  const source = context.createMediaElementSource(audio);
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  analyser.minDecibels = -90;
  analyser.maxDecibels = -20;
  source.connect(analyser);
  analyser.connect(context.destination);

  const graph = { context, analyser, source };
  Object.defineProperty(audio, audioGraphProperty, { value: graph });
  return graph;
}

async function ensureScratchNode(graph: AudioGraph) {
  if (graph.scratchNode) return graph.scratchNode;
  if (graph.scratchWorkletPromise) return graph.scratchWorkletPromise;
  if (!graph.context.audioWorklet) return undefined;

  graph.scratchWorkletPromise = graph.context.audioWorklet.addModule("/scratch-processor.js")
    .then(() => {
      const node = new AudioWorkletNode(graph.context, "radio-scratch-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const gain = graph.context.createGain();
      gain.gain.value = 0.9;
      node.connect(gain).connect(graph.context.destination);
      graph.scratchNode = node;
      graph.scratchGain = gain;
      return node;
    })
    .catch(() => undefined)
    .finally(() => { graph.scratchWorkletPromise = undefined; });
  return graph.scratchWorkletPromise;
}

export function prepareScratchTrack(audio: HTMLAudioElement): Promise<boolean> {
  const graph = getAudioGraph(audio as SpectrumAudioElement);
  const url = audio.currentSrc || audio.src;
  if (!url) return Promise.resolve(false);
  if (graph.scratchTrackUrl === url && graph.scratchTrackReady) return Promise.resolve(true);
  if (graph.scratchTrackUrl === url && graph.scratchTrackPromise) return graph.scratchTrackPromise;

  graph.scratchTrackUrl = url;
  graph.scratchTrackReady = false;
  const pending = fetch(url, { cache: "force-cache" })
    .then((response) => {
      if (!response.ok) throw new Error("Scratch audio unavailable");
      return response.arrayBuffer();
    })
    .then((encoded) => graph.context.decodeAudioData(encoded))
    .then(async (decoded) => {
      const node = await ensureScratchNode(graph);
      if (!node || graph.scratchTrackUrl !== url) return false;
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) =>
        new Float32Array(decoded.getChannelData(index))
      );
      node.port.postMessage({
        type: "buffer",
        channels,
        sampleRate: decoded.sampleRate,
      }, channels.map((channel) => channel.buffer));
      graph.scratchTrackDuration = decoded.duration;
      graph.scratchTrackReady = true;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      if (graph.scratchTrackUrl === url) graph.scratchTrackPromise = undefined;
    });
  graph.scratchTrackPromise = pending;
  return pending;
}

export function beginScratchPlayback(audio: HTMLAudioElement, position: number) {
  const graph = getAudioGraph(audio as SpectrumAudioElement);
  graph.scratchRequestedActive = true;
  graph.scratchRequestedPosition = position;
  if (graph.context.state === "suspended") void graph.context.resume().catch(() => undefined);
  const activate = () => {
    if (!graph.scratchRequestedActive || !graph.scratchNode || graph.scratchTrackUrl !== (audio.currentSrc || audio.src)) return;
    graph.scratchGain!.gain.value = Math.max(0.08, audio.volume);
    graph.scratchNode.port.postMessage({ type: "seek", time: graph.scratchRequestedPosition ?? position });
    graph.scratchNode.port.postMessage({ type: "active", value: true });
  };
  if (graph.scratchTrackReady) activate();
  else void prepareScratchTrack(audio).then((ready) => { if (ready) activate(); });
}

export function setScratchSpeed(audio: HTMLAudioElement, speed: number) {
  const graph = getAudioGraph(audio as SpectrumAudioElement);
  const parameter = graph.scratchNode?.parameters.get("speed");
  if (!parameter) return;
  const now = graph.context.currentTime;
  const limitedSpeed = Math.min(12, Math.max(-12, speed));
  parameter.cancelScheduledValues(now);
  parameter.setValueAtTime(parameter.value, now);
  parameter.linearRampToValueAtTime(limitedSpeed, now + 0.012);
  parameter.setTargetAtTime(0, now + 0.028, 0.032);
}

export function endScratchPlayback(audio: HTMLAudioElement) {
  const graph = getAudioGraph(audio as SpectrumAudioElement);
  graph.scratchRequestedActive = false;
  const parameter = graph.scratchNode?.parameters.get("speed");
  if (parameter) {
    const now = graph.context.currentTime;
    parameter.cancelScheduledValues(now);
    parameter.setTargetAtTime(0, now, 0.012);
  }
  graph.scratchNode?.port.postMessage({ type: "active", value: false });
}

export default function SignalSpectrum({ audioRef }: SignalSpectrumProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const audio = audioRef.current as SpectrumAudioElement | null;
    const canvas = canvasRef.current;
    if (!audio || !canvas) return;

    const { context, analyser } = getAudioGraph(audio);
    const frequencyData = new Uint8Array(analyser.frequencyBinCount);
    const drawingContext = canvas.getContext("2d");
    if (!drawingContext) return;

    let frameId = 0;
    let width = 1;
    let height = 1;

    const resizeCanvas = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      const bitmapWidth = Math.max(1, Math.round(width * pixelRatio));
      const bitmapHeight = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
        canvas.width = bitmapWidth;
        canvas.height = bitmapHeight;
      }
      drawingContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const draw = () => {
      analyser.getByteFrequencyData(frequencyData);
      drawingContext.clearRect(0, 0, width, height);

      const baseline = height - 2.5;
      drawingContext.beginPath();
      drawingContext.moveTo(0, baseline);
      drawingContext.lineTo(width, baseline);
      drawingContext.strokeStyle = "rgba(104, 160, 180, 0.14)";
      drawingContext.lineWidth = 1;
      drawingContext.stroke();

      const sampleRate = context.sampleRate;
      const minFrequency = 20;
      const maxFrequency = Math.min(20_000, sampleRate / 2);
      const frequencyRange = maxFrequency / minFrequency;
      const traceHeight = Math.max(1, height - 7);

      drawingContext.beginPath();
      for (let x = 0; x <= width; x += 1) {
        const position = width > 1 ? x / width : 0;
        const frequency = minFrequency * Math.pow(frequencyRange, position);
        const binPosition = frequency * analyser.fftSize / sampleRate;
        const lowerBin = Math.min(frequencyData.length - 1, Math.floor(binPosition));
        const upperBin = Math.min(frequencyData.length - 1, lowerBin + 1);
        const blend = binPosition - lowerBin;
        const magnitude = frequencyData[lowerBin] * (1 - blend) + frequencyData[upperBin] * blend;
        const y = baseline - magnitude / 255 * traceHeight;
        if (x === 0) drawingContext.moveTo(x, y);
        else drawingContext.lineTo(x, y);
      }
      drawingContext.strokeStyle = "rgba(126, 181, 198, 0.78)";
      drawingContext.lineWidth = 1;
      drawingContext.lineJoin = "round";
      drawingContext.stroke();

      frameId = window.requestAnimationFrame(draw);
    };

    const resumeAudioContext = () => {
      if (context.state === "suspended") void context.resume().catch(() => undefined);
    };
    const prepareCurrentTrack = () => { void prepareScratchTrack(audio); };

    const resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);
    resizeCanvas();
    audio.addEventListener("play", resumeAudioContext);
    audio.addEventListener("loadedmetadata", prepareCurrentTrack);
    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) prepareCurrentTrack();
    window.addEventListener("pointerdown", resumeAudioContext, { passive: true });
    window.addEventListener("keydown", resumeAudioContext);
    frameId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      audio.removeEventListener("play", resumeAudioContext);
      audio.removeEventListener("loadedmetadata", prepareCurrentTrack);
      window.removeEventListener("pointerdown", resumeAudioContext);
      window.removeEventListener("keydown", resumeAudioContext);
    };
  }, [audioRef]);

  return <canvas ref={canvasRef} className="signal-spectrum" aria-hidden="true" />;
}
