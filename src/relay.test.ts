import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity, toPeer, type Identity, type Peer, type Pid } from "./identity.ts";
import { hashOf, seal, type Body, type Hash } from "./envelope.ts";
import { signRequest } from "./request-auth.ts";
import { handle, type Store } from "./relay.ts";
import { memoryStore } from "./memory-store.ts";
import { issueCert } from "./cert.ts";
import { relayKeyFromSeed, verifyRelayDescription } from "./relay-identity.ts";

const alice = generateIdentity();
const bob = generateIdentity();
const mallory = generateIdentity();
const stranger = generateIdentity();

const BASE = "https://relay.test";
const NOW = new Date("2026-11-02T12:00:00Z");
const body: Body = { tag: "ask", ref: "01JREF", payload: { q: "status?" } };

const allRoots: ReadonlyMap<Pid, Peer> = new Map([alice, bob, mallory].map((id) => [id.pid, toPeer(id)]));

function relay(store: Store = memoryStore(), now: Date = NOW, roots: ReadonlyMap<Pid, Peer> = allRoots) {
  return (req: Request) => handle(req, { store, roots, now: () => now });
}

const HOST = new URL(BASE).host;

function envelope(from: Identity, to: Identity, seq: number, prev: Hash | null): Uint8Array<ArrayBuffer> {
  const sealed = seal({ from, to: toPeer(to), seq, prev, ts: NOW.toISOString(), body });
  assert.ok(sealed.ok);
  return sealed.wire;
}

const put = (from: Identity, seq: number, wire: Uint8Array<ArrayBuffer>) =>
  new Request(`${BASE}/log/${from.pid}/${seq}`, { method: "PUT", body: wire, headers: { "content-type": "application/json" } });

function signedGet(path: string, as: Identity, at: Date = NOW, nonce?: string): Request {
  const auth = signRequest({ method: "GET", host: HOST, path, ts: at.toISOString(), ...(nonce ? { nonce } : {}) }, as);
  return new Request(`${BASE}${path}`, { headers: { authorization: auth } });
}

async function json(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

test("PUT stores an envelope, bob lists it in his inbox and fetches the same bytes", async () => {
  const send = relay();
  const wire = envelope(alice, bob, 0, null);
  assert.equal((await send(put(alice, 0, wire))).status, 201);

  const inbox = await send(signedGet(`/inbox/${bob.pid}`, bob));
  assert.equal(inbox.status, 200);
  assert.deepEqual(await json(inbox), { entries: [{ from: alice.pid, seq: 0 }] });

  const fetched = await send(signedGet(`/log/${alice.pid}/0`, bob));
  assert.equal(fetched.status, 200);
  assert.deepEqual(new Uint8Array(await fetched.arrayBuffer()), wire);
});

test("an identical retry is 200 and a different envelope at the same seq is 409", async () => {
  const send = relay();
  const wire = envelope(alice, bob, 0, null);
  await send(put(alice, 0, wire));
  assert.equal((await send(put(alice, 0, wire))).status, 200);
  const other = await send(put(alice, 0, envelope(alice, bob, 0, null)));
  assert.equal(other.status, 409);
  assert.deepEqual(await json(other), { error: "fork" });
});

test("a sender outside the root allowlist is 403; a recipient outside it is 400", async () => {
  const send = relay();
  assert.equal((await send(put(stranger, 0, envelope(stranger, bob, 0, null)))).status, 403);
  const toStranger = await send(put(alice, 0, envelope(alice, stranger, 0, null)));
  assert.deepEqual([toStranger.status, await json(toStranger)], [400, { error: "unknown_recipient" }]);
});

test("the relay enforces the sender's chain: no gaps, prev must match", async () => {
  const send = relay();
  const first = envelope(alice, bob, 0, null);
  await send(put(alice, 0, first));
  const gap = await send(put(alice, 2, envelope(alice, bob, 2, hashOf(first))));
  assert.deepEqual([gap.status, await json(gap)], [409, { error: "gap" }]);
  const bad = await send(put(alice, 1, envelope(alice, bob, 1, ("b2:" + "0".repeat(64)) as Hash)));
  assert.deepEqual([bad.status, await json(bad)], [409, { error: "chain_mismatch" }]);
  assert.equal((await send(put(alice, 1, envelope(alice, bob, 1, hashOf(first))))).status, 201);
});

test("the path must name the envelope's own sender and seq", async () => {
  const send = relay();
  const res = await send(new Request(`${BASE}/log/${alice.pid}/5`, { method: "PUT", body: envelope(alice, bob, 0, null), headers: { "content-type": "application/json" } }));
  assert.equal(res.status, 400);
});

// netlify dev drops a PUT body that has no content-type, so a silent
// "malformed" would hide the real cause. Say what is wrong instead.
test("a PUT without a JSON content-type is 415", async () => {
  const send = relay();
  const wire = envelope(alice, bob, 0, null);
  const bare = await send(new Request(`${BASE}/log/${alice.pid}/0`, { method: "PUT", body: wire }));
  assert.deepEqual([bare.status, await json(bare)], [415, { error: "content_type_must_be_application_json" }]);
  const octet = await send(new Request(`${BASE}/log/${alice.pid}/0`, { method: "PUT", body: wire, headers: { "content-type": "application/octet-stream" } }));
  assert.equal(octet.status, 415);
});

test("bad envelopes map to 400, 401 and 413", async () => {
  const send = relay();
  const wire = new TextDecoder().decode(envelope(alice, bob, 0, null)).replace('"hops":0', '"hops":1');
  assert.equal((await send(put(alice, 0, new TextEncoder().encode(wire)))).status, 401);
  assert.equal((await send(put(alice, 0, new TextEncoder().encode("{}")))).status, 400);
  assert.equal((await send(put(alice, 0, new Uint8Array(256 * 1024 + 1)))).status, 413);
});

test("reads need a fresh signed request from the right identity", async () => {
  const send = relay();
  await send(put(alice, 0, envelope(alice, bob, 0, null)));
  const path = `/inbox/${bob.pid}`;

  assert.equal((await send(new Request(`${BASE}${path}`))).status, 401);
  assert.equal((await send(signedGet(path, mallory))).status, 403);
  assert.equal((await send(signedGet(path, stranger))).status, 401);
  assert.equal((await send(signedGet(path, bob, new Date(NOW.getTime() - 6 * 60_000)))).status, 401);
  assert.equal((await send(signedGet(`/inbox/${alice.pid}`, bob))).status, 403);
});

test("a replayed read request is refused", async () => {
  const send = relay();
  const path = `/inbox/${bob.pid}`;
  assert.equal((await send(signedGet(path, bob, NOW, "n1"))).status, 200);
  assert.equal((await send(signedGet(path, bob, NOW, "n1"))).status, 401);
});

// The sweep that relies on this shape doesn't exist yet; this pins the shape
// it will need: nonces grouped under the minute of the signed timestamp.
test("a spent nonce is stored under its signer and the minute it was signed", async () => {
  const store = memoryStore();
  await relay(store)(signedGet(`/inbox/${bob.pid}`, bob, new Date("2026-11-02T12:00:42Z"), "n1"));
  const nonces = store.keys().filter((key) => key.startsWith("nonce/"));
  assert.equal(nonces.length, 1);
  assert.match(nonces[0]!, new RegExp(`^nonce/${bob.pid}/2026-11-02T12:00/[0-9a-f]{32}$`));
});

test("a signed request for one path cannot be reused on another", async () => {
  const send = relay();
  const auth = signRequest({ method: "GET", host: HOST, path: `/inbox/${bob.pid}`, ts: NOW.toISOString() }, bob);
  const res = await send(new Request(`${BASE}/log/${alice.pid}/0`, { headers: { authorization: auth } }));
  assert.equal(res.status, 401);
});

// A non-party sees 404 whether or not the seq exists, so an allowlisted root
// cannot map another root's log length.
test("only the sender or the recipient can fetch an envelope; others can't tell it exists", async () => {
  const send = relay();
  await send(put(alice, 0, envelope(alice, bob, 0, null)));
  assert.equal((await send(signedGet(`/log/${alice.pid}/0`, mallory))).status, 404);
  assert.equal((await send(signedGet(`/log/${alice.pid}/0`, alice))).status, 200);
  assert.equal((await send(signedGet(`/log/${alice.pid}/9`, bob))).status, 404);
});

test("the inbox filters by the caller's known heads", async () => {
  const send = relay();
  const a0 = envelope(alice, bob, 0, null);
  await send(put(alice, 0, a0));
  await send(put(alice, 1, envelope(alice, bob, 1, hashOf(a0))));
  await send(put(mallory, 0, envelope(mallory, bob, 0, null)));

  const res = await send(signedGet(`/inbox/${bob.pid}?after=${alice.pid}:0`, bob));
  assert.deepEqual(await json(res), { entries: [{ from: alice.pid, seq: 1 }, { from: mallory.pid, seq: 0 }].sort((a, b) => a.from.localeCompare(b.from)) });
});

test("a first envelope that claims a prev is a chain mismatch", async () => {
  const res = await relay()(put(alice, 0, envelope(alice, bob, 0, ("b2:" + "0".repeat(64)) as Hash)));
  assert.deepEqual([res.status, await json(res)], [409, { error: "chain_mismatch" }]);
});

test("a retry after a crash between log write and index write repairs the index", async () => {
  const inner = memoryStore();
  let failNextIndex = true;
  const flaky: Store = {
    ...inner,
    createOnly: async (key, value) => {
      if (key.startsWith("inbox/") && failNextIndex) {
        failNextIndex = false;
        throw new Error("simulated crash");
      }
      return inner.createOnly(key, value);
    },
  };
  const send = relay(flaky);
  const wire = envelope(alice, bob, 0, null);
  await assert.rejects(send(put(alice, 0, wire)));
  assert.equal((await send(put(alice, 0, wire))).status, 200);
  assert.deepEqual(await json(await send(signedGet(`/inbox/${bob.pid}`, bob))), { entries: [{ from: alice.pid, seq: 0 }] });
});

test("a signed request is bound to its method", async () => {
  const path = `/inbox/${bob.pid}`;
  const auth = signRequest({ method: "POST", host: HOST, path, ts: NOW.toISOString() }, bob);
  assert.equal((await relay()(new Request(`${BASE}${path}`, { headers: { authorization: auth } }))).status, 401);
});

test("a certified agent can read its person's inbox without the root key", async () => {
  const send = relay();
  await send(put(alice, 0, envelope(alice, bob, 0, null)));
  const daemonKey = generateIdentity();
  const cert = issueCert(bob, { agentSignPub: daemonKey.signPub, name: "daemon", device: "laptop", now: NOW });
  const path = `/inbox/${bob.pid}`;
  const auth = signRequest({ method: "GET", host: HOST, path, ts: NOW.toISOString() }, { pid: bob.pid, signSec: daemonKey.signSec, cert });
  const res = await send(new Request(`${BASE}${path}`, { headers: { authorization: auth } }));
  assert.deepEqual([res.status, await json(res)], [200, { entries: [{ from: alice.pid, seq: 0 }] }]);
});

test("an agent request with someone else's cert, or signed by a key the cert doesn't name, is refused", async () => {
  const send = relay();
  const daemonKey = generateIdentity();
  const path = `/inbox/${bob.pid}`;
  const malloryCert = issueCert(mallory, { agentSignPub: daemonKey.signPub, name: "daemon", device: "laptop", now: NOW });
  const borrowed = signRequest({ method: "GET", host: HOST, path, ts: NOW.toISOString() }, { pid: bob.pid, signSec: daemonKey.signSec, cert: malloryCert });
  assert.equal((await send(new Request(`${BASE}${path}`, { headers: { authorization: borrowed } }))).status, 401);
  const bobCert = issueCert(bob, { agentSignPub: daemonKey.signPub, name: "daemon", device: "laptop", now: NOW });
  const wrongKey = signRequest({ method: "GET", host: HOST, path, ts: NOW.toISOString() }, { pid: bob.pid, signSec: mallory.signSec, cert: bobCert });
  assert.equal((await send(new Request(`${BASE}${path}`, { headers: { authorization: wrongKey } }))).status, 401);
});

test("a request whose signed fields were altered is refused", async () => {
  const path = `/inbox/${bob.pid}`;
  const auth = signRequest({ method: "GET", host: HOST, path, ts: NOW.toISOString() }, bob);
  const claim = JSON.parse(Buffer.from(auth.slice("AgentMailbox ".length), "base64url").toString()) as Record<string, string>;
  const altered = { ...claim, t: new Date(NOW.getTime() + 1000).toISOString() };
  const forged = "AgentMailbox " + Buffer.from(JSON.stringify(altered)).toString("base64url");
  assert.equal((await relay()(new Request(`${BASE}${path}`, { headers: { authorization: forged } }))).status, 401);
});

test("an authorization claim that decodes to null is 401, not a crash", async () => {
  const path = `/inbox/${bob.pid}`;
  const res = await relay()(new Request(`${BASE}${path}`, { headers: { authorization: "AgentMailbox " + Buffer.from("null").toString("base64url") } }));
  assert.equal(res.status, 401);
});

test("a signed request is bound to its host", async () => {
  const path = `/inbox/${bob.pid}`;
  const auth = signRequest({ method: "GET", host: "other-relay.test", path, ts: NOW.toISOString() }, bob);
  assert.equal((await relay()(new Request(`${BASE}${path}`, { headers: { authorization: auth } }))).status, 401);
});

test("a signed request is bound to its query string", async () => {
  const path = `/inbox/${bob.pid}`;
  const auth = signRequest({ method: "GET", host: HOST, path, ts: NOW.toISOString() }, bob);
  const res = await relay()(new Request(`${BASE}${path}?after=${alice.pid}:0`, { headers: { authorization: auth } }));
  assert.equal(res.status, 401);
});

test("an envelope from a root later removed from the allowlist reads as 404, not 500", async () => {
  const store = memoryStore();
  await relay(store)(put(alice, 0, envelope(alice, bob, 0, null)));
  const withoutAlice = new Map([...allRoots].filter(([pid]) => pid !== alice.pid));
  assert.equal((await relay(store, NOW, withoutAlice)(signedGet(`/log/${alice.pid}/0`, bob))).status, 404);
});

test("the inbox lists only bucket prefixes at or after the caller's head", async () => {
  const store = memoryStore();
  const send = relay(store);
  const a0 = envelope(alice, bob, 0, null);
  await send(put(alice, 0, a0));
  await send(put(alice, 1, envelope(alice, bob, 1, hashOf(a0))));

  store.listed.length = 0;
  const caughtUp = await send(signedGet(`/inbox/${bob.pid}?after=${alice.pid}:999`, bob));
  assert.deepEqual(await json(caughtUp), { entries: [] });
  // Every listing must be scoped to one sender's bucket (inbox/to/from/bucket/),
  // and bucket 0 holds nothing past seq 999, so it must not be listed at all.
  assert.ok(store.listed.every((prefix) => prefix.split("/").length === 5), `listed ${store.listed.join(", ")}`);
  assert.ok(!store.listed.some((prefix) => prefix.endsWith(`/${alice.pid}/0000000000000/`)), `listed ${store.listed.join(", ")}`);

  store.listed.length = 0;
  const behind = await send(signedGet(`/inbox/${bob.pid}?after=${alice.pid}:0`, bob));
  assert.deepEqual(await json(behind), { entries: [{ from: alice.pid, seq: 1 }] });
  assert.ok(store.listed.includes(`inbox/${bob.pid}/${alice.pid}/0000000000000/`), `listed ${store.listed.join(", ")}`);
});

test("a reader past seq 999 is served from the second bucket and skips the first", async () => {
  const store = memoryStore();
  // Seeding the index directly: reaching seq 1000 through PUTs would need a
  // 1001-envelope chain. The layout is inbox/{to}/{from}/{bucket13}/{seq16}.
  await store.createOnly(`inbox/${bob.pid}/${alice.pid}/0000000000000/0000000000000999`, new Uint8Array());
  await store.createOnly(`inbox/${bob.pid}/${alice.pid}/0000000000001/0000000000001000`, new Uint8Array());
  const res = await relay(store)(signedGet(`/inbox/${bob.pid}?after=${alice.pid}:999`, bob));
  assert.deepEqual(await json(res), { entries: [{ from: alice.pid, seq: 1000 }] });
  assert.ok(store.listed.includes(`inbox/${bob.pid}/${alice.pid}/0000000000001/`), `listed ${store.listed.join(", ")}`);
  assert.ok(!store.listed.some((prefix) => prefix.endsWith(`/${alice.pid}/0000000000000/`)), `listed ${store.listed.join(", ")}`);
});

// The fake lists in reverse, so this fails unless the core sorts.
test("inbox entries come back in seq order however the store lists them", async () => {
  const send = relay();
  const a0 = envelope(alice, bob, 0, null);
  const a1 = envelope(alice, bob, 1, hashOf(a0));
  await send(put(alice, 0, a0));
  await send(put(alice, 1, a1));
  await send(put(alice, 2, envelope(alice, bob, 2, hashOf(a1))));
  const res = await send(signedGet(`/inbox/${bob.pid}`, bob));
  assert.deepEqual(await json(res), { entries: [0, 1, 2].map((seq) => ({ from: alice.pid, seq })) });
});

test("an 'after' seq outside the route grammar is ignored, not trusted", async () => {
  const send = relay();
  await send(put(alice, 0, envelope(alice, bob, 0, null)));
  const res = await send(signedGet(`/inbox/${bob.pid}?after=${alice.pid}:${"9".repeat(24)}`, bob));
  assert.deepEqual(await json(res), { entries: [{ from: alice.pid, seq: 0 }] });
});

test("unknown routes and methods are 404 and 405", async () => {
  const send = relay();
  assert.equal((await send(new Request(`${BASE}/nope`))).status, 404);
  assert.equal((await send(new Request(`${BASE}/inbox/${bob.pid}`, { method: "DELETE" }))).status, 405);
});

test("an authorization claim with a malformed cert is 401, not a crash", async () => {
  const path = `/inbox/${bob.pid}`;
  const auth = signRequest({ method: "GET", host: HOST, path, ts: NOW.toISOString() }, { pid: bob.pid, signSec: bob.signSec, cert: { junk: true } as never });
  assert.equal((await relay()(new Request(`${BASE}${path}`, { headers: { authorization: auth } }))).status, 401);
});

function agentEnvelope(sentAt: Date, certIssued: Date): Uint8Array<ArrayBuffer> {
  const daemonKey = generateIdentity();
  const cert = issueCert(alice, { agentSignPub: daemonKey.signPub, name: "daemon", device: "laptop", now: certIssued });
  const sealed = seal({ from: alice, to: toPeer(bob), seq: 0, prev: null, ts: sentAt.toISOString(), body, agent: { signSec: daemonKey.signSec, cert } });
  assert.ok(sealed.ok);
  return sealed.wire;
}

test("agent mail stays readable after its cert expires: the cert is judged at send time", async () => {
  const store = memoryStore();
  assert.equal((await relay(store, NOW)(put(alice, 0, agentEnvelope(NOW, NOW)))).status, 201);
  const later = new Date(NOW.getTime() + 40 * 86_400_000);
  const fetched = await relay(store, later)(signedGet(`/log/${alice.pid}/0`, bob, later));
  assert.equal(fetched.status, 200);
});

test("an expired agent key cannot backdate an envelope into its cert's window", async () => {
  const expiredAt = new Date(NOW.getTime() - 40 * 86_400_000);
  const backdated = agentEnvelope(new Date(expiredAt.getTime() + 60_000), expiredAt);
  assert.equal((await relay()(put(alice, 0, backdated))).status, 401);
});

test("a current cert does not cover an envelope dated before the cert was issued", async () => {
  const before = new Date(NOW.getTime() - 86_400_000);
  assert.equal((await relay()(put(alice, 0, agentEnvelope(before, NOW)))).status, 401);
});

// ---- Relay identity ----

const RELAY_KEY = relayKeyFromSeed("A".repeat(43));

test("the relay describes itself, signed for its host and the client's challenge", async () => {
  const challenge = "fresh-challenge-0001";
  const res = await handle(new Request(`${BASE}/.well-known/agent-mailbox?challenge=${challenge}`), { store: memoryStore(), roots: allRoots, now: () => NOW, identity: RELAY_KEY });
  assert.equal(res.status, 200);
  const verified = verifyRelayDescription(await res.json(), HOST, challenge);
  assert.ok(verified.ok, JSON.stringify(verified));
  assert.equal(verified.relayKey, RELAY_KEY.publicKey);
});

test("a relay without its own key says so rather than describing itself", async () => {
  const res = await relay()(new Request(`${BASE}/.well-known/agent-mailbox?challenge=fresh-challenge-0001`));
  assert.deepEqual([res.status, await json(res)], [503, { error: "relay_has_no_key" }]);
});

test("a missing or malformed challenge is refused", async () => {
  const deps = { store: memoryStore(), roots: allRoots, now: () => NOW, identity: RELAY_KEY };
  assert.equal((await handle(new Request(`${BASE}/.well-known/agent-mailbox`), deps)).status, 400);
  assert.equal((await handle(new Request(`${BASE}/.well-known/agent-mailbox?challenge=short`), deps)).status, 400);
});
