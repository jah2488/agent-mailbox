// Claude Code UserPromptSubmit hook. Whatever it prints joins the prompt's
// context, so it prints a line when mail is waiting and, once a day, when a
// newer version is out or the daemon cert is running out; otherwise nothing.
// It must never slow down or fail a prompt: every error is swallowed, every
// check is throttled, and together they are capped at CHECK_TIMEOUT_MS.
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkInbox } from "./client.ts";
import { depsFromEnv, isDevCheckout } from "./config.ts";
import { certNotice, inboxNotice, shouldCheck, updateDue, updateNotice } from "./hook-core.ts";

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

/** Once a day. Reads agent.json directly: importing the daemon's modules would load Cedar on every prompt. */
async function cert(dir: string, now: Date): Promise<string | null> {
  const cache = join(dir, "cert-check.json");
  if (!updateDue(await readDate(cache, "checkedAt"), now)) return null;
  const expires = await readFile(join(dir, "agent.json"), "utf8")
    .then((raw) => (JSON.parse(raw) as { c?: { expires?: unknown } }).c?.expires)
    .catch(() => undefined);
  const pid = await readFile(join(dir, "me.json"), "utf8")
    .then((raw) => (JSON.parse(raw) as { pid?: unknown }).pid)
    .catch(() => undefined);
  const daemonOn = typeof pid === "string" && (await access(join(homedir(), "Library", "LaunchAgents", `com.agent-mailbox.daemon.${pid}.plist`)).then(() => true, () => false));
  const notice = certNotice(typeof expires === "string" ? expires : null, daemonOn, now);
  // Only a shown warning starts the daily quiet period, so a cert that enters its last week is mentioned the same day.
  if (notice !== null) await writeFile(cache, JSON.stringify({ checkedAt: now.toISOString() }));
  return notice;
}

async function main(): Promise<void> {
  const deps = depsFromEnv();
  const now = deps.now();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), CHECK_TIMEOUT_MS).unref());
  const settle = (p: Promise<string | null>) => Promise.race([p.catch(() => null), timeout]);
  const notices = await Promise.all([settle(inbox(deps, now)), settle(update(deps.dir, now)), settle(cert(deps.dir, now))]);
  for (const notice of notices) if (notice !== null) process.stdout.write(`${notice}\n`);
}

await main().catch(() => undefined);
process.exit(0);
