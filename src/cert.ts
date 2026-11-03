import { canonicalize } from "./canonical.ts";
import type { Identity, Peer, Pid } from "./identity.ts";
import sodium from "./sodium.ts";

// A root key delegating signing to an agent (the daemon). The root signs this
// cert; the agent signs envelopes and carries the cert, so a receiver can
// verify the chain against the roster and show the mail as the person's
// agent rather than the person. Short-lived, so a leaked agent key ages out.

/** Domain separation from envelopes and requests: a cert signature verifies as nothing else. */
export const CERT_DOMAIN = "agent-mailbox/v1/cert\n";
const DEFAULT_TTL_DAYS = 30;
const SKEW_MS = 5 * 60_000;
// Receivers print this outside the untrusted frame, so it is a slug, never prose.
const AGENT_NAME = /^[a-z0-9-]{1,24}$/;

export type CertBody = {
  readonly v: 1;
  readonly person: Pid;
  readonly agent_sign_pub: string;
  readonly name: string;
  readonly device: string;
  readonly issued: string;
  readonly expires: string;
  /** The daemon's audit-log key, held apart from the key that signs mail. Absent on certs that only sign mail. */
  readonly audit_pub?: string;
};
export type SignedCert = { readonly c: CertBody; readonly s: string };
export type CertRequest = { readonly agentSignPub: Uint8Array; readonly auditPub?: Uint8Array; readonly name: string; readonly device: string; readonly now: Date; readonly ttlDays?: number };

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
const signedBytes = (body: CertBody) => new TextEncoder().encode(CERT_DOMAIN + canonicalize(body));

export function issueCert(root: Identity, request: CertRequest): SignedCert {
  const expires = new Date(request.now.getTime() + (request.ttlDays ?? DEFAULT_TTL_DAYS) * 86_400_000);
  const body: CertBody = {
    v: 1,
    person: root.pid,
    agent_sign_pub: b64(request.agentSignPub),
    name: request.name,
    device: request.device,
    issued: request.now.toISOString(),
    expires: expires.toISOString(),
    ...(request.auditPub === undefined ? {} : { audit_pub: b64(request.auditPub) }),
  };
  return { c: body, s: b64(sodium.crypto_sign_detached(signedBytes(body), root.signSec)) };
}

export function verifyCert(
  cert: SignedCert,
  root: Peer,
  now: Date,
): { readonly ok: true; readonly agentSignPub: Uint8Array; readonly auditPub: Uint8Array | null; readonly name: string } | { readonly ok: false; readonly error: string } {
  if (cert.c.person !== root.pid) return { ok: false, error: "cert is for a different person" };
  if (!AGENT_NAME.test(cert.c.name)) return { ok: false, error: "agent name must be 1-24 of a-z 0-9 -" };
  try {
    if (!sodium.crypto_sign_verify_detached(unb64(cert.s), signedBytes(cert.c), root.signPub)) return { ok: false, error: "bad cert signature" };
  } catch {
    return { ok: false, error: "bad cert signature" };
  }
  const issued = Date.parse(cert.c.issued);
  const expires = Date.parse(cert.c.expires);
  if (!(issued - SKEW_MS <= now.getTime())) return { ok: false, error: "cert is not valid yet" };
  if (!(now.getTime() <= expires + SKEW_MS)) return { ok: false, error: "cert has expired" };
  try {
    return { ok: true, agentSignPub: unb64(cert.c.agent_sign_pub), auditPub: cert.c.audit_pub === undefined ? null : unb64(cert.c.audit_pub), name: cert.c.name };
  } catch {
    return { ok: false, error: "malformed cert key" };
  }
}

/** The agent key a cert names, signature unchecked: only for finding which stored key to renew. Trust comes from verifyCert. */
export function certifiedKeyOf(cert: SignedCert): Uint8Array | null {
  try {
    return unb64(cert.c.agent_sign_pub);
  } catch {
    return null;
  }
}

/** Structural check before any field is read; verifyCert assumes this shape. */
export function isCertShape(value: unknown): value is SignedCert {
  const record = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === "object" && v !== null && !Array.isArray(v);
  const exactly = (r: Readonly<Record<string, unknown>>, keys: readonly string[]) => Object.keys(r).length === keys.length && keys.every((k) => Object.hasOwn(r, k));
  if (!record(value) || !exactly(value, ["c", "s"]) || typeof value["s"] !== "string") return false;
  const c = value["c"];
  const fields = ["person", "agent_sign_pub", "name", "device", "issued", "expires"];
  // c is root-signed, so fields a newer issuer added are allowed; only the wrapper is exact.
  return record(c) && c["v"] === 1 && fields.every((k) => typeof c[k] === "string") && (c["audit_pub"] === undefined || typeof c["audit_pub"] === "string");
}

/** Names one cert in a :revoke. Covers the root's signature too, so it names exactly the cert that was issued. */
export const certHash = (cert: SignedCert): string => "b2:" + sodium.to_hex(sodium.crypto_generichash(32, new TextEncoder().encode(canonicalize(cert))));
