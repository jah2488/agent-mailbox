import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SignedCert } from "./cert.ts";
import { writeJson } from "./home.ts";
import type { Identity, Peer } from "./identity.ts";
import { canonicalize } from "./canonical.ts";
import { DEFAULT_POLICY, isCommand, policyParses, signPolicy, verifyPolicy, type SignedPolicy } from "./policy.ts";
import { DEFAULT_RESPONDER, type ResponderConfig } from "./responder.ts";
import { readSettings, resolveFolder } from "./settings.ts";
import { homedir } from "node:os";
import sodium from "./sodium.ts";

// The daemon's files in the mailbox home. agent.json and policy.json are
// signed by the root, so anything that edits them on disk only gets them
// refused. policy-version is the highest policy version ever loaded: it is
// what stops an older, looser signed policy from being put back.

const CERT = "agent.json";
const POLICY_TEXT = "policy.cedar";
const POLICY = "policy.json";
const POLICY_FLOOR = "policy-version";
const RESPONDER = "responder.json";
const SINCE = "daemon-since";

export const shareDir = (dir: string) => join(dir, "share");

const readText = (path: string) => readFile(path, "utf8").catch(() => null);

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function readCert(dir: string): Promise<SignedCert | null> {
  return ((await readJson(join(dir, CERT))) as SignedCert | null | undefined) ?? null;
}

export const writeCert = (dir: string, cert: SignedCert) => writeJson(join(dir, CERT), cert);

const createOnce = (path: string, text: string) =>
  writeFile(path, text, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });

/** First-run scaffolding. Never overwrites what the owner already has. */
export async function initDaemonFiles(dir: string, now: Date): Promise<void> {
  await mkdir(join(shareDir(dir), "status"), { recursive: true, mode: 0o700 });
  await mkdir(join(shareDir(dir), "notes"), { recursive: true, mode: 0o700 });
  await createOnce(join(dir, POLICY_TEXT), DEFAULT_POLICY);
  // Asks received before the first setup were the owner's to see. Fixed once,
  // so a restarted daemon still owes everything that arrived after it.
  await createOnce(join(dir, SINCE), `${now.toISOString()}\n`);
}

export async function readSince(dir: string): Promise<string | null> {
  const text = (await readText(join(dir, SINCE)))?.trim() ?? "";
  return Number.isNaN(Date.parse(text)) ? null : text;
}

async function floorOf(dir: string): Promise<number> {
  const n = Number((await readText(join(dir, POLICY_FLOOR)))?.trim() ?? "0");
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

async function readSigned(dir: string): Promise<SignedPolicy | null> {
  const value = await readJson(join(dir, POLICY));
  const p = (value as SignedPolicy | null)?.p;
  return typeof p?.cedar === "string" && typeof (value as SignedPolicy).s === "string" ? (value as SignedPolicy) : null;
}

/** Signs policy.cedar as the next version. Needs the root key, so only the owner can run it. */
export async function signPolicyFile(dir: string, root: Identity, home: string = homedir()): Promise<{ readonly ok: true; readonly version: number } | { readonly ok: false; readonly error: string }> {
  const text = await readText(join(dir, POLICY_TEXT));
  if (text === null) return { ok: false, error: `no ${POLICY_TEXT}; run: mailbox daemon setup` };
  if (!policyParses(text)) return { ok: false, error: `${POLICY_TEXT} does not parse as Cedar; nothing was signed` };
  const responder = await readResponderFile(dir);
  if (!responder.ok) return responder;
  // The folders are signed with the rules, so the daemon reads only what the owner approved.
  const settings = await readSettings(dir, home);
  if (!settings.ok) return { ok: false, error: `config.toml has errors, so nothing was signed: ${settings.errors.join("; ")}` };
  const listed = settings.settings.share.folders;
  const folders = listed === null ? undefined : Object.fromEntries(Object.entries(listed).map(([name, path]) => [name, resolveFolder(path, home)]));
  const version = Math.max((await readSigned(dir))?.p.version ?? 0, await floorOf(dir)) + 1;
  await writeJson(join(dir, POLICY), signPolicy(root, version, text, responder.command, folders));
  return { ok: true, version };
}

/** A verified policy, with the hash every decision records so a later reader knows exactly which rules applied. */
export type LoadedPolicy =
  | { readonly ok: true; readonly cedar: string; readonly version: number; readonly responder: ResponderConfig; readonly hash: string; readonly folders?: Readonly<Record<string, string>> | null }
  | { readonly ok: false; readonly error: string };

const policyHash = (signed: SignedPolicy) => "b2:" + sodium.to_hex(sodium.crypto_generichash(32, new TextEncoder().encode(canonicalize(signed.p))));

/** The verified policy text, raising the floor when a newer version appears. */
export async function loadPolicy(dir: string, root: Peer): Promise<LoadedPolicy> {
  const signed = await readSigned(dir);
  if (signed === null) return { ok: false, error: "no signed policy; run: mailbox policy sign" };
  const floor = await floorOf(dir);
  const verified = verifyPolicy(signed, root, floor);
  if (!verified.ok) return verified;
  if (verified.version > floor) await writeFile(join(dir, POLICY_FLOOR), `${verified.version}\n`, { mode: 0o600 });
  const responder = verified.responder === null ? DEFAULT_RESPONDER : { command: verified.responder };
  return { ok: true, cedar: verified.cedar, version: verified.version, responder, hash: policyHash(signed), folders: verified.folders };
}

/** The owner's responder.json, read only when signing. The daemon itself only ever sees the signed copy. */
async function readResponderFile(dir: string): Promise<{ readonly ok: true; readonly command?: readonly string[] } | { readonly ok: false; readonly error: string }> {
  const value = await readJson(join(dir, RESPONDER));
  if (value === null) return { ok: true };
  const command = (value as { command?: unknown } | undefined)?.command;
  return isCommand(command) ? { ok: true, command } : { ok: false, error: `${RESPONDER} must be {"command": ["program", "arg", ...]}; nothing was signed` };
}

const LOCK = "daemon.lock";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * One daemon per mailbox home: two would answer the same ask twice and
 * interleave the audit chain. Returns a release function, or null when a
 * live daemon holds the lock. A lock whose process has died is taken over.
 */
export async function acquireDaemonLock(dir: string): Promise<(() => Promise<void>) | null> {
  const path = join(dir, LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return () => rm(path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number((await readText(path))?.trim());
      if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) return null;
      await rm(path, { force: true });
    }
  }
  return null;
}
