import { canonicalize } from "./canonical.ts";
import type { Identity, Peer, Pid } from "./identity.ts";
import sodium from "./sodium.ts";

// Separate domain from envelopes, so a request signature can never verify as
// an envelope signature or the reverse.
const REQUEST_DOMAIN = "agent-mailbox/v1/request\n";
const SCHEME = "AgentMailbox ";
const MAX_SKEW_MS = 5 * 60_000;

/**
 * What a signed read request commits to. host binds it to one relay
 * deployment, so it can't be replayed against another that shares roots;
 * path includes the query string.
 */
export type RequestClaim = {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly ts: string;
  readonly nonce?: string;
};

type Signed = { readonly h: string; readonly m: string; readonly n: string; readonly p: string; readonly pid: string; readonly t: string };

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
const signedBytes = (claim: Signed) => new TextEncoder().encode(REQUEST_DOMAIN + canonicalize(claim));

export function signRequest(claim: RequestClaim, as: Identity): string {
  const signed: Signed = {
    h: claim.host,
    m: claim.method,
    n: claim.nonce ?? b64(sodium.randombytes_buf(16)),
    p: claim.path,
    pid: as.pid,
    t: claim.ts,
  };
  const s = b64(sodium.crypto_sign_detached(signedBytes(signed), as.signSec));
  return SCHEME + b64(new TextEncoder().encode(canonicalize({ ...signed, s })));
}

export type VerifiedRequest = { readonly ok: true; readonly pid: Pid; readonly nonce: string; readonly at: Date };

/**
 * Accepts a request only if a root signed exactly this method, host and path
 * within the skew window. Nonce reuse is checked by the caller, which owns
 * storage.
 */
export function verifyRequest(
  authorization: string | null,
  request: { readonly method: string; readonly host: string; readonly path: string },
  roots: ReadonlyMap<Pid, Peer>,
  now: Date,
): VerifiedRequest | { readonly ok: false } {
  const rejected = { ok: false } as const;
  if (authorization === null || !authorization.startsWith(SCHEME)) return rejected;
  let claim: unknown;
  try {
    claim = JSON.parse(new TextDecoder().decode(unb64(authorization.slice(SCHEME.length))));
  } catch {
    return rejected;
  }
  if (typeof claim !== "object" || claim === null) return rejected;
  const { h, m, n, p, pid, t, s } = claim as Record<string, unknown>;
  if (![h, m, n, p, pid, t, s].every((field) => typeof field === "string")) return rejected;
  const signed = { h, m, n, p, pid, t } as Signed;

  const root = roots.get(signed.pid as Pid);
  if (root === undefined || signed.m !== request.method || signed.h !== request.host || signed.p !== request.path) return rejected;
  const at = new Date(signed.t);
  if (!(Math.abs(now.getTime() - at.getTime()) <= MAX_SKEW_MS)) return rejected;
  try {
    if (!sodium.crypto_sign_verify_detached(unb64(s as string), signedBytes(signed), root.signPub)) return rejected;
  } catch {
    return rejected;
  }
  return { ok: true, pid: root.pid, nonce: signed.n, at };
}
