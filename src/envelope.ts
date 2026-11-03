import { canonicalize, type Json } from "./canonical.ts";
import { isCertShape, verifyCert, type SignedCert } from "./cert.ts";
import type { BoxKeys, Identity, Peer, Pid } from "./identity.ts";
import sodium from "./sodium.ts";

export const MAX_ENVELOPE_BYTES = 256 * 1024;

// Domain separation: a signature made here can never be replayed as a
// signature over some other agent-mailbox structure (certs, policy, audit).
export const SIGNING_DOMAIN = "agent-mailbox/v1/envelope\n";
const HASH_PATTERN = /^b2:[0-9a-f]{64}$/;

/**
 * How many recent (seq, hash) links are kept per sender. Inside the window an
 * exact redelivery is a duplicate and a different envelope is a fork; older
 * than the window, the two can't be told apart, so both report replay.
 */
export const RECENT_WINDOW = 64;

/** "b2:" + blake2b-256 of an envelope's wire bytes. Only hashOf mints one. */
export type Hash = string & { readonly __brand: "Hash" };

export type Header = {
  readonly v: 1;
  readonly from: Pid;
  readonly to: Pid;
  readonly seq: number;
  readonly prev: Hash | null;
  readonly ts: string;
  readonly hops: number;
  readonly authored_by: "agent";
  /** Present when an agent key signed this envelope on the person's behalf; absent when the root key did. */
  readonly cert?: SignedCert;
};

/** Who signed: the person's own root key (their interactive sessions), or an agent it certified (the daemon). */
export type Via = { readonly kind: "owner" } | { readonly kind: "agent"; readonly name: string };

export type Body = {
  readonly tag: string;
  readonly ref: string;
  readonly reply_to?: string;
  readonly payload: Json;
  readonly prose?: string;
};

export type ChainLink = { readonly seq: number; readonly hash: Hash };

/** The last RECENT_WINDOW envelopes accepted from one sender, oldest first. */
export type SenderChain = { readonly recent: readonly ChainLink[] };

export type OpenContext = {
  readonly me: BoxKeys;
  readonly roster: ReadonlyMap<Pid, Peer>;
  readonly chains: ReadonlyMap<Pid, SenderChain>;
};

export type OpenError =
  | "bad_cert"
  | "too_large"
  | "malformed"
  | "non_canonical"
  | "unsupported"
  | "unknown_sender"
  | "bad_signature"
  | "wrong_recipient"
  | "replay"
  | "duplicate"
  | "fork"
  | "gap"
  | "chain_mismatch"
  | "decrypt_failed"
  | "sender_mismatch";

export type Opened = {
  readonly ok: true;
  readonly header: Header;
  readonly body: Body;
  readonly hash: Hash;
  /** The caller's new chain for this sender; open never mutates its context. */
  readonly chain: SenderChain;
  readonly via: Via;
};

type Failure<E> = { readonly ok: false; readonly error: E };

export type SealInput = {
  readonly from: Pick<Identity, "pid" | "signSec">;
  readonly to: Peer;
  readonly seq: number;
  readonly prev: Hash | null;
  readonly ts: string;
  readonly hops?: number;
  readonly body: Body;
  /** Sign with a certified agent key instead of the root. The root stays offline from the daemon's signing path. */
  readonly agent?: { readonly signSec: Uint8Array; readonly cert: SignedCert };
};

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isHops = (value: unknown): value is number => isCount(value) && value <= 255;

const utf8 = new TextEncoder();
// ignoreBOM keeps a leading BOM in the text, so JSON.parse rejects it. By
// default the decoder strips it silently, giving one envelope two hashes.
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
const fail = <E>(error: E): Failure<E> => ({ ok: false, error });

function signedBytes(header: Header, ciphertext: string): Uint8Array {
  return utf8.encode(SIGNING_DOMAIN + canonicalize({ c: ciphertext, h: header }));
}

export function hashOf(wire: Uint8Array): Hash {
  return ("b2:" + sodium.to_hex(sodium.crypto_generichash(32, wire))) as Hash;
}

function encodeSigned(header: Header, ciphertext: string, signSec: Uint8Array): Uint8Array<ArrayBuffer> {
  const sig = sodium.crypto_sign_detached(signedBytes(header, ciphertext), signSec);
  return utf8.encode(canonicalize({ c: ciphertext, h: header, s: b64(sig) }));
}

export function seal(
  input: SealInput,
): { readonly ok: true; readonly wire: Uint8Array<ArrayBuffer> } | Failure<"too_large" | "invalid_payload" | "invalid_header"> {
  const hops = input.hops ?? 0;
  if (!isCount(input.seq) || !isHops(hops)) return fail("invalid_header");
  // The sender's pid rides inside the ciphertext. A sealed box is anonymous,
  // so without it anyone could re-sign a captured ciphertext as their own.
  let plaintext: Uint8Array;
  try {
    plaintext = utf8.encode(canonicalize({ ...input.body, from: input.from.pid }));
  } catch {
    return fail("invalid_payload");
  }
  const ciphertext = b64(sodium.crypto_box_seal(plaintext, input.to.boxPub));
  const header: Header = {
    v: 1,
    from: input.from.pid,
    to: input.to.pid,
    seq: input.seq,
    prev: input.prev,
    ts: input.ts,
    hops,
    authored_by: "agent",
    ...(input.agent === undefined ? {} : { cert: input.agent.cert }),
  };
  const wire = encodeSigned(header, ciphertext, input.agent?.signSec ?? input.from.signSec);
  return wire.length > MAX_ENVELOPE_BYTES ? fail("too_large") : { ok: true, wire };
}

export type OuterError = "too_large" | "malformed" | "non_canonical" | "unsupported" | "unknown_sender" | "bad_cert" | "bad_signature";

export type VerifiedOuter = { readonly ok: true; readonly header: Header; readonly ciphertext: string; readonly hash: Hash; readonly via: Via };

/**
 * Everything checkable without the recipient's key: size, canonical form,
 * shape, roster membership, cert chain and signature. The relay stops here;
 * open goes on. Checks run cheapest and least trusting first.
 */
export function verifyOuter(wire: Uint8Array, roster: ReadonlyMap<Pid, Peer>, acceptAt?: Date): VerifiedOuter | Failure<OuterError> {
  if (wire.length > MAX_ENVELOPE_BYTES) return fail("too_large");

  const parsed = parseCanonical(wire);
  if (!parsed.ok) return parsed;
  const shape = readEnvelope(parsed.value);
  if (!shape.ok) return shape;
  const { header, ciphertext, signature } = shape;

  const sender = roster.get(header.from);
  if (sender === undefined) return fail("unknown_sender");
  // With a cert, the root vouches for an agent key and that key must have signed.
  let signer = sender.signPub;
  let via: Via = { kind: "owner" };
  if (header.cert !== undefined) {
    // A cert must cover the moment the envelope says it was sent, so mail
    // stays readable after the cert lapses. Accepting new mail (acceptAt)
    // also requires it be valid now, so an expired key can't backdate.
    const cert = verifyCert(header.cert, sender, new Date(header.ts));
    if (!cert.ok) return fail("bad_cert");
    if (acceptAt !== undefined && !verifyCert(header.cert, sender, acceptAt).ok) return fail("bad_cert");
    signer = cert.agentSignPub;
    via = { kind: "agent", name: cert.name };
  }
  if (!verifySignature(header, ciphertext, signature, signer)) return fail("bad_signature");
  return { ok: true, header, ciphertext, hash: hashOf(wire), via };
}

/** Verifies and decrypts one envelope addressed to ctx.me. */
export function open(wire: Uint8Array, ctx: OpenContext): Opened | Failure<OpenError> {
  const outer = verifyOuter(wire, ctx.roster);
  if (!outer.ok) return outer;
  const { header, ciphertext, hash, via } = outer;
  if (header.to !== ctx.me.pid) return fail("wrong_recipient");

  const known = ctx.chains.get(header.from)?.recent ?? [];
  const chainError = checkChain(header, hash, known);
  if (chainError !== null) return fail(chainError);

  const body = decryptBody(ciphertext, ctx.me);
  if (!body.ok) return body;
  if (body.from !== header.from) return fail("sender_mismatch");

  const recent = [...known, { seq: header.seq, hash }].slice(-RECENT_WINDOW);
  return { ok: true, header, body: body.body, hash, chain: { recent }, via };
}

function parseCanonical(wire: Uint8Array): { readonly ok: true; readonly value: unknown } | Failure<"malformed" | "non_canonical"> {
  let text: string;
  let value: unknown;
  try {
    text = strictUtf8.decode(wire);
    value = JSON.parse(text);
  } catch {
    return fail("malformed");
  }
  try {
    return canonicalize(value as Json) === text ? { ok: true, value } : fail("non_canonical");
  } catch {
    return fail("malformed");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Compatibility rule: a signed object may carry fields this version doesn't
// know (a newer sender's additions), so required fields are checked and the
// rest ignored. Unsigned wrappers stay exact, since anyone could add to them.
// A change old readers must not ignore bumps v instead.
const hasKeys = (record: Readonly<Record<string, unknown>>, required: readonly string[]) => required.every((k) => Object.hasOwn(record, k));

function hasExactKeys(record: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(record);
  return required.every((k) => Object.hasOwn(record, k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

function readEnvelope(
  value: unknown,
): { readonly ok: true; readonly header: Header; readonly ciphertext: string; readonly signature: string } | Failure<"malformed" | "unsupported"> {
  if (!isRecord(value) || !hasExactKeys(value, ["c", "h", "s"])) return fail("malformed");
  const { c, h, s } = value;
  if (typeof c !== "string" || typeof s !== "string" || !isRecord(h)) return fail("malformed");
  if (!hasKeys(h, ["v", "from", "to", "seq", "prev", "ts", "hops", "authored_by"])) return fail("malformed");
  if (h["cert"] !== undefined && !isCertShape(h["cert"])) return fail("malformed");
  // v0 has no root-signed approval, so a human claim cannot be verified yet.
  if (h["v"] !== 1 || h["authored_by"] !== "agent") return fail("unsupported");
  const wellFormed =
    typeof h["from"] === "string" &&
    typeof h["to"] === "string" &&
    typeof h["ts"] === "string" &&
    isCount(h["seq"]) &&
    isHops(h["hops"]) &&
    (h["prev"] === null || (typeof h["prev"] === "string" && HASH_PATTERN.test(h["prev"])));
  return wellFormed ? { ok: true, header: h as unknown as Header, ciphertext: c, signature: s } : fail("malformed");
}

function verifySignature(header: Header, ciphertext: string, signature: string, signerPub: Uint8Array): boolean {
  try {
    return sodium.crypto_sign_verify_detached(unb64(signature), signedBytes(header, ciphertext), signerPub);
  } catch {
    return false;
  }
}

function checkChain(header: Header, hash: Hash, recent: readonly ChainLink[]): OpenError | null {
  const head = recent.at(-1);
  if (head === undefined) {
    if (header.seq !== 0) return "gap";
    return header.prev === null ? null : "chain_mismatch";
  }
  if (header.seq <= head.seq) {
    const seen = recent.find((link) => link.seq === header.seq);
    if (seen === undefined) return "replay";
    return seen.hash === hash ? "duplicate" : "fork";
  }
  if (header.seq > head.seq + 1) return "gap";
  return header.prev === head.hash ? null : "chain_mismatch";
}

function decryptBody(
  ciphertext: string,
  me: BoxKeys,
): { readonly ok: true; readonly body: Body; readonly from: string } | Failure<"decrypt_failed" | "malformed"> {
  let value: unknown;
  try {
    value = JSON.parse(strictUtf8.decode(sodium.crypto_box_seal_open(unb64(ciphertext), me.boxPub, me.boxSec)));
  } catch {
    return fail("decrypt_failed");
  }
  if (!isRecord(value) || !hasKeys(value, ["tag", "ref", "payload", "from"])) return fail("malformed");
  // Only known fields are kept, so nothing unvetted reaches state or the model.
  const { from, tag, ref, payload, reply_to, prose } = value;
  const body = { tag, ref, payload, ...(reply_to === undefined ? {} : { reply_to }), ...(prose === undefined ? {} : { prose }) };
  const wellFormed =
    typeof from === "string" &&
    typeof tag === "string" &&
    typeof ref === "string" &&
    (reply_to === undefined || typeof reply_to === "string") &&
    (prose === undefined || typeof prose === "string");
  return wellFormed ? { ok: true, body: body as unknown as Body, from: from as string } : fail("malformed");
}
