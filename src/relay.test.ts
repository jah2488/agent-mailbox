import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity, toPeer, type Identity, type Peer, type Pid } from "./identity.ts";
import { hashOf, seal, type Body, type Hash } from "./envelope.ts";
import { signRequest } from "./request-auth.ts";
import { handle, type Store } from "./relay.ts";

const alice = generateIdentity();
const bob = generateIdentity();
const mallory = generateIdentity();
const stranger = generateIdentity();

const BASE = "https://relay.test";
const NOW = new Date("2026-11-02T12:00:00Z");
const body: Body = { tag: "ask", ref: "01JREF", payload: { q: "status?" } };

function memoryStore(): Store {
  const data = new Map<string, Uint8Array<ArrayBuffer>>();
  return {
    get: async (key) => data.get(key) ?? null,
    createOnly: async (key, value) => {
      if (data.has(key)) return false;
      data.set(key, value);
      return true;
    },
    list: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

function relay(store: Store = memoryStore(), now: Date = NOW) {
  const roots: ReadonlyMap<Pid, Peer> = new Map([alice, bob, mallory].map((id) => [id.pid, toPeer(id)]));
  return (req: Request) => handle(req, { store, roots, now: () => now });
}

function envelope(from: Identity, to: Identity, seq: number, prev: Hash | null): Uint8Array<ArrayBuffer> {
  const sealed = seal({ from, to: toPeer(to), seq, prev, ts: NOW.toISOString(), body });
  assert.ok(sealed.ok);
  return sealed.wire;
}

const put = (from: Identity, seq: number, wire: Uint8Array<ArrayBuffer>) =>
  new Request(`${BASE}/log/${from.pid}/${seq}`, { method: "PUT", body: wire, headers: { "content-type": "application/json" } });

function signedGet(path: string, as: Identity, at: Date = NOW, nonce?: string): Request {
  const auth = signRequest({ method: "GET", path, ts: at.toISOString(), ...(nonce ? { nonce } : {}) }, as);
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

test("a signed request for one path cannot be reused on another", async () => {
  const send = relay();
  const auth = signRequest({ method: "GET", path: `/inbox/${bob.pid}`, ts: NOW.toISOString() }, bob);
  const res = await send(new Request(`${BASE}/log/${alice.pid}/0`, { headers: { authorization: auth } }));
  assert.equal(res.status, 401);
});

test("only the sender or the recipient can fetch an envelope", async () => {
  const send = relay();
  await send(put(alice, 0, envelope(alice, bob, 0, null)));
  assert.equal((await send(signedGet(`/log/${alice.pid}/0`, mallory))).status, 403);
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
  const auth = signRequest({ method: "POST", path, ts: NOW.toISOString() }, bob);
  assert.equal((await relay()(new Request(`${BASE}${path}`, { headers: { authorization: auth } }))).status, 401);
});

test("a request whose signed fields were altered is refused", async () => {
  const path = `/inbox/${bob.pid}`;
  const auth = signRequest({ method: "GET", path, ts: NOW.toISOString() }, bob);
  const claim = JSON.parse(Buffer.from(auth.slice("AgentMailbox ".length), "base64url").toString()) as Record<string, string>;
  const altered = { ...claim, t: new Date(NOW.getTime() + 1000).toISOString() };
  const forged = "AgentMailbox " + Buffer.from(JSON.stringify(altered)).toString("base64url");
  assert.equal((await relay()(new Request(`${BASE}${path}`, { headers: { authorization: forged } }))).status, 401);
});

test("unknown routes and methods are 404 and 405", async () => {
  const send = relay();
  assert.equal((await send(new Request(`${BASE}/nope`))).status, 404);
  assert.equal((await send(new Request(`${BASE}/inbox/${bob.pid}`, { method: "DELETE" }))).status, 405);
});
