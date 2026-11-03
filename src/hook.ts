// Claude Code UserPromptSubmit hook. Whatever it prints joins the prompt's
// context, so it prints one line when mail is waiting and nothing otherwise.
// It must never slow down or fail a prompt: every error is swallowed, and the
// relay check is throttled and capped at CHECK_TIMEOUT_MS.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkInbox } from "./client.ts";
import { depsFromEnv } from "./config.ts";
import { inboxNotice, shouldCheck } from "./hook-core.ts";

const CHECK_TIMEOUT_MS = 1_500;

async function main(): Promise<void> {
  const deps = depsFromEnv();
  const cache = join(deps.dir, "hook-cache.json");
  const last = await readFile(cache, "utf8")
    .then((raw) => new Date((JSON.parse(raw) as { checkedAt: string }).checkedAt))
    .catch(() => null);
  const now = deps.now();
  if (!shouldCheck(last, now)) return;
  // Record the attempt first, so a slow or failing relay can't trigger a check on every prompt.
  await writeFile(cache, JSON.stringify({ checkedAt: now.toISOString() }));
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), CHECK_TIMEOUT_MS).unref());
  const check = await Promise.race([checkInbox(deps), timeout]);
  const notice = check === null ? null : inboxNotice(check);
  if (notice !== null) process.stdout.write(`${notice}\n`);
}

await main().catch(() => undefined);
process.exit(0);
