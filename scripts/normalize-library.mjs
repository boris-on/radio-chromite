import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, extname, join, relative, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const envFile = join(projectRoot, ".env");
if (existsSync(envFile)) loadEnvFile(envFile);
if (process.env.FFMPEG_BIN_DIR) {
  process.env.PATH = [process.env.FFMPEG_BIN_DIR, process.env.PATH || ""].filter(Boolean).join(delimiter);
}

const sourceRoot = resolve(process.argv[2] || process.env.MUSIC_LIBRARY_PATH || join(projectRoot, "music"));
const outputRoot = resolve(process.argv[3] || process.env.NORMALIZED_LIBRARY_PATH || `${sourceRoot}-normalized`);
const TARGET_I = "-16";
const TARGET_TP = "-1.5";
const TARGET_LRA = "11";
const force = process.argv.includes("--force");
const completionMarker = join(outputRoot, ".normalization-complete");

if (!existsSync(sourceRoot)) throw new Error(`Music library not found: ${sourceRoot}`);
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true }).error) {
  throw new Error("FFmpeg is not installed or is not available in PATH.");
}

function collectMp3(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectMp3(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".mp3") files.push(path);
  }
  return files;
}

function runFfmpeg(args, captureStderr = false) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (captureStderr) stderr += chunk.toString();
      else process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stderr) : reject(new Error(`FFmpeg exited with code ${code}`)));
  });
}

function parseMeasurement(stderr) {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("FFmpeg did not return loudness measurements");
  return JSON.parse(stderr.slice(start, end + 1));
}

const files = collectMp3(sourceRoot);
console.log(`[normalize] ${files.length} MP3 files`);
console.log(`[normalize] source: ${sourceRoot}`);
console.log(`[normalize] output: ${outputRoot}`);

let completed = 0;
let skipped = 0;
let failed = 0;
rmSync(completionMarker, { force: true });

for (const input of files) {
  const output = join(outputRoot, relative(sourceRoot, input));
  if (existsSync(output) && !force) {
    skipped++;
    console.log(`[${completed + skipped}/${files.length}] skip ${relative(sourceRoot, input)}`);
    continue;
  }

  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.normalizing.mp3`;
  rmSync(temporary, { force: true });
  const nullOutput = process.platform === "win32" ? "NUL" : "/dev/null";

  try {
    const firstPass = await runFfmpeg([
      "-hide_banner", "-nostats", "-i", input,
      "-map", "0:a:0", "-af", `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}:print_format=json`,
      "-f", "null", nullOutput,
    ], true);
    const measured = parseMeasurement(firstPass);
    const filter = [
      `loudnorm=I=${TARGET_I}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`,
      `measured_I=${measured.input_i}`,
      `measured_TP=${measured.input_tp}`,
      `measured_LRA=${measured.input_lra}`,
      `measured_thresh=${measured.input_thresh}`,
      `offset=${measured.target_offset}`,
      "linear=true:print_format=summary",
    ].join(":");

    await runFfmpeg([
      "-hide_banner", "-nostats", "-y", "-i", input,
      "-map", "0:a:0", "-map", "0:v?", "-map_metadata", "0",
      "-af", filter, "-c:a", "libmp3lame", "-q:a", "2",
      "-c:v", "copy", "-id3v2_version", "3", temporary,
    ]);
    rmSync(output, { force: true });
    renameSync(temporary, output);
    completed++;
    console.log(`[${completed + skipped}/${files.length}] done ${relative(sourceRoot, input)}`);
  } catch (error) {
    failed++;
    rmSync(temporary, { force: true });
    console.error(`[failed] ${relative(sourceRoot, input)}: ${error.message}`);
  }
}

if (failed > 0) {
  console.error(`[normalize] incomplete: ${completed} written, ${skipped} skipped, ${failed} failed`);
  process.exitCode = 1;
} else {
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(completionMarker, new Date().toISOString());
  console.log(`[normalize] finished: ${completed} written, ${skipped} skipped`);
  console.log("The audio backend will detect the updated library automatically.");
}
