import { pidOf, type Peer, type Pid } from "./identity.ts";
import sodium from "./sodium.ts";

/** One allowlisted person as it travels in config (MAILBOX_ROOTS) and in rosters. */
export type RootEntry = { readonly pid: string; readonly sign_pub: string; readonly box_pub: string };

const KEY_BYTES = 32;
const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

export function rootEntry(peer: Peer): RootEntry {
  return { pid: peer.pid, sign_pub: b64(peer.signPub), box_pub: b64(peer.boxPub) };
}

function decodeKey(text: unknown): Uint8Array | null {
  if (typeof text !== "string") return null;
  try {
    const bytes = sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
    return bytes.length === KEY_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * All or nothing: one bad entry refuses the whole list, so a typo can never
 * leave the relay running with a quietly shorter allowlist. The pid is
 * recomputed from the key, so config can't pair a name with someone else's key.
 */
export function parseRoots(json: string): { readonly ok: true; readonly roots: ReadonlyMap<Pid, Peer> } | { readonly ok: false; readonly error: string } {
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch {
    return { ok: false, error: "roots are not valid JSON" };
  }
  if (!Array.isArray(entries)) return { ok: false, error: "roots must be a JSON array" };

  const peers: Peer[] = [];
  for (const [index, entry] of entries.entries()) {
    const signPub = decodeKey(entry?.sign_pub);
    const boxPub = decodeKey(entry?.box_pub);
    if (signPub === null || boxPub === null) return { ok: false, error: `root ${index}: keys must be 32-byte base64` };
    const pid = pidOf(signPub);
    if (entry.pid !== pid) return { ok: false, error: `root ${index}: pid does not match sign_pub` };
    peers.push({ pid, signPub, boxPub });
  }
  return { ok: true, roots: new Map(peers.map((peer) => [peer.pid, peer])) };
}
