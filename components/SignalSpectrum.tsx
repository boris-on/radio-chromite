"use client";

import { useEffect, useRef, type RefObject } from "react";

type SignalSpectrumProps = {
  audioRef: RefObject<HTMLAudioElement | null>;
};

type AudioGraph = {
  context: AudioContext;
  analyser: AnalyserNode;
  source: MediaElementAudioSourceNode;
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

    const resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);
    resizeCanvas();
    audio.addEventListener("play", resumeAudioContext);
    window.addEventListener("pointerdown", resumeAudioContext, { passive: true });
    window.addEventListener("keydown", resumeAudioContext);
    frameId = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      audio.removeEventListener("play", resumeAudioContext);
      window.removeEventListener("pointerdown", resumeAudioContext);
      window.removeEventListener("keydown", resumeAudioContext);
    };
  }, [audioRef]);

  return <canvas ref={canvasRef} className="signal-spectrum" aria-hidden="true" />;
}
