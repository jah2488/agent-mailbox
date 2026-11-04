import { canonicalize } from "./canonical.ts";
import sodium from "./sodium.ts";

// A relay proves which relay it is, so clients can pin it and refuse a
// swapped or lookalike one. It signs a description of itself that names
// its host and echoes a fresh challenge: a copy can't be replayed later, and
// a lookalike can't pass off another host's answer as its own. This proves
// identity, not honesty; the envelope design is what makes a relay unable to
// read, forge or silently reorder mail.

export const RELAY_PROTOCOL = "agent-mailbox/1";
const RELAY_DOMAIN = "agent-mailbox/v1/relay\n";
export const WELL_KNOWN_PATH = "/.well-known/agent-mailbox";
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type RelayKey = { readonly publicKey: string; readonly secretKey: Uint8Array };
export type RelayDescription = { readonly protocol: string; readonly host: string; readonly relay_key: string; readonly challenge: string; readonly s: string };

const b64url = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const unb64url = (text: string) => sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
const signedBytes = (d: Omit<RelayDescription, "s">) => new TextEncoder().encode(RELAY_DOMAIN + canonicalize(d));

/** The relay's key from its 32-byte seed (base64url), the one secret an operator keeps in MAILBOX_RELAY_KEY. */
export function relayKeyFromSeed(seed: string): RelayKey {
  let bytes: Uint8Array;
  try {
    bytes = unb64url(seed.trim());
  } catch {
    bytes = new Uint8Array();
  }
  if (bytes.length !== 32) throw new Error("MAILBOX_RELAY_KEY must be a base64url 32-byte seed (npm run relay-key makes one)");
  const pair = sodium.crypto_sign_seed_keypair(bytes);
  return { publicKey: b64url(pair.publicKey), secretKey: pair.privateKey };
}

export function newRelaySeed(): string {
  return b64url(sodium.randombytes_buf(32));
}

export function describeRelay(key: RelayKey, host: string, challenge: string): RelayDescription {
  const body = { protocol: RELAY_PROTOCOL, host, relay_key: key.publicKey, challenge };
  return { ...body, s: b64url(sodium.crypto_sign_detached(signedBytes(body), key.secretKey)) };
}

export function verifyRelayDescription(
  value: unknown,
  host: string,
  challenge: string,
): { readonly ok: true; readonly relayKey: string } | { readonly ok: false; readonly error: string } {
  const d = value as Partial<RelayDescription> | null;
  if (typeof d !== "object" || d === null || ![d.protocol, d.host, d.relay_key, d.challenge, d.s].every((f) => typeof f === "string")) {
    return { ok: false, error: "not a relay description" };
  }
  const { protocol, relay_key, s } = d as RelayDescription;
  if (protocol !== RELAY_PROTOCOL) return { ok: false, error: `speaks ${protocol}, not ${RELAY_PROTOCOL}` };
  if (d.host !== host) return { ok: false, error: "describes a different host" };
  if (d.challenge !== challenge) return { ok: false, error: "answered a different challenge" };
  try {
    const body = { protocol, host, relay_key, challenge };
    if (!sodium.crypto_sign_verify_detached(unb64url(s), signedBytes(body), unb64url(relay_key))) return { ok: false, error: "bad signature" };
  } catch {
    return { ok: false, error: "bad signature" };
  }
  return { ok: true, relayKey: relay_key };
}
