import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalize, type Json } from "./canonical.ts";
import sodium from "./sodium.ts";

// The daemon's own record of everything it did, one JSON line per event.
// Each line names the hash of the line before it and is signed by the agent
// key, so an edit or a deletion in the middle shows up at a precise seq.
// A cut-off tail still verifies on its own; spec section 8's checkpoints to
// the relay are what catch that (not built in this slice).

export type AuditEvent = { readonly kind: string; readonly data: Json; readonly ts?: string };
export type AuditEntry = { readonly seq: number; readonly prev: string | null; readonly ts: string; readonly kind: string; readonly data: Json };

const AUDIT_DOMAIN = "agent-mailbox/v1/audit\n";
const FILE = "audit.jsonl";

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
const lineHash = (line: string) => "b2:" + sodium.to_hex(sodium.crypto_generichash(32, new TextEncoder().encode(line)));
const signedBytes = (entry: AuditEntry) => new TextEncoder().encode(AUDIT_DOMAIN + canonicalize(entry));

export function nextEntry(previousLine: string | null, signSec: Uint8Array, event: AuditEvent): string {
  const previousSeq = previousLine === null ? -1 : (JSON.parse(previousLine) as AuditEntry).seq;
  const entry: AuditEntry = {
    seq: previousSeq + 1,
    prev: previousLine === null ? null : lineHash(previousLine),
    ts: event.ts ?? new Date().toISOString(),
    kind: event.kind,
    data: event.data,
  };
  return canonicalize({ ...entry, sig: b64(sodium.crypto_sign_detached(signedBytes(entry), signSec)) });
}

export function verifyAudit(text: string, signPub: Uint8Array): { readonly ok: true; readonly entries: readonly AuditEntry[] } | { readonly ok: false; readonly seq: number; readonly reason: string } {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const entries: AuditEntry[] = [];
  for (const [index, line] of lines.entries()) {
    let parsed: AuditEntry & { readonly sig: string };
    try {
      parsed = JSON.parse(line) as AuditEntry & { readonly sig: string };
    } catch {
      return { ok: false, seq: index, reason: "not JSON" };
    }
    const { sig, ...entry } = parsed;
    if (entry.seq !== index) return { ok: false, seq: index, reason: "out of sequence" };
    if (entry.prev !== (index === 0 ? null : lineHash(lines[index - 1]!))) return { ok: false, seq: index, reason: "chain broken" };
    try {
      if (!sodium.crypto_sign_verify_detached(unb64(sig), signedBytes(entry), signPub)) return { ok: false, seq: index, reason: "bad signature" };
    } catch {
      return { ok: false, seq: index, reason: "bad signature" };
    }
    entries.push(entry);
  }
  return { ok: true, entries };
}

/** Appends one signed entry. The daemon is the only regular writer. */
export async function appendAudit(dir: string, signSec: Uint8Array, event: AuditEvent): Promise<void> {
  const path = join(dir, FILE);
  const existing = await readFile(path, "utf8").catch(() => "");
  const last = existing.split("\n").filter((line) => line.length > 0).at(-1) ?? null;
  await appendFile(path, nextEntry(last, signSec, event) + "\n", { mode: 0o600 });
}
