import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import "./server.mjs";

const frontend = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)), "dev"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    frontend.kill(signal);
    process.exit(0);
  });
}

frontend.on("exit", (code) => process.exit(code ?? 0));
