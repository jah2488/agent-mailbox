import { test } from "node:test";
import assert from "node:assert/strict";
import { open, seal, type Body, type Opened } from "./envelope.ts";
import { generateIdentity, toPeer, type Identity } from "./identity.ts";
import {
  chainsOf,
  emptyState,
  ignoreThrough,
  knownHeads,
  markDelivered,
  nextLink,
  pendingDelivery,
  recordReceived,
  recordSealed,
  take,
  thread,
  unreadCount,
  type MailboxState,
} from "./mailbox.ts";

const alice = generateIdentity();
const bob = generateIdentity();
const carol = generateIdentity();
const ask = (ref: string, text = "status?"): Body => ({ tag: "ask", ref, payload: null, prose: text });

/** Alice seals her next message to `to` from her own state, the way the client will. */
function aliceSends(state: MailboxState, to: Identity, body: Body, ts = "2026-11-02T12:00:00Z"): MailboxState {
  const { seq, prev } = nextLink(state);
  const sealed = seal({ from: alice, to: toPeer(to), seq, prev, ts, body });
  assert.ok(sealed.ok);
  return recordSealed(state, { to: to.pid, ts, body, wire: sealed.wire });
}

/** Bob opens whatever alice sealed, against his own chain state. */
function bobOpens(state: MailboxState, wire: Uint8Array): Opened {
  const opened = open(wire, { me: bob, roster: new Map([alice, carol].map((id) => [id.pid, toPeer(id)])), chains: chainsOf(state) });
  assert.ok(opened.ok, opened.ok ? "" : opened.error);
  return opened;
}

test("the outbox is one chain across every recipient", () => {
  let state = emptyState;
  assert.deepEqual(nextLink(state), { seq: 0, prev: null });
  state = aliceSends(state, bob, ask("r1"));
  state = aliceSends(state, carol, ask("r2"));
  assert.deepEqual(state.outbox.map((m) => [m.seq, m.to]), [[0, bob.pid], [1, carol.pid]]);
  assert.equal(nextLink(state).seq, 2);
  assert.equal(nextLink(state).prev, state.outbox[1]!.hash);
});

test("sealed messages wait for delivery in seq order until marked", () => {
  let state = aliceSends(aliceSends(emptyState, bob, ask("r1")), bob, ask("r2"));
  assert.deepEqual(pendingDelivery(state).map((m) => m.seq), [0, 1]);
  state = markDelivered(state, 0);
  assert.deepEqual(pendingDelivery(state).map((m) => m.seq), [1]);
});

test("received envelopes extend the sender's chain and land unread", () => {
  const sent = aliceSends(emptyState, bob, ask("r1"));
  const wire = new TextEncoder().encode(sent.outbox[0]!.wire!);
  const received = recordReceived(emptyState, bobOpens(emptyState, wire), "2026-11-02T12:00:01Z");
  assert.equal(received.inbox.length, 1);
  assert.equal(received.inbox[0]!.from, alice.pid);
  assert.equal(received.inbox[0]!.consumed, false);
  assert.deepEqual(received.chains[alice.pid]?.recent.map((l) => l.seq), [0]);
  assert.equal(unreadCount(received), 1);
});

function bobWithMail(): MailboxState {
  let alices = emptyState;
  let bobs = emptyState;
  for (const body of [ask("r1", "one"), { tag: "status", ref: "r2", payload: null }, ask("r3", "three")] as Body[]) {
    alices = aliceSends(alices, bob, body);
    bobs = recordReceived(bobs, bobOpens(bobs, new TextEncoder().encode(alices.outbox.at(-1)!.wire!)), "2026-11-02T12:00:01Z");
  }
  return bobs;
}

test("take returns matching unread messages oldest first and consumes them", () => {
  const state = bobWithMail();
  const asks = take(state, { tag: "ask" });
  assert.deepEqual(asks.messages.map((m) => m.body.ref), ["r1", "r3"]);
  assert.equal(unreadCount(asks.state), 1);
  assert.deepEqual(take(asks.state, { tag: "ask" }).messages, []);
  assert.deepEqual(take(asks.state, {}).messages.map((m) => m.body.ref), ["r2"]);
});

test("take matches on sender and reply_to, and leaves others untouched", () => {
  const state = bobWithMail();
  assert.equal(take(state, { from: carol.pid }).messages.length, 0);
  assert.equal(take(state, { from: alice.pid }).messages.length, 3);
  assert.equal(take(state, { reply_to: "nope" }).messages.length, 0);
});

test("a thread holds sent and received messages in local order, even when the sender's clock runs behind", () => {
  let alices = aliceSends(emptyState, bob, ask("q1"), "2026-11-02T12:00:00Z");
  // Bob's clock is ten minutes slow: his reply claims to predate the ask.
  const reply = seal({ from: bob, to: toPeer(alice), seq: 0, prev: null, ts: "2026-11-02T11:50:00Z", body: { tag: "reply", ref: "a1", reply_to: "q1", payload: null, prose: "on it" } });
  assert.ok(reply.ok);
  const opened = open(reply.wire, { me: alice, roster: new Map([[bob.pid, toPeer(bob)]]), chains: new Map() });
  assert.ok(opened.ok);
  alices = recordReceived(alices, opened, "2026-11-02T12:01:00Z");
  alices = take(alices, {}).state;
  assert.deepEqual(thread(alices, "q1").map((m) => [m.from, m.body.tag]), [[alice.pid, "ask"], [bob.pid, "reply"]]);
  assert.deepEqual(thread(alices, "unknown"), []);
});

test("take with nothing to hand out returns the same state, so callers can skip the write", () => {
  const state = bobWithMail();
  assert.equal(take(state, { tag: "nothing-matches" }).state, state);
});

test("delivered messages drop their stored bytes; pending ones keep them for retry", () => {
  const state = aliceSends(aliceSends(emptyState, bob, ask("r1")), bob, ask("r2"));
  const delivered = markDelivered(state, 0);
  assert.equal(delivered.outbox[0]!.wire, null);
  assert.equal(typeof delivered.outbox[1]!.wire, "string");
});

test("ignored senders contribute a head, so their old mail is never listed again", () => {
  const sent = aliceSends(emptyState, bob, ask("r1"));
  const received = recordReceived(emptyState, bobOpens(emptyState, new TextEncoder().encode(sent.outbox[0]!.wire!)), "2026-11-02T12:00:01Z");
  const withIgnored = ignoreThrough(received, carol.pid, 7);
  assert.deepEqual(knownHeads(withIgnored), { [alice.pid]: 0, [carol.pid]: 7 });
  assert.deepEqual(knownHeads(ignoreThrough(withIgnored, carol.pid, 3)), { [alice.pid]: 0, [carol.pid]: 7 });
});

test("state survives a JSON round trip, because it lives on disk", () => {
  const state = bobWithMail();
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});
