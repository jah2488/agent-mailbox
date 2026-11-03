// Process entry for the `mailbox` command (bin/mailbox).
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { createInterface, type Interface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";
import { agentKeysFromEnv, depsFromEnv } from "./config.ts";

// One terminal reader for the whole command, so lines typed or pasted ahead
// of a question queue for it instead of being swallowed by the one before.
let terminal: { readonly rl: Interface; readonly lines: AsyncIterator<string> } | null = null;

/** One question at the terminal. No terminal, or Ctrl-D, is null, which the wizard turns into "pass the flag". */
async function ask(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  if (terminal === null) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => process.exit(130)); // readline captures Ctrl-C; honour it as a cancel
    terminal = { rl, lines: rl[Symbol.asyncIterator]() };
  }
  terminal.rl.setPrompt(question);
  terminal.rl.prompt();
  const next = await terminal.lines.next();
  return next.done === true ? null : next.value;
}

/** An open reader would keep the process alive after the command is done. */
const closeTerminal = () => terminal?.rl.close();

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
  color: process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  repoRoot,
});
closeTerminal();
