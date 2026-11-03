import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SignedCert } from "./cert.ts";
import { writeJson } from "./home.ts";
import type { Identity, Peer } from "./identity.ts";
import { DEFAULT_POLICY, policyParses, signPolicy, verifyPolicy, type SignedPolicy } from "./policy.ts";
import { DEFAULT_RESPONDER, type ResponderConfig } from "./responder.ts";

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
export async function signPolicyFile(dir: string, root: Identity): Promise<{ readonly ok: true; readonly version: number } | { readonly ok: false; readonly error: string }> {
  const text = await readText(join(dir, POLICY_TEXT));
  if (text === null) return { ok: false, error: `no ${POLICY_TEXT}; run: mailbox daemon setup` };
  if (!policyParses(text)) return { ok: false, error: `${POLICY_TEXT} does not parse as Cedar; nothing was signed` };
  const version = Math.max((await readSigned(dir))?.p.version ?? 0, await floorOf(dir)) + 1;
  await writeJson(join(dir, POLICY), signPolicy(root, version, text));
  return { ok: true, version };
}

/** The verified policy text, raising the floor when a newer version appears. */
export async function loadPolicy(dir: string, root: Peer): Promise<{ readonly ok: true; readonly cedar: string; readonly version: number } | { readonly ok: false; readonly error: string }> {
  const signed = await readSigned(dir);
  if (signed === null) return { ok: false, error: "no signed policy; run: mailbox policy sign" };
  const floor = await floorOf(dir);
  const verified = verifyPolicy(signed, root, floor);
  if (verified.ok && verified.version > floor) await writeFile(join(dir, POLICY_FLOOR), `${verified.version}\n`, { mode: 0o600 });
  return verified;
}

/** The responder command: responder.json when present, otherwise the locked-down `claude -p`. */
export async function readResponder(dir: string): Promise<ResponderConfig> {
  const value = await readJson(join(dir, RESPONDER));
  if (value === null) return DEFAULT_RESPONDER;
  const command = (value as { command?: unknown } | undefined)?.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string")) {
    throw new Error(`${RESPONDER} must be {"command": ["program", "arg", ...]}`);
  }
  return { command };
}
