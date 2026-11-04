import { test } from "node:test";
import assert from "node:assert/strict";
import type { Body } from "./envelope.ts";
import { generateIdentity, type Pid } from "./identity.ts";
import { emptyState, type Inbound, type MailboxState, type Outbound } from "./mailbox.ts";
import { checkPromiseBody, ledger } from "./promises.ts";

const me = generateIdentity().pid;
const ada = generateIdentity().pid;
const NOW = new Date("2026-11-10T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

const inbound = (seq: number, body: Body, ts = day(-1)): Inbound => ({
  from: ada, to: me, seq, hash: "b2:00" as never, ts, body, consumed: true, receivedAt: ts, via: { kind: "owner" }, hops: 0,
});
const outbound = (seq: number, body: Body, ts = day(-1)): Outbound => ({ from: me, to: ada, seq, hash: "b2:00" as never, ts, body, wire: null, delivered: true });
const promise = (item: string, extra: Record<string, string> = {}): Body => ({ tag: "promise", ref: `p-${item}`, reply_to: "ask-1", payload: { item, ...extra } });
const close = (tag: "fulfil" | "break", item: string, extra: Record<string, string> = {}): Body => ({ tag, ref: `${tag}-${item}`, reply_to: "ask-1", payload: { item, ...extra } });
const state = (inbox: Inbound[], outbox: Outbound[] = []): MailboxState => ({ ...emptyState, inbox, outbox });

test("a promise someone made me stays open until they fulfil or break it", () => {
  const owed = ledger(state([inbound(0, promise("prod keys", { condition: "when gtm-slack ships" }))]), me, NOW).owed;
  assert.deepEqual(owed.map((p) => [p.counterparty, p.item, p.condition, p.status]), [[ada, "prod keys", "when gtm-slack ships", "open"]]);

  const kept = ledger(state([inbound(0, promise("prod keys")), inbound(1, close("fulfil", "prod keys"))]), me, NOW).owed;
  assert.equal(kept[0]!.status, "fulfilled");
  const broken = ledger(state([inbound(0, promise("prod keys")), inbound(1, close("break", "prod keys", { reason: "keys rotated" }))]), me, NOW).owed;
  assert.deepEqual([broken[0]!.status, broken[0]!.reason], ["broken", "keys rotated"]);
});

test("promises I made are listed separately from promises made to me", () => {
  const l = ledger(state([inbound(0, promise("theirs"))], [outbound(0, promise("mine"))]), me, NOW);
  assert.deepEqual(l.made.map((p) => [p.counterparty, p.item]), [[ada, "mine"]]);
  assert.deepEqual(l.owed.map((p) => [p.counterparty, p.item]), [[ada, "theirs"]]);
});

test("the highest-seq status from the promiser wins, whatever order the messages are listed in", () => {
  const l = ledger(state([inbound(2, close("break", "x")), inbound(0, promise("x")), inbound(1, close("fulfil", "x"))]), me, NOW);
  assert.equal(l.owed[0]!.status, "broken");
});

test("only the promiser can close a promise: my fulfil of their promise changes nothing", () => {
  const l = ledger(state([inbound(0, promise("theirs"))], [outbound(0, close("fulfil", "theirs"))]), me, NOW);
  assert.equal(l.owed[0]!.status, "open");
});

test("an open promise past its due date is overdue; one with no due date goes stale after 30 days", () => {
  const l = ledger(
    state([], [outbound(0, promise("late", { due: day(-2) })), outbound(1, promise("soon", { due: day(3) })), outbound(2, promise("forgotten"), day(-31))]),
    me,
    NOW,
  );
  assert.deepEqual(l.made.map((p) => [p.item, p.overdue, p.stale]), [["late", true, false], ["soon", false, false], ["forgotten", false, true]]);
  assert.equal(ledger(state([], [outbound(0, promise("late", { due: day(-2) })), outbound(1, close("fulfil", "late"))]), me, NOW).made[0]!.overdue, false);
});

test("a promise, fulfil or break must name the ask and the item; a promise's due must be a date", () => {
  assert.equal(checkPromiseBody("promise", "ask-1", { item: "keys", due: "2026-11-20" }), null);
  assert.match(checkPromiseBody("promise", undefined, { item: "keys" }) ?? "", /reply_to/);
  assert.match(checkPromiseBody("fulfil", "ask-1", { note: "done" }) ?? "", /payload\.item/);
  assert.match(checkPromiseBody("promise", "ask-1", { item: "keys", due: "next week" }) ?? "", /due/);
  assert.equal(checkPromiseBody("ask", undefined, null), null, "other tags aren't promise messages");
});

test("a date-only due date is overdue only once that whole day has passed, wherever the user is", () => {
  const dueToday = NOW.toISOString().slice(0, 10);
  const l = ledger(state([], [outbound(0, promise("today", { due: dueToday })), outbound(1, promise("yesterday", { due: day(-1).slice(0, 10) }))]), me, NOW);
  assert.deepEqual(l.made.map((p) => [p.item, p.overdue]), [["today", false], ["yesterday", false]]);
  const l2 = ledger(state([], [outbound(0, promise("old", { due: day(-2).slice(0, 10) }))]), me, NOW);
  assert.equal(l2.made[0]!.overdue, true);
});
