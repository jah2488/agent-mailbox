// Process entry for the `mailbox` command (bin/mailbox).
import { dirname, resolve } from "node:path";
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
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  repoRoot,
});
