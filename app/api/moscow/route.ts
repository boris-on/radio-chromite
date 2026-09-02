import { NextResponse } from "next/server";
import { resolve4 } from "node:dns/promises";
import { request } from "node:https";

export const runtime = "nodejs";

const MOSCOW_LATITUDE = 55.7558;
const MOSCOW_LONGITUDE = 37.6176;

type OpenMeteoResponse = {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    pressure_msl?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    time?: string;
  };
  daily?: {
    sunrise?: string[];
    sunset?: string[];
    daylight_duration?: number[];
  };
};

function requestThroughOpenMeteoEdge(url: URL): Promise<OpenMeteoResponse> {
  return resolve4("open-meteo.com").then((addresses) => new Promise((resolve, reject) => {
    const edgeAddress = addresses[0];
    if (!edgeAddress) return reject(new Error("Open-Meteo edge address unavailable"));
    const requestOptions = {
      autoSelectFamily: false,
      headers: { "User-Agent": "RADIO-CHROMITE/1.0" },
      lookup: (_hostname, _options, callback) => callback(null, edgeAddress, 4),
    } satisfies Parameters<typeof request>[1] & { autoSelectFamily: boolean };
    const upstream = request(url, requestOptions, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Open-Meteo edge returned ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body) as OpenMeteoResponse); }
        catch { reject(new Error("Open-Meteo edge returned invalid JSON")); }
      });
    });
    upstream.setTimeout(8_000, () => upstream.destroy(new Error("Open-Meteo edge timeout")));
    upstream.on("error", reject);
    upstream.end();
  }));
}

async function loadOpenMeteo(url: URL): Promise<OpenMeteoResponse> {
  try {
    const response = await fetch(url, {
      next: { revalidate: 60 },
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
    return await response.json() as OpenMeteoResponse;
  } catch {
    return requestThroughOpenMeteoEdge(url);
  }
}

export async function GET() {
  const query = new URLSearchParams({
    latitude: String(MOSCOW_LATITUDE),
    longitude: String(MOSCOW_LONGITUDE),
    current: "temperature_2m,relative_humidity_2m,pressure_msl,wind_speed_10m,wind_direction_10m",
    daily: "sunrise,sunset,daylight_duration",
    timezone: "Europe/Moscow",
    wind_speed_unit: "ms",
    forecast_days: "1",
  });

  try {
    const data = await loadOpenMeteo(new URL(`https://api.open-meteo.com/v1/forecast?${query}`));
    const current = data.current;
    const sunrise = data.daily?.sunrise?.[0];
    const sunset = data.daily?.sunset?.[0];
    const daylightDuration = data.daily?.daylight_duration?.[0];
    if (!current || !sunrise || !sunset || daylightDuration === undefined) {
      throw new Error("Open-Meteo response is incomplete");
    }

    return NextResponse.json({
      temperature: current.temperature_2m,
      humidity: current.relative_humidity_2m,
      pressure: current.pressure_msl,
      windSpeed: current.wind_speed_10m,
      windDirection: current.wind_direction_10m,
      sunrise,
      sunset,
      daylightDuration,
      observedAt: current.time,
      source: "OPEN-METEO",
    }, {
      headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" },
    });
  } catch {
    return NextResponse.json({ error: "Moscow weather data unavailable" }, { status: 502 });
  }
}
