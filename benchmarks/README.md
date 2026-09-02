# Node.js vs Nim backend benchmark

Measured locally on 2026-09-01 against the same normalized library containing 278 tracks.

Two runs were made in opposite server order. The table contains the average of both runs.

| Test | Node.js req/s | Nim req/s | Node.js avg latency | Nim avg latency | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `/api/health` | 12935 | 13842 | 1.93 ms | 1.80 ms | Nim 7.0% more req/s |
| `/api/tracks` | 3780 | 8589 | 3.93 ms | 1.74 ms | Nim 2.27x more req/s |
| 64 KiB HTTP Range | 6919 | 6723 | 2.14 ms | 2.20 ms | Effectively tied; Node.js 2.9% more req/s |

Average Range throughput was 432.4 MiB/s for Node.js and 420.2 MiB/s for Nim. All 26,500 measured requests completed without errors.

Observed working set was approximately 62-68 MiB for Node.js and 7.3 MiB for Nim. Nim therefore used about 9 times less resident memory in this test. Process memory can vary between runs and should be treated as an observation rather than an exact invariant.

## Run again

Start Node.js on port 8787 and Nim on port 8789, then run:

```powershell
node benchmarks/compare-servers.mjs
$env:BENCH_REVERSE='1'
node benchmarks/compare-servers.mjs
```

The benchmark uses only Node.js built-ins and reuses HTTP connections, matching normal browser behaviour. Tests cover JSON health responses, the complete track catalogue, and 64 KiB Range streaming. FFmpeg cover extraction and metadata hashing are deliberately excluded because those primarily measure external processes and disk cache state.
