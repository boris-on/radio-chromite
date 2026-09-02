import { NextResponse } from "next/server";
import { resolve4 } from "node:dns/promises";
import { request } from "node:https";

export const runtime = "nodejs";

type RainViewerFrame = { time: number; path: string };
type RainViewerResponse = { host?: string; radar?: { past?: RainViewerFrame[] } };
const METADATA_URL = new URL("https://api.rainviewer.com/public/weather-maps.json");

function requestThroughIpv4Edge(): Promise<RainViewerResponse> {
  return resolve4(METADATA_URL.hostname).then((addresses) => new Promise((resolve, reject) => {
    const address = addresses[0];
    if (!address) return reject(new Error("RainViewer IPv4 address unavailable"));
    const requestOptions = {
      autoSelectFamily: false,
      headers: { "User-Agent": "RADIO-CHROMITE/1.0" },
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
    } satisfies Parameters<typeof request>[1] & { autoSelectFamily: boolean };
    const upstream = request(METADATA_URL, requestOptions, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`RainViewer returned ${response.statusCode}`));
        try { resolve(JSON.parse(body) as RainViewerResponse); }
        catch { reject(new Error("RainViewer returned invalid JSON")); }
      });
    });
    upstream.setTimeout(3_000, () => upstream.destroy(new Error("RainViewer timeout")));
    upstream.on("error", reject);
    upstream.end();
  }));
}

async function loadMetadata() {
  try {
    const response = await fetch(METADATA_URL, { cache: "no-store", signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`RainViewer returned ${response.status}`);
    return await response.json() as RainViewerResponse;
  } catch {
    try {
      return await requestThroughIpv4Edge();
    } catch {
      const relayUrl = `https://r.jina.ai/http://${METADATA_URL.hostname}${METADATA_URL.pathname}`;
      const response = await fetch(relayUrl, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`RainViewer relay returned ${response.status}`);
      const body = await response.text();
      const start = body.indexOf("{");
      const end = body.lastIndexOf("}");
      if (start < 0 || end <= start) throw new Error("RainViewer relay response is invalid");
      return JSON.parse(body.slice(start, end + 1)) as RainViewerResponse;
    }
  }
}

export async function GET() {
  try {
    const data = await loadMetadata();
    const frames = (data.radar?.past ?? []).filter((frame) => Number.isFinite(frame.time) && frame.path.startsWith("/"));
    if (!data.host?.startsWith("https://")) throw new Error("RainViewer host missing");
    return NextResponse.json({ host: data.host, frames }, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=300" },
    });
  } catch {
    return NextResponse.json({ error: "RainViewer metadata unavailable" }, { status: 502 });
  }
}
