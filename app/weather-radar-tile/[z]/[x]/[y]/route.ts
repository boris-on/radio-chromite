import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validCoordinate(value: string) {
  return /^\d+$/.test(value);
}

async function fetchImage(url: string, signal: AbortSignal) {
  const response = await fetch(url, { cache: "force-cache", signal });
  if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("image/")) {
    throw new Error(`Radar tile returned ${response.status}`);
  }
  return response;
}

export async function GET(request: Request, context: { params: Promise<{ z: string; x: string; y: string }> }) {
  try {
    const { z, x, y } = await context.params;
    if (![z, x, y].every(validCoordinate)) return new NextResponse("Invalid tile", { status: 400 });
    const query = new URL(request.url).searchParams;
    const host = new URL(query.get("host") ?? "");
    const framePath = query.get("path") ?? "";
    if (host.protocol !== "https:" || !host.hostname.endsWith(".rainviewer.com") || !/^\/v2\/radar\/[a-zA-Z0-9_-]+$/.test(framePath)) {
      return new NextResponse("Invalid RainViewer source", { status: 400 });
    }

    const tileUrl = `${host.origin}${framePath}/256/${z}/${x}/${y}/2/1_1.png`;
    const relayUrl = `https://wsrv.nl/?url=${encodeURIComponent(tileUrl)}&output=png`;
    const directController = new AbortController();
    const relayController = new AbortController();
    const response = await Promise.any([
      fetchImage(tileUrl, directController.signal),
      fetchImage(relayUrl, relayController.signal),
    ]);
    const data = await response.arrayBuffer();
    directController.abort();
    relayController.abort();
    return new NextResponse(data, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
      },
    });
  } catch {
    return new NextResponse("Radar tile unavailable", { status: 502 });
  }
}
