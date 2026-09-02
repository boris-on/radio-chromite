import { Agent, request } from "node:http";
import { performance } from "node:perf_hooks";

const servers = [
  { name: "Node.js", origin: process.env.JS_SERVER_URL || "http://localhost:8787" },
  { name: "Nim", origin: process.env.NIM_SERVER_URL || "http://localhost:8789" },
];
if (process.env.BENCH_REVERSE === "1") servers.reverse();

const scenarios = [
  { name: "health", path: "/api/health", requests: 5000, concurrency: 25 },
  { name: "tracks", path: "/api/tracks", requests: 1500, concurrency: 15 },
  { name: "range-64k", path: ({ trackId }) => `/api/stream/${trackId}`, requests: 750, concurrency: 15, range: "bytes=0-65535" },
];

const keepAliveAgents = new Map();

function agentFor(origin) {
  if (!keepAliveAgents.has(origin)) {
    keepAliveAgents.set(origin, new Agent({ keepAlive: true, maxSockets: 64 }));
  }
  return keepAliveAgents.get(origin);
}

function fetchBuffer(url, range) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const started = performance.now();
    const req = request(target, {
      method: "GET",
      agent: agentFor(target.origin),
      headers: range ? { Range: range } : undefined,
    }, (response) => {
      let bytes = 0;
      response.on("data", (chunk) => { bytes += chunk.length; });
      response.on("end", () => resolve({
        status: response.statusCode,
        bytes,
        latency: performance.now() - started,
      }));
    });
    req.setTimeout(15_000, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] || 0;
}

async function runScenario(server, scenario, trackId) {
  const path = typeof scenario.path === "function" ? scenario.path({ trackId }) : scenario.path;
  const warmupCount = Math.min(50, scenario.requests);
  for (let index = 0; index < warmupCount; index++) {
    await fetchBuffer(server.origin + path, scenario.range);
  }

  const latencies = [];
  let completed = 0;
  let errors = 0;
  let bytes = 0;
  const started = performance.now();

  async function worker() {
    while (true) {
      const requestIndex = completed++;
      if (requestIndex >= scenario.requests) return;
      try {
        const result = await fetchBuffer(server.origin + path, scenario.range);
        const expectedStatus = scenario.range ? 206 : 200;
        if (result.status !== expectedStatus || (scenario.range && result.bytes !== 65536)) errors++;
        bytes += result.bytes;
        latencies.push(result.latency);
      } catch {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: scenario.concurrency }, worker));
  const elapsedSeconds = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    server: server.name,
    scenario: scenario.name,
    requests: scenario.requests,
    concurrency: scenario.concurrency,
    errors,
    rps: scenario.requests / elapsedSeconds,
    throughputMiBs: bytes / 1024 / 1024 / elapsedSeconds,
    averageMs: latencies.reduce((sum, value) => sum + value, 0) / Math.max(1, latencies.length),
    p50Ms: percentile(latencies, 0.50),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
  };
}

for (const server of servers) {
  const health = JSON.parse((await fetchBuffer(server.origin + "/api/health")).bytes ? await new Promise((resolve, reject) => {
    let body = "";
    const req = request(server.origin + "/api/health", { agent: agentFor(server.origin) }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  }) : "{}");
  if (!health.ok) throw new Error(`${server.name} health check failed`);
  const tracks = await new Promise((resolve, reject) => {
    let body = "";
    const req = request(server.origin + "/api/tracks", { agent: agentFor(server.origin) }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(JSON.parse(body)));
    });
    req.on("error", reject);
    req.end();
  });
  server.trackId = tracks[0]?.id;
  server.trackCount = tracks.length;
}

if (servers.some((server) => !server.trackId)) throw new Error("No tracks returned by a server");
if (new Set(servers.map((server) => server.trackCount)).size !== 1) throw new Error("Servers expose different track counts");

const results = [];
for (const scenario of scenarios) {
  for (const server of servers) {
    process.stdout.write(`Running ${server.name} / ${scenario.name}... `);
    const result = await runScenario(server, scenario, server.trackId);
    results.push(result);
    process.stdout.write("done\n");
  }
}

console.table(results.map((result) => ({
  server: result.server,
  test: result.scenario,
  requests: result.requests,
  concurrency: result.concurrency,
  errors: result.errors,
  "req/s": result.rps.toFixed(1),
  "MiB/s": result.throughputMiBs.toFixed(2),
  "avg ms": result.averageMs.toFixed(2),
  "p50 ms": result.p50Ms.toFixed(2),
  "p95 ms": result.p95Ms.toFixed(2),
  "p99 ms": result.p99Ms.toFixed(2),
})));

console.log("\nJSON_RESULTS=" + JSON.stringify(results));
for (const agent of keepAliveAgents.values()) agent.destroy();
