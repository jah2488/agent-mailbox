import { test } from "node:test";
import assert from "node:assert/strict";
import { findSecrets, planAnswer, settleAnswer, unanswered } from "./daemon-core.ts";
import { generateIdentity } from "./identity.ts";
import { emptyState, type Inbound, type MailboxState, type Outbound } from "./mailbox.ts";
import { DEFAULT_POLICY } from "./policy.ts";

const me = generateIdentity();
const ada = generateIdentity();
const stranger = generateIdentity();
const contacts = new Set([ada.pid]);
const files = [
  { path: "status/today.md", content: "Shipping the daemon." },
  { path: "notes/plan.md", content: "Plan: launchd next." },
  { path: "notes/secret-salary.md", content: "nope" },
  { path: "drafts/x.md", content: "unshared" },
];

const ask = (over: Partial<Inbound> = {}, body: Partial<Inbound["body"]> = {}): Inbound => ({
  from: ada.pid,
  to: me.pid,
  seq: 0,
  hash: "b2:00" as never,
  ts: "2026-11-02T12:00:00Z",
  receivedAt: "2026-11-02T12:00:01Z",
  consumed: false,
  via: { kind: "owner" },
  hops: 0,
  ...over,
  body: { tag: "ask", ref: "q1", payload: null, prose: "what are you on?", ...body },
});

const ctx = { policy: DEFAULT_POLICY, contacts, files, owner: "Justin", askerName: "Ada" };

test("an ask is answered only from files policy allows, and flagged if any of them is flag-tier", () => {
  const plan = planAnswer(ask(), ctx);
  assert.equal(plan.kind, "ask-model");
  if (plan.kind !== "ask-model") return;
  assert.deepEqual(plan.files.map((f) => f.path), ["notes/plan.md", "status/today.md"].sort());
  assert.equal(plan.flagged, true);
  assert.ok(!plan.prompt.includes("unshared") && !plan.prompt.includes("nope"));
});

test("an asker policy gives nothing to defers without calling the model", () => {
  const plan = planAnswer(ask({ from: stranger.pid }), { ...ctx, contacts: new Set() });
  assert.deepEqual(plan, { kind: "defer", reason: "nothing you share covers this asker" });
});

test("the daemon answers asks only: never replies, never agents, never forwarded mail", () => {
  assert.equal(planAnswer(ask({}, { tag: "reply" }), ctx).kind, "ignore");
  assert.equal(planAnswer(ask({ via: { kind: "agent", name: "daemon" } }), ctx).kind, "ignore");
  assert.equal(planAnswer(ask({ hops: 1 }), ctx).kind, "ignore");
});

test("a drafted answer carrying something secret-shaped becomes a defer", () => {
  assert.deepEqual(settleAnswer({ kind: "answer", text: "Shipping. Key AKIAIOSFODNN7EXAMPLE" }), { kind: "defer", reason: "the drafted answer looked like it contained a secret (aws access key)" });
  assert.deepEqual(settleAnswer({ kind: "answer", text: "Shipping the daemon." }), { kind: "answer", text: "Shipping the daemon." });
  assert.deepEqual(settleAnswer({ kind: "defer", reason: "not covered" }), { kind: "defer", reason: "not covered" });
});

test("secret patterns cover keys and tokens, and leave ordinary prose alone", () => {
  assert.deepEqual(findSecrets("-----BEGIN OPENSSH PRIVATE KEY-----"), ["private key"]);
  assert.deepEqual(findSecrets("token ghp_" + "a".repeat(36)), ["github token"]);
  assert.deepEqual(findSecrets("xoxb-1234567890-abcdefghij"), ["slack token"]);
  assert.deepEqual(findSecrets("We shipped the relay and the CLI today."), []);
});

test("unanswered asks are those from others after the daemon started, with no reply of mine", () => {
  const replied: Outbound = { from: me.pid, to: ada.pid, seq: 0, hash: "b2:01" as never, ts: "t", wire: null, delivered: true, body: { tag: "reply", ref: "r", reply_to: "q1", payload: null } };
  const state: MailboxState = {
    ...emptyState,
    inbox: [
      ask({ receivedAt: "2026-11-02T11:00:00Z" }, { ref: "old" }),
      ask({}, { ref: "q1" }),
      ask({}, { ref: "q2" }),
      ask({}, { ref: "q3", tag: "status" }),
    ],
    outbox: [replied],
  };
  assert.deepEqual(unanswered(state, { me: me.pid, since: "2026-11-02T11:30:00Z" }).map((m) => m.body.ref), ["q2"]);
});

test("a reply to one asker does not count as answering another asker who chose the same ref", () => {
  const other = generateIdentity();
  const replied: Outbound = { from: me.pid, to: ada.pid, seq: 0, hash: "b2:01" as never, ts: "t", wire: null, delivered: true, body: { tag: "reply", ref: "r", reply_to: "q1", payload: null } };
  const state: MailboxState = { ...emptyState, inbox: [ask({}, { ref: "q1" }), ask({ from: other.pid }, { ref: "q1" })], outbox: [replied] };
  assert.deepEqual(unanswered(state, { me: me.pid, since: "2026-11-02T11:30:00Z" }).map((m) => m.from), [other.pid]);
});
