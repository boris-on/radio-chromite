import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const envFile = join(projectRoot, ".env");
if (existsSync(envFile)) loadEnvFile(envFile);

const executable = process.env.NIM_BIN_DIR
  ? join(process.env.NIM_BIN_DIR, process.platform === "win32" ? "nimble.exe" : "nimble")
  : process.platform === "win32" ? "nimble.exe" : "nimble";
const toolDirectories = [
  process.env.NIM_BIN_DIR,
  process.env.C_COMPILER_BIN_DIR,
  process.env.FFMPEG_BIN_DIR,
].filter(Boolean);
const childEnvironment = {
  ...process.env,
  PATH: [...toolDirectories, process.env.PATH || ""].filter(Boolean).join(delimiter),
};

const child = spawn(executable, ["run"], {
  cwd: join(projectRoot, "backend-nim"),
  env: childEnvironment,
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  console.error(`[backend] Could not start Nim: ${error.message}`);
  console.error("[backend] Add Nim to PATH or set NIM_BIN_DIR in the root .env file.");
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
