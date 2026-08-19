import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriCli = path.join(
  projectRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);
const args = process.argv.slice(2);

let executable = process.execPath;
let childArgs = [tauriCli, ...args];

// `--remote-write` belongs to the standalone backend rather than the Tauri
// CLI. Delegate the established command to the coordinated restart script so
// an existing listener is safely replaced and both backend and frontend are
// started with matching code.
if (args[0] === "dev") {
  const remoteWriteIndex = args.indexOf("--remote-write", 1);
  if (remoteWriteIndex !== -1) {
    executable = path.join(projectRoot, "scripts", "restart-dev.sh");
    childArgs = ["--remote-write"];
  }
}

const child = spawn(executable, childArgs, {
  cwd: projectRoot,
  stdio: "inherit",
});

const signalHandlers = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => child.kill(signal);
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

child.on("error", (error) => {
  console.error(`Tauri CLI를 실행하지 못했습니다: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    const handler = signalHandlers.get(signal);
    if (handler) {
      process.off(signal, handler);
    }
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
