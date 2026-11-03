// Claude Code UserPromptSubmit hook. Whatever it prints joins the prompt's
// context, so it prints a line when mail is waiting (and, once a day, when a
// newer version is out) and nothing otherwise. It must never slow down or
// fail a prompt: every error is swallowed, both checks are throttled, and
// together they are capped at CHECK_TIMEOUT_MS.
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkInbox } from "./client.ts";
import { depsFromEnv, isDevCheckout } from "./config.ts";
import { inboxNotice, shouldCheck, updateDue, updateNotice } from "./hook-core.ts";

const CHECK_TIMEOUT_MS = 1_500;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readDate = (path: string, field: string) =>
  readFile(path, "utf8")
    .then((raw) => new Date((JSON.parse(raw) as Record<string, string>)[field] ?? ""))
    .catch(() => null);

const exec = (program: string, args: readonly string[]) =>
  new Promise<{ code: number; output: string }>((done) =>
    execFile(program, [...args], { timeout: CHECK_TIMEOUT_MS }, (error, stdout) => done({ code: error === null ? 0 : 1, output: stdout.trim() })),
  );

async function inbox(deps: ReturnType<typeof depsFromEnv>, now: Date): Promise<string | null> {
  const cache = join(deps.dir, "hook-cache.json");
  if (!shouldCheck(await readDate(cache, "checkedAt"), now)) return null;
  // Record the attempt first, so a slow or failing relay can't trigger a check on every prompt.
  await writeFile(cache, JSON.stringify({ checkedAt: now.toISOString() }));
  return inboxNotice(await checkInbox(deps));
}

async function update(dir: string, now: Date): Promise<string | null> {
  const cache = join(dir, "update-check.json");
  if (!updateDue(await readDate(cache, "checkedAt"), now) || (await isDevCheckout(root))) return null;
  await writeFile(cache, JSON.stringify({ checkedAt: now.toISOString() }));
  return updateNotice(exec, root);
}

async function main(): Promise<void> {
  const deps = depsFromEnv();
  const now = deps.now();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), CHECK_TIMEOUT_MS).unref());
  const settle = (p: Promise<string | null>) => Promise.race([p.catch(() => null), timeout]);
  const notices = await Promise.all([settle(inbox(deps, now)), settle(update(deps.dir, now))]);
  for (const notice of notices) if (notice !== null) process.stdout.write(`${notice}\n`);
}

await main().catch(() => undefined);
process.exit(0);
