import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "./canonical.ts";
import { generateIdentity, pidOf, toPeer, type Identity, type Peer, type Pid } from "./identity.ts";
import {
  hashOf,
  open,
  seal,
  MAX_ENVELOPE_BYTES,
  RECENT_WINDOW,
  SIGNING_DOMAIN,
  type Body,
  type Hash,
  type Header,
  type OpenContext,
  type SenderChain,
} from "./envelope.ts";
import sodium from "./sodium.ts";
import { issueCert, type SignedCert } from "./cert.ts";

const alice = generateIdentity();
const bob = generateIdentity();
const mallory = generateIdentity();

const body: Body = { tag: "ask", ref: "01JREF", payload: { q: "what are you working on?" } };
const ZERO_HASH = ("b2:" + "0".repeat(64)) as Hash;

function rosterOf(...ids: Identity[]): ReadonlyMap<Pid, Peer> {
  return new Map(ids.map((id) => [id.pid, toPeer(id)]));
}

function bobContext(chains: ReadonlyMap<Pid, SenderChain> = new Map()): OpenContext {
  return { me: bob, roster: rosterOf(alice, mallory), chains };
}

function sealFromAlice(seq: number, prev: Hash | null, b: Body = body): Uint8Array {
  const result = seal({ from: alice, to: toPeer(bob), seq, prev, ts: "2026-11-02T00:00:00Z", body: b });
  assert.ok(result.ok, "seal should succeed");
  return result.wire;
}

function openOk(wire: Uint8Array, ctx: OpenContext) {
  const result = open(wire, ctx);
  assert.ok(result.ok, `expected ok, got ${result.ok ? "" : result.error}`);
  return result;
}

function expectError(wire: Uint8Array, ctx: OpenContext, error: string): void {
  const result = open(wire, ctx);
  assert.equal(result.ok ? "ok" : result.error, error);
}

/** Alice's first n messages, each opened in order; returns the wires and bob's chain after them. */
function aliceHistory(n: number): { readonly wires: readonly Uint8Array[]; readonly chain: SenderChain } {
  let chain: SenderChain | undefined;
  const wires: Uint8Array[] = [];
  for (let seq = 0; seq < n; seq++) {
    const prev = chain?.recent.at(-1)?.hash ?? null;
    const wire = sealFromAlice(seq, prev);
    chain = openOk(wire, bobContext(chain ? new Map([[alice.pid, chain]]) : new Map())).chain;
    wires.push(wire);
  }
  assert.ok(chain);
  return { wires, chain };
}

/**
 * Signs an arbitrary header the way the library does, so attack tests can
 * build envelopes seal() would never produce. Lives here, not in the
 * library, so production code has no path to sign an unchecked header.
 */
function signAs(header: Readonly<Record<string, unknown>>, ciphertext: string, signer: Identity): Uint8Array {
  const signed = new TextEncoder().encode(SIGNING_DOMAIN + canonicalize({ c: ciphertext, h: header } as never));
  const sig = sodium.to_base64(sodium.crypto_sign_detached(signed, signer.signSec), sodium.base64_variants.ORIGINAL);
  return new TextEncoder().encode(canonicalize({ c: ciphertext, h: header, s: sig } as never));
}

const text = (wire: Uint8Array) => new TextDecoder().decode(wire);
const bytes = (s: string) => new TextEncoder().encode(s);
const parts = (wire: Uint8Array) => JSON.parse(text(wire)) as { h: Header; c: string };

test("pid is a stable 16-char base32 hash of the signing key", () => {
  assert.match(alice.pid, /^[a-z2-7]{16}$/);
  assert.equal(pidOf(alice.signPub), alice.pid);
  assert.notEqual(alice.pid, bob.pid);
});

test("a hash cannot be passed where a pid belongs", () => {
  const hash = hashOf(sealFromAlice(0, null));
  // @ts-expect-error Hash and Pid are distinct brands.
  const misused: Pid = hash;
  assert.ok(misused);
});

test("round trip: bob opens alice's first message and gets her body back", () => {
  const wire = sealFromAlice(0, null);
  const result = openOk(wire, bobContext());
  assert.equal(result.header.from, alice.pid);
  assert.equal(result.header.seq, 0);
  assert.deepEqual(result.body, body);
  assert.deepEqual(result.chain.recent, [{ seq: 0, hash: hashOf(wire) }]);
});

test("a 1-byte change to the ciphertext fails the signature", () => {
  const wire = sealFromAlice(0, null);
  const { c } = parts(wire);
  const tampered = c.slice(0, 5) + (c[5] === "A" ? "B" : "A") + c.slice(6);
  expectError(bytes(text(wire).replace(c, tampered)), bobContext(), "bad_signature");
});

test("a 1-byte change to the header fails the signature", () => {
  const wire = text(sealFromAlice(0, null)).replace('"hops":0', '"hops":1');
  expectError(bytes(wire), bobContext(), "bad_signature");
});

test("only the canonical encoding is accepted", () => {
  const wire = text(sealFromAlice(0, null));
  expectError(bytes(wire.replace("{", "{ ")), bobContext(), "non_canonical");
  const parsed = JSON.parse(wire) as Record<string, unknown>;
  expectError(bytes(JSON.stringify({ s: parsed["s"], h: parsed["h"], c: parsed["c"] })), bobContext(), "non_canonical");
  expectError(bytes(wire.replace('"seq":0', '"seq":00')), bobContext(), "malformed");
  expectError(bytes(wire.replace('"v":1', '"\\u0076":1')), bobContext(), "non_canonical");
});

test("a BOM-prefixed copy is rejected, so a relay cannot mint a second hash", () => {
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...sealFromAlice(0, null)]);
  expectError(withBom, bobContext(), "malformed");
});

test("a message addressed to someone else is rejected", () => {
  const malloryCtx: OpenContext = { me: mallory, roster: rosterOf(alice, bob), chains: new Map() };
  expectError(sealFromAlice(0, null), malloryCtx, "wrong_recipient");
});

test("a sender outside the roster is rejected", () => {
  const strangerCtx: OpenContext = { me: bob, roster: rosterOf(mallory), chains: new Map() };
  expectError(sealFromAlice(0, null), strangerCtx, "unknown_sender");
});

test("gaps and broken chains are detected", () => {
  const { chain } = aliceHistory(1);
  const head = chain.recent.at(-1)!.hash;
  const chains = new Map([[alice.pid, chain]]);
  expectError(sealFromAlice(2, head), bobContext(chains), "gap");
  expectError(sealFromAlice(1, ZERO_HASH), bobContext(chains), "chain_mismatch");
});

test("a first message must start the chain at seq 0 with no prev", () => {
  expectError(sealFromAlice(3, null), bobContext(), "gap");
  expectError(sealFromAlice(0, ZERO_HASH), bobContext(), "chain_mismatch");
});

test("exact redelivery of the head or an older message is a duplicate", () => {
  const { wires, chain } = aliceHistory(3);
  const chains = new Map([[alice.pid, chain]]);
  expectError(wires[2]!, bobContext(chains), "duplicate");
  expectError(wires[0]!, bobContext(chains), "duplicate");
});

test("a different envelope at a remembered seq is a fork", () => {
  const { chain } = aliceHistory(3);
  const chains = new Map([[alice.pid, chain]]);
  // A fresh seal has a new ephemeral key, so same seq, different bytes.
  expectError(sealFromAlice(2, chain.recent[1]!.hash), bobContext(chains), "fork");
  expectError(sealFromAlice(0, null), bobContext(chains), "fork");
});

test("an envelope older than the remembered window is a replay", () => {
  const { wires, chain } = aliceHistory(RECENT_WINDOW + 2);
  assert.equal(chain.recent.length, RECENT_WINDOW);
  expectError(wires[0]!, bobContext(new Map([[alice.pid, chain]])), "replay");
});

test("re-signing someone else's ciphertext is caught by the sender binding", () => {
  const { h, c } = parts(sealFromAlice(0, null));
  expectError(signAs({ ...h, from: mallory.pid }, c, mallory), bobContext(), "sender_mismatch");
});

test("authored_by: human is rejected until root-signed approval exists", () => {
  const { h, c } = parts(sealFromAlice(0, null));
  expectError(signAs({ ...h, authored_by: "human" }, c, alice), bobContext(), "unsupported");
});

test("hops above 255 is malformed on receipt", () => {
  const { h, c } = parts(sealFromAlice(0, null));
  expectError(signAs({ ...h, hops: 256 }, c, alice), bobContext(), "malformed");
});

test("seal refuses a header open would reject", () => {
  const sealWith = (seq: number, hops: number) => {
    const sealed = seal({ from: alice, to: toPeer(bob), seq, prev: null, ts: "t", hops, body });
    return sealed.ok ? "ok" : sealed.error;
  };
  assert.equal(sealWith(0, 256), "invalid_header");
  assert.equal(sealWith(-1, 0), "invalid_header");
  assert.equal(sealWith(1.5, 0), "invalid_header");
});

test("envelopes over the size cap are refused on both ends", () => {
  const big: Body = { ...body, payload: { blob: "x".repeat(MAX_ENVELOPE_BYTES) } };
  const sealed = seal({ from: alice, to: toPeer(bob), seq: 0, prev: null, ts: "t", body: big });
  assert.equal(sealed.ok ? "ok" : sealed.error, "too_large");
  expectError(new Uint8Array(MAX_ENVELOPE_BYTES + 1), bobContext(), "too_large");
});

test("seal returns a typed failure for a payload canonical JSON cannot encode", () => {
  const sealed = seal({ from: alice, to: toPeer(bob), seq: 0, prev: null, ts: "t", body: { ...body, payload: { n: 1.5 } } });
  assert.equal(sealed.ok ? "ok" : sealed.error, "invalid_payload");
});

test("a __proto__ key never survives, on either end", () => {
  const poisoned = JSON.parse('{"__proto__":{"admin":true}}') as Body["payload"];
  const sealed = seal({ from: alice, to: toPeer(bob), seq: 0, prev: null, ts: "t", body: { ...body, payload: poisoned } });
  assert.equal(sealed.ok ? "ok" : sealed.error, "invalid_payload");
  assert.throws(() => canonicalize(poisoned));
});

test("canonicalize sorts keys, rejects non-integers, and ignores insertion order", () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.throws(() => canonicalize({ n: 1.5 }));
  assert.throws(() => canonicalize({ n: Number.MAX_SAFE_INTEGER + 1 }));
});

// ---- Agent certs: the daemon signs with a key the root certified. ----

const daemonKey = generateIdentity();
const certNow = new Date();

function sealAsAgent(cert: SignedCert, signer: Identity = daemonKey): Uint8Array {
  const result = seal({ from: alice, to: toPeer(bob), seq: 0, prev: null, ts: certNow.toISOString(), body, agent: { signSec: signer.signSec, cert } });
  assert.ok(result.ok);
  return result.wire;
}

test("mail signed by a certified agent opens and says which agent sent it", () => {
  const cert = issueCert(alice, { agentSignPub: daemonKey.signPub, name: "daemon", device: "laptop", now: certNow });
  const opened = openOk(sealAsAgent(cert), bobContext());
  assert.deepEqual(opened.via, { kind: "agent", name: "daemon" });
});

test("mail signed by the root itself opens as the owner", () => {
  assert.deepEqual(openOk(sealFromAlice(0, null), bobContext()).via, { kind: "owner" });
});

test("an expired cert or another person's cert is refused", () => {
  const stale = issueCert(alice, { agentSignPub: daemonKey.signPub, name: "daemon", device: "laptop", now: new Date(certNow.getTime() - 40 * 86_400_000) });
  expectError(sealAsAgent(stale), bobContext(), "bad_cert");
  const malloryCert = issueCert(mallory, { agentSignPub: daemonKey.signPub, name: "daemon", device: "laptop", now: certNow });
  expectError(sealAsAgent(malloryCert), bobContext(), "bad_cert");
});

test("a valid cert does not cover a signature from a different key", () => {
  const cert = issueCert(alice, { agentSignPub: daemonKey.signPub, name: "daemon", device: "laptop", now: certNow });
  expectError(sealAsAgent(cert, mallory), bobContext(), "bad_signature");
});

// ---- Forward compatibility: a newer sender may add signed fields an older reader doesn't know. ----

test("a header carrying a signed field this version doesn't know still opens", () => {
  const { h, c } = parts(sealFromAlice(0, null));
  const opened = openOk(signAs({ ...h, future: "ignored" }, c, alice), bobContext());
  assert.deepEqual(opened.body, body);
});

test("an unsigned extra key on the outer envelope is still refused", () => {
  const wire = JSON.parse(text(sealFromAlice(0, null))) as Record<string, unknown>;
  expectError(bytes(canonicalize({ ...wire, x: 1 } as never)), bobContext(), "malformed");
});

test("a body carrying a field this version doesn't know opens, and the unknown field is dropped", () => {
  const { h } = parts(sealFromAlice(0, null));
  const plaintext = new TextEncoder().encode(canonicalize({ ...body, from: alice.pid, future: "ignored" } as never));
  const c = sodium.to_base64(sodium.crypto_box_seal(plaintext, bob.boxPub), sodium.base64_variants.ORIGINAL);
  const opened = openOk(signAs(h as never, c, alice), bobContext());
  assert.deepEqual(opened.body, body);
});
