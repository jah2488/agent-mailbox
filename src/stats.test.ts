import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuditEntry } from "./audit.ts";
import type { Body, Via } from "./envelope.ts";
import { generateIdentity } from "./identity.ts";
import { emptyState, type Inbound, type MailboxState, type Outbound } from "./mailbox.ts";
import { daemonReplies, gradeKey, stats } from "./stats.ts";

const me = generateIdentity().pid;
const ada = generateIdentity().pid;
const NOW = new Date("2026-11-20T12:00:00Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();
const SINCE = day(-14);

const body = (tag: string, ref: string, extra: Partial<Body> = {}): Body => ({ tag, ref, payload: null, ...extra });
const inbound = (seq: number, b: Body, at = day(-1), via: Via = { kind: "owner" }): Inbound => ({
  from: ada, to: me, seq, hash: "b2:00" as never, ts: at, body: b, consumed: true, receivedAt: at, via, hops: 0,
});
const outbound = (seq: number, b: Body, at = day(-1)): Outbound => ({ from: me, to: ada, seq, hash: "b2:00" as never, ts: at, body: b, wire: null, delivered: true });
const state = (inbox: Inbound[], outbox: Outbound[]): MailboxState => ({ ...emptyState, inbox, outbox });
const reply = (ref: string, to: string, extra: Partial<Body> = {}) => body("reply", ref, { reply_to: to, ...extra });
const audit = (seq: number, kind: string, data: Record<string, unknown>): AuditEntry => ({ seq, prev: null, ts: day(-1), kind, data: data as never });

test("asks I received are split by who answered: me, my daemon, deferred to me, or nobody yet", () => {
  const s = stats({
    state: state(
      [inbound(0, body("ask", "a1")), inbound(1, body("ask", "a2")), inbound(2, body("ask", "a3")), inbound(3, body("ask", "a4")), inbound(4, body("ask", "a5"))],
      [outbound(0, reply("r1", "a1")), outbound(1, reply("r2", "a2")), outbound(2, reply("r3", "a3", { payload: { status: "deferred" } })), outbound(3, reply("r5d", "a5", { payload: { status: "deferred" } })), outbound(4, reply("r5", "a5"))],
    ),
    me,
    daemon: [{ from: ada, ref: "a2", status: "answered", reply: "r2" }, { from: ada, ref: "a3", status: "deferred", reply: "r3" }, { from: ada, ref: "a5", status: "deferred", reply: "r5d" }],
    grades: {},
    since: SINCE,
    now: NOW,
  });
  // a5: the daemon deferred it, then I answered it myself, so it counts as mine.
  assert.deepEqual(s.received, { asks: 5, byPerson: 2, byAgent: 1, deferred: 1, unanswered: 1 });
});

test("asks I sent are split by whether the person, their agent, or a deferral came back", () => {
  const s = stats({
    state: state(
      [inbound(0, reply("x1", "s1")), inbound(1, reply("x2", "s2"), day(-1), { kind: "agent", name: "daemon" }), inbound(2, reply("x3", "s3", { payload: { status: "deferred" } }), day(-1), { kind: "agent", name: "daemon" })],
      [outbound(0, body("ask", "s1")), outbound(1, body("ask", "s2")), outbound(2, body("ask", "s3")), outbound(3, body("ask", "s4"))],
    ),
    me,
    daemon: [],
    grades: {},
    since: SINCE,
    now: NOW,
  });
  assert.deepEqual(s.sent, { asks: 4, byPerson: 1, byAgent: 1, deferred: 1, unanswered: 1 });
});

test("a reply stored before messages recorded via came from the person, since agents didn't exist yet", () => {
  const { via: _via, ...legacy } = inbound(0, reply("x1", "s1"));
  const s = stats({ state: state([legacy as Inbound], [outbound(0, body("ask", "s1"))]), me, daemon: [], grades: {}, since: SINCE, now: NOW });
  assert.equal(s.sent.byPerson, 1);
});

test("only asks inside the window count", () => {
  const s = stats({ state: state([inbound(0, body("ask", "old"), day(-20)), inbound(1, body("ask", "new"))], [outbound(0, body("ask", "mine-old"), day(-15))]), me, daemon: [], grades: {}, since: SINCE, now: NOW });
  assert.equal(s.received.asks, 1);
  assert.equal(s.sent.asks, 0);
});

test("promises I made in the window are counted by status, overdue among the open", () => {
  const promise = (ref: string, item: string, extra: Record<string, string> = {}) => body("promise", ref, { reply_to: "a1", payload: { item, ...extra } });
  const s = stats({
    state: state([], [outbound(0, promise("p1", "keys")), outbound(1, body("fulfil", "f1", { reply_to: "a1", payload: { item: "keys" } })), outbound(2, promise("p2", "doc", { due: day(-3) })), outbound(3, promise("p3", "demo")), outbound(4, body("break", "b3", { reply_to: "a1", payload: { item: "demo" } }))]),
    me,
    daemon: [],
    grades: {},
    since: SINCE,
    now: NOW,
  });
  assert.deepEqual(s.promises, { made: 3, kept: 1, broken: 1, open: 1, overdue: 1 });
});

test("grading counts only my daemon's answers in the window", () => {
  const s = stats({
    state: state([inbound(0, body("ask", "a1")), inbound(1, body("ask", "a2")), inbound(2, body("ask", "a3")), inbound(3, body("ask", "a4"), day(-20))], []),
    me,
    daemon: [
      { from: ada, ref: "a1", status: "answered", reply: "r1" },
      { from: ada, ref: "a2", status: "answered", reply: "r2" },
      { from: ada, ref: "a3", status: "deferred", reply: "r3" },
      { from: ada, ref: "a4", status: "answered", reply: "r4" },
    ],
    grades: { [gradeKey(ada, "a1")]: "right", [gradeKey(ada, "a3")]: "wrong", [gradeKey(ada, "a4")]: "wrong" },
    since: SINCE,
    now: NOW,
  });
  assert.deepEqual(s.grading, { answered: 2, right: 1, wrong: 0, ungraded: 1 });
});

test("daemon replies are read from reply_sent audit entries only", () => {
  const entries = [
    audit(0, "decision", { ref: "a1", from: ada, outcome: "ask-model" }),
    audit(1, "reply_sent", { ref: "a1", from: ada, status: "answered", reply: "r1", delivered: true }),
    audit(2, "error", { ref: "a2", from: ada, error: "boom" }),
    audit(3, "reply_sent", { ref: "a3", from: ada, status: "deferred", reason: "no file", reply: "r3", delivered: false }),
  ];
  assert.deepEqual(daemonReplies(entries), [
    { from: ada, ref: "a1", status: "answered", reply: "r1" },
    { from: ada, ref: "a3", status: "deferred", reply: "r3" },
  ]);
});
