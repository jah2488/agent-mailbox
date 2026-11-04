import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity, type Pid } from "./identity.ts";
import { applyEvent, checkEvent, isAdmitted, isGuest, parseJoinRule, signEvent, type MemberRecord, type MembershipEvent } from "./membership.ts";
import { rootEntry } from "./roots.ts";

const founder = generateIdentity();
const admin = generateIdentity();
const newcomer = generateIdentity();
const other = generateIdentity();
const HOST = "relay.example";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const event = (kind: MembershipEvent["kind"], by: typeof founder, who = newcomer, ts = at(0)): MembershipEvent => ({ v: 1, kind, relay: HOST, member: rootEntry(who), by: by.pid, ts });
const vouch = (by: typeof founder, who = newcomer, ts = at(0)) => event("vouch", by, who, ts);

/** Applies events in order, as the relay does one request at a time; a refused event leaves the record as it was. */
function replay(events: readonly MembershipEvent[], admins: ReadonlySet<string> = new Set([admin.pid])): MemberRecord | undefined {
  let record: MemberRecord | undefined;
  for (const e of events) {
    const applied = applyEvent(record, e, admins.has(e.by));
    if (applied.ok) record = applied.record;
  }
  return record;
}

test("join rules parse, defaulting to any member", () => {
  assert.deepEqual(parseJoinRule(undefined), { kind: "any-member" });
  assert.deepEqual(parseJoinRule("admins"), { kind: "admins" });
  assert.deepEqual(parseJoinRule("vouches:2"), { kind: "vouches", count: 2 });
  assert.deepEqual(parseJoinRule("closed"), { kind: "closed" });
  assert.equal(parseJoinRule("vouches:0"), null);
  assert.equal(parseJoinRule("everyone"), null);
});

test("one vouch admits under any-member; vouches:2 needs two different members", () => {
  assert.equal(isAdmitted(replay([vouch(founder)]), { kind: "any-member" }), true);
  assert.equal(isAdmitted(replay([vouch(founder)]), { kind: "vouches", count: 2 }), false);
  assert.equal(isAdmitted(replay([vouch(founder), vouch(founder)]), { kind: "vouches", count: 2 }), false, "the same member twice is one vouch");
  assert.equal(isAdmitted(replay([vouch(founder), vouch(other)]), { kind: "vouches", count: 2 }), true);
  assert.equal(isAdmitted(replay([vouch(founder)]), { kind: "closed" }), false);
});

test("a voucher withdrawing takes their vouch back; others' vouches still count", () => {
  assert.equal(isAdmitted(replay([vouch(founder), event("withdraw", founder)]), { kind: "any-member" }), false);
  assert.equal(isAdmitted(replay([vouch(founder), vouch(other), event("withdraw", founder)]), { kind: "any-member" }), true);
});

test("an admin's removal sticks: a member's later vouch is refused, an admin's re-admits", () => {
  const removed = replay([vouch(founder), event("remove", admin)]);
  assert.equal(isAdmitted(removed, { kind: "any-member" }), false);
  assert.deepEqual(applyEvent(removed, vouch(other), false), { ok: false, status: 403, error: "removed_by_admin" });
  const back = applyEvent(removed, vouch(admin), true);
  assert.ok(back.ok);
  assert.equal(isAdmitted(back.record, { kind: "any-member" }), true);
});

const ctx = (rule = parseJoinRule(undefined)!) => ({
  host: HOST,
  now: NOW,
  rule,
  members: new Map<Pid, typeof founder>([[founder.pid, founder], [admin.pid, admin]]),
  founders: new Set<Pid>([founder.pid, admin.pid]),
  admins: new Set<Pid>([admin.pid]),
});

test("an event is accepted only when signed by a current member, for this relay, recently, with an exact ISO time", () => {
  assert.deepEqual(checkEvent(signEvent(vouch(founder), founder.signSec), ctx()), { ok: true, event: vouch(founder) });
  assert.deepEqual(checkEvent(signEvent(vouch(other), other.signSec), ctx()), { ok: false, status: 403, error: "not_a_member" });
  assert.deepEqual(checkEvent(signEvent(vouch(founder), other.signSec), ctx()), { ok: false, status: 401, error: "bad_signature" });
  assert.deepEqual(checkEvent(signEvent({ ...vouch(founder), relay: "elsewhere.example" }, founder.signSec), ctx()), { ok: false, status: 400, error: "wrong_relay" });
  assert.deepEqual(checkEvent(signEvent(vouch(founder, newcomer, at(-30)), founder.signSec), ctx()), { ok: false, status: 400, error: "stale" });
  for (const ts of ["Tue Nov 10 2026 12:00:00 GMT+0000", "2026-11-10T12:00:00Z/../x", "2026-11-10"]) {
    assert.deepEqual(checkEvent(signEvent(vouch(founder, newcomer, ts), founder.signSec), ctx()), { ok: false, status: 400, error: "malformed" }, ts);
  }
});

test("the join rule and roles decide who may vouch and remove; founders can't be withdrawn or removed by event", () => {
  assert.deepEqual(checkEvent(signEvent(vouch(founder), founder.signSec), ctx({ kind: "admins" })), { ok: false, status: 403, error: "admins_only" });
  assert.equal(checkEvent(signEvent(vouch(admin), admin.signSec), ctx({ kind: "admins" })).ok, true);
  assert.deepEqual(checkEvent(signEvent(vouch(admin), admin.signSec), ctx({ kind: "closed" })), { ok: false, status: 403, error: "join_closed" });
  assert.deepEqual(checkEvent(signEvent(event("remove", founder), founder.signSec), ctx()), { ok: false, status: 403, error: "admins_only" });
  assert.equal(checkEvent(signEvent(event("remove", admin), admin.signSec), ctx()).ok, true);
  assert.deepEqual(checkEvent(signEvent(event("remove", admin, founder), admin.signSec), ctx()), { ok: false, status: 400, error: "is_founder" });
  assert.deepEqual(checkEvent(signEvent(event("withdraw", admin, founder), admin.signSec), ctx()), { ok: false, status: 400, error: "is_founder" });
});

test("vouching for someone who's already a member is a verified no-op, whatever the join rule", () => {
  const already = { ...ctx({ kind: "closed" }), members: new Map([...ctx().members, [newcomer.pid, newcomer]]) };
  assert.deepEqual(checkEvent(signEvent(vouch(founder), founder.signSec), already), { ok: true, event: vouch(founder), alreadyMember: true });
  assert.deepEqual(checkEvent(signEvent(vouch(founder), other.signSec), already), { ok: false, status: 401, error: "bad_signature" });
});

test("hosting makes a guest, not a member; unhosting and an admin's removal take it back", () => {
  const anyMember = { kind: "any-member" } as const;
  const hosted = replay([event("host", founder)]);
  assert.equal(isAdmitted(hosted, anyMember), false, "a guest is never a member");
  assert.equal(isGuest(hosted, anyMember), true);
  assert.equal(isGuest(replay([event("host", founder), event("unhost", founder)]), anyMember), false);
  assert.equal(isGuest(replay([event("host", founder), event("host", other), event("unhost", founder)]), anyMember), true, "another host still counts");
  const removed = replay([event("host", founder), event("remove", admin)]);
  assert.equal(isGuest(removed, anyMember), false);
  assert.deepEqual(applyEvent(removed, event("host", other), false), { ok: false, status: 403, error: "removed_by_admin" });
  assert.equal(isGuest(replay([event("host", founder)]), { kind: "closed" }), false);
  assert.equal(isAdmitted(replay([event("host", founder), vouch(other)]), anyMember), true, "a vouch still admits a guest as a member");
});

test("records written before guests existed still read as having no hosts", () => {
  const old = { member: rootEntry(newcomer), vouchers: [founder.pid], removed: false } as unknown as MemberRecord;
  const twoVouches = { kind: "vouches", count: 2 } as const;
  assert.equal(isGuest(old, twoVouches), false);
  const hosted = applyEvent(old, event("host", other), false);
  assert.ok(hosted.ok);
  assert.equal(isGuest(hosted.record, twoVouches), true);
  assert.deepEqual(hosted.record.vouchers, [founder.pid], "hosting leaves existing vouches alone");
});

test("any member may host whatever the join rule, except on a closed relay; founders can't be unhosted", () => {
  assert.equal(checkEvent(signEvent(event("host", founder), founder.signSec), ctx({ kind: "admins" })).ok, true);
  assert.equal(checkEvent(signEvent(event("host", founder), founder.signSec), ctx({ kind: "vouches", count: 3 })).ok, true);
  assert.deepEqual(checkEvent(signEvent(event("host", founder), founder.signSec), ctx({ kind: "closed" })), { ok: false, status: 403, error: "join_closed" });
  assert.deepEqual(checkEvent(signEvent(event("unhost", admin, founder), admin.signSec), ctx()), { ok: false, status: 400, error: "is_founder" });
  const already = { ...ctx(), members: new Map([...ctx().members, [newcomer.pid, newcomer]]) };
  assert.deepEqual(checkEvent(signEvent(event("host", founder), founder.signSec), already), { ok: true, event: event("host", founder), alreadyMember: true });
});

test("an admin's removal ends hosting for good: an admin's later vouch doesn't bring old hosts back", () => {
  const twoVouches = { kind: "vouches", count: 2 } as const;
  assert.equal(isGuest(replay([event("host", founder), event("remove", admin), vouch(admin)]), twoVouches), false);
  assert.equal(isGuest(replay([event("host", founder), vouch(other)]), { kind: "any-member" }), false, "a member is never also a guest");
});
