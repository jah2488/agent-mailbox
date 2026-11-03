import { canonicalize } from "./canonical.ts";
import type { Identity, Peer, Pid } from "./identity.ts";
import sodium from "./sodium.ts";

// Separate domain from envelopes, so a request signature can never verify as
// an envelope signature or the reverse.
const REQUEST_DOMAIN = "agent-mailbox/v1/request\n";
const SCHEME = "AgentMailbox ";
const MAX_SKEW_MS = 5 * 60_000;

/** What a signed read request commits to. path includes the query string. */
export type RequestClaim = { readonly method: string; readonly path: string; readonly ts: string; readonly nonce?: string };

type Signed = { readonly m: string; readonly n: string; readonly p: string; readonly pid: string; readonly t: string };

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.URLSAFE_NO_PADDING);
const signedBytes = (claim: Signed) => new TextEncoder().encode(REQUEST_DOMAIN + canonicalize(claim));

export function signRequest(claim: RequestClaim, as: Identity): string {
  const signed: Signed = {
    m: claim.method,
    n: claim.nonce ?? b64(sodium.randombytes_buf(16)),
    p: claim.path,
    pid: as.pid,
    t: claim.ts,
  };
  const s = b64(sodium.crypto_sign_detached(signedBytes(signed), as.signSec));
  return SCHEME + b64(new TextEncoder().encode(canonicalize({ ...signed, s })));
}

/**
 * Accepts a request only if a root signed exactly this method and path within
 * the skew window. Nonce reuse is checked by the caller, which owns storage.
 */
export function verifyRequest(
  authorization: string | null,
  request: { readonly method: string; readonly path: string },
  roots: ReadonlyMap<Pid, Peer>,
  now: Date,
): { readonly ok: true; readonly pid: Pid; readonly nonce: string } | { readonly ok: false } {
  const rejected = { ok: false } as const;
  if (authorization === null || !authorization.startsWith(SCHEME)) return rejected;
  let claim: Record<string, unknown>;
  try {
    claim = JSON.parse(new TextDecoder().decode(unb64(authorization.slice(SCHEME.length)))) as Record<string, unknown>;
  } catch {
    return rejected;
  }
  const { m, n, p, pid, t, s } = claim;
  if (![m, n, p, pid, t, s].every((field) => typeof field === "string")) return rejected;
  const signed = { m, n, p, pid, t } as Signed;

  const root = roots.get(signed.pid as Pid);
  if (root === undefined || signed.m !== request.method || signed.p !== request.path) return rejected;
  const skew = Math.abs(now.getTime() - Date.parse(signed.t));
  if (!(skew <= MAX_SKEW_MS)) return rejected;
  try {
    if (!sodium.crypto_sign_verify_detached(unb64(s as string), signedBytes(signed), root.signPub)) return rejected;
  } catch {
    return rejected;
  }
  return { ok: true, pid: root.pid, nonce: signed.n };
}
