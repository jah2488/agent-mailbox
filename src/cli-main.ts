// Process entry for the `mailbox` command (bin/mailbox).
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";
import { agentKeysFromEnv, depsFromEnv } from "./config.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// launchd stops the daemon with SIGTERM; finishing the current tick first keeps the audit log whole.
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());

process.exitCode = await run(process.argv.slice(2), {
  deps: depsFromEnv(),
  agentKeys: agentKeysFromEnv(),
  env: process.env,
  stop: stop.signal,
  exec: (program, args) =>
    new Promise((done) => execFile(program, [...args], (error, stdout, stderr) => done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, output: `${stdout}${stderr}`.trim() }))),
  launchAgents: join(homedir(), "Library", "LaunchAgents"),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  repoRoot,
});
