// Process entry for the `mailbox` command (bin/mailbox).
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";
import { agentKeysFromEnv, depsFromEnv } from "./config.ts";

/** One question at the terminal. No terminal, or Ctrl-D, is null, which the wizard turns into "pass the flag". */
async function ask(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
  try {
    return await Promise.race([rl.question(question), closed]);
  } finally {
    rl.close();
  }
}

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
  claudeSettings: join(homedir(), ".claude", "settings.json"),
  ask,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  repoRoot,
});
