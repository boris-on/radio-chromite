export type DynamicPalette = {
  rgb: string;
  accent: string;
  bright: string;
  muted: string;
  faint: string;
  border: string;
  glow: string;
  surface: string;
};

export const defaultDynamicPalette: DynamicPalette = {
  rgb: "108, 176, 198",
  accent: "hsl(192 45% 60%)",
  bright: "hsl(190 55% 72%)",
  muted: "rgba(83, 145, 166, .48)",
  faint: "rgba(67, 134, 156, .12)",
  border: "rgba(108, 176, 198, .46)",
  glow: "rgba(108, 196, 218, .2)",
  surface: "rgba(18, 54, 69, .62)",
};

const paletteCache = new Map<string, DynamicPalette>();
const pendingExtractions = new Map<string, Promise<DynamicPalette>>();

function rgbToHsl(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  let hue = 0;

  if (delta > 0) {
    if (maximum === r) hue = ((g - b) / delta) % 6;
    else if (maximum === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }

  const lightness = (maximum + minimum) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return { hue, saturation, lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const x = chroma * (1 - Math.abs(sector % 2 - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (sector < 1) [r, g] = [chroma, x];
  else if (sector < 2) [r, g] = [x, chroma];
  else if (sector < 3) [g, b] = [chroma, x];
  else if (sector < 4) [g, b] = [x, chroma];
  else if (sector < 5) [r, b] = [x, chroma];
  else [r, b] = [chroma, x];
  const match = lightness - chroma / 2;
  return [r, g, b].map((channel) => Math.round((channel + match) * 255));
}

function paletteFromHue(hue: number): DynamicPalette {
  const normalizedHue = Math.round(hue);
  const [red, green, blue] = hslToRgb(normalizedHue, 0.58, 0.56);
  return {
    rgb: `${red}, ${green}, ${blue}`,
    accent: `hsl(${normalizedHue} 58% 56%)`,
    bright: `hsl(${normalizedHue} 64% 68%)`,
    muted: `hsla(${normalizedHue} 46% 48% / .48)`,
    faint: `hsla(${normalizedHue} 52% 46% / .12)`,
    border: `hsla(${normalizedHue} 58% 64% / .42)`,
    glow: `hsla(${normalizedHue} 64% 62% / .2)`,
    surface: `hsla(${normalizedHue} 42% 20% / .62)`,
  };
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Artwork could not be loaded"));
    image.src = source;
  });
}

async function analyzeArtwork(source: string): Promise<DynamicPalette> {
  try {
    const image = await loadImage(source);
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return defaultDynamicPalette;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const bins = Array.from({ length: 24 }, () => ({ weight: 0, sin: 0, cos: 0, pixels: 0 }));
    let totalWeight = 0;

    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 160) continue;
      const color = rgbToHsl(pixels[index], pixels[index + 1], pixels[index + 2]);
      if (color.lightness < 0.08 || color.lightness > 0.92 || color.saturation < 0.2) continue;
      const visibility = 1 - Math.abs(color.lightness - 0.5) * 1.35;
      const weight = Math.pow(color.saturation, 1.45) * Math.max(0.15, visibility);
      const bin = bins[Math.floor(color.hue / 15) % bins.length];
      const radians = color.hue * Math.PI / 180;
      bin.weight += weight;
      bin.sin += Math.sin(radians) * weight;
      bin.cos += Math.cos(radians) * weight;
      bin.pixels += 1;
      totalWeight += weight;
    }

    const dominant = bins.reduce((best, candidate) => candidate.weight > best.weight ? candidate : best);
    const confidence = totalWeight > 0 ? dominant.weight / totalWeight : 0;
    if (dominant.pixels < 10 || dominant.weight < 4 || confidence < 0.16) return defaultDynamicPalette;
    const hue = (Math.atan2(dominant.sin, dominant.cos) * 180 / Math.PI + 360) % 360;
    return paletteFromHue(hue);
  } catch {
    return defaultDynamicPalette;
  }
}

export function extractArtworkColor(cacheKey: string, source: string): Promise<DynamicPalette> {
  const cached = paletteCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  const pending = pendingExtractions.get(cacheKey);
  if (pending) return pending;

  const extraction = analyzeArtwork(source).then((palette) => {
    paletteCache.set(cacheKey, palette);
    pendingExtractions.delete(cacheKey);
    return palette;
  });
  pendingExtractions.set(cacheKey, extraction);
  return extraction;
}
