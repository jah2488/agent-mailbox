// Process entry for the `mailbox` command (bin/mailbox).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";
import { depsFromEnv } from "./config.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await run(process.argv.slice(2), {
  deps: depsFromEnv(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  repoRoot,
});
