import { mkdir, open, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pid } from "./identity.ts";
import { emptyState, type MailboxState } from "./mailbox.ts";
import { parseRoster, rosterEntry, type Contact } from "./roster.ts";

// ~/.agent-mailbox, the one module that knows the on-disk formats:
//   me.json      my public roster entry (name, keys, home relay)
//   roster.json  everyone else I trust, as roster entries
//   state.json   my MailboxState (chains, outbox, inbox)
//   lock         held by whichever process is writing state
// Secret keys are never here; they live in the KeyStore.

export type Home = { readonly me: Contact; readonly contacts: ReadonlyMap<Pid, Contact>; readonly state: MailboxState };

const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

const file = (dir: string, name: string) => join(dir, name);

export async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function contactsOrThrow(json: string, what: string): ReadonlyMap<Pid, Contact> {
  const parsed = parseRoster(json);
  if (!parsed.ok) throw new Error(`${what}: ${parsed.error}`);
  return parsed.contacts;
}

export async function initHome(dir: string, me: Contact): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (await exists(file(dir, "me.json"))) throw new Error(`${dir} is already initialised`);
  await writeJson(file(dir, "roster.json"), []);
  await writeJson(file(dir, "state.json"), emptyState);
  // me.json last: its presence is what marks the home as initialised.
  await writeJson(file(dir, "me.json"), rosterEntry(me));
}

async function readPeers(dir: string): Promise<readonly unknown[]> {
  return JSON.parse(await readFile(file(dir, "roster.json"), "utf8")) as unknown[];
}

export async function readHome(dir: string): Promise<Home> {
  const meEntry = await readFile(file(dir, "me.json"), "utf8");
  const me = [...contactsOrThrow(`[${meEntry}]`, "me.json").values()][0];
  if (me === undefined) throw new Error("me.json is empty");
  // Validating me together with the peers catches a peer who shares my name.
  const contacts = contactsOrThrow(JSON.stringify([JSON.parse(meEntry), ...(await readPeers(dir)).filter((e) => (e as { pid?: string }).pid !== me.pid)]), "roster.json");
  const state = JSON.parse(await readFile(file(dir, "state.json"), "utf8")) as MailboxState;
  return { me, contacts, state };
}

/** Adds or replaces (by pid) one contact. Refuses anything that would make the roster invalid. */
export async function addContact(dir: string, c: Contact): Promise<void> {
  const meEntry = JSON.parse(await readFile(file(dir, "me.json"), "utf8")) as unknown;
  const peers = (await readPeers(dir)).filter((e) => (e as { pid?: string }).pid !== c.pid);
  const next = [...peers, rosterEntry(c)];
  contactsOrThrow(JSON.stringify([meEntry, ...next]), "roster");
  await writeJson(file(dir, "roster.json"), next);
}

export async function writeState(dir: string, state: MailboxState): Promise<void> {
  await writeJson(file(dir, "state.json"), state);
}

/**
 * Runs fn while holding the home lock. One writer at a time across processes
 * (MCP server, CLI).
 *
 * The lock is a numbered file, lock.N, and the highest N present is the
 * holder. A live holder refreshes its file's mtime every heartbeat, so it is
 * never stale. To take over a dead holder's stale lock.N, a waiter creates
 * lock.N+1 with O_EXCL, so exactly one waiter wins each number. Every new
 * holder then lists again and backs off if a higher number exists; that
 * catches a waiter that acted on an out-of-date listing. Stale files below the
 * holder are swept.
 */
export type LockTiming = { readonly staleMs?: number; readonly heartbeatMs?: number };

const HEARTBEAT_MS = 5_000;
const LOCK_FILE = /^lock\.(\d+)$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ageOf = async (path: string) => Date.now() - (await stat(path)).mtimeMs;

async function lockNumbers(dir: string): Promise<number[]> {
  return (await readdir(dir)).flatMap((name) => {
    const match = LOCK_FILE.exec(name);
    return match ? [Number(match[1])] : [];
  });
}

async function tryCreate(path: string): Promise<boolean> {
  try {
    const handle = await open(path, "wx");
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

async function acquire(dir: string, staleMs: number): Promise<number> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const numbers = await lockNumbers(dir);
    const top = numbers.length === 0 ? -1 : Math.max(...numbers);
    const free = top === -1 || (await ageOf(file(dir, `lock.${top}`)).catch(() => Infinity)) > staleMs;
    if (free && (await tryCreate(file(dir, `lock.${top + 1}`)))) {
      const mine = top + 1;
      const now = await lockNumbers(dir);
      if (Math.max(...now) === mine) {
        await Promise.all(now.filter((n) => n < mine).map((n) => unlink(file(dir, `lock.${n}`)).catch(() => undefined)));
        return mine;
      }
      await unlink(file(dir, `lock.${mine}`)).catch(() => undefined); // A higher holder exists: back off.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for the lock in ${dir}`);
    await sleep(25);
  }
}

export async function withLock<T>(dir: string, fn: () => Promise<T>, timing: LockTiming = {}): Promise<T> {
  const lock = file(dir, `lock.${await acquire(dir, timing.staleMs ?? STALE_LOCK_MS)}`);
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lock, now, now).catch(() => undefined);
  }, timing.heartbeatMs ?? HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    await unlink(lock).catch(() => undefined);
  }
}
