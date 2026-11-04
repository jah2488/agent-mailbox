import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity, type Pid } from "./identity.ts";
import { admitted, checkEvent, parseJoinRule, signEvent, type MembershipEvent } from "./membership.ts";
import { rootEntry } from "./roots.ts";

const founder = generateIdentity();
const admin = generateIdentity();
const newcomer = generateIdentity();
const other = generateIdentity();
const HOST = "relay.example";
const NOW = new Date("2026-11-10T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const vouch = (by: typeof founder, who = newcomer, ts = at(0)): MembershipEvent => ({ v: 1, kind: "vouch", relay: HOST, member: rootEntry(who), by: by.pid, ts });
const withdraw = (by: typeof founder, ts: string): MembershipEvent => ({ v: 1, kind: "withdraw", relay: HOST, member: rootEntry(newcomer), by: by.pid, ts });
const remove = (by: typeof founder, ts: string): MembershipEvent => ({ v: 1, kind: "remove", relay: HOST, member: rootEntry(newcomer), by: by.pid, ts });

test("join rules parse, defaulting to any member", () => {
  assert.deepEqual(parseJoinRule(undefined), { kind: "any-member" });
  assert.deepEqual(parseJoinRule("admins"), { kind: "admins" });
  assert.deepEqual(parseJoinRule("vouches:2"), { kind: "vouches", count: 2 });
  assert.deepEqual(parseJoinRule("closed"), { kind: "closed" });
  assert.equal(parseJoinRule("vouches:0"), null);
  assert.equal(parseJoinRule("everyone"), null);
});

test("one vouch admits under any-member; vouches:2 needs two different members", () => {
  assert.deepEqual([...admitted([vouch(founder)], { kind: "any-member" }).keys()], [newcomer.pid]);
  assert.deepEqual([...admitted([vouch(founder)], { kind: "vouches", count: 2 }).keys()], []);
  assert.deepEqual([...admitted([vouch(founder), vouch(founder, newcomer, at(1))], { kind: "vouches", count: 2 }).keys()], [], "the same member twice is one vouch");
  assert.deepEqual([...admitted([vouch(founder), vouch(admin, newcomer, at(1))], { kind: "vouches", count: 2 }).keys()], [newcomer.pid]);
});

test("a voucher withdrawing, or an admin removing, takes the member out; a later vouch brings them back", () => {
  const rule = { kind: "any-member" } as const;
  assert.equal(admitted([vouch(founder), withdraw(founder, at(1))], rule).size, 0);
  assert.equal(admitted([vouch(founder), remove(admin, at(1))], rule).size, 0);
  assert.equal(admitted([vouch(founder), remove(admin, at(1)), vouch(other, newcomer, at(2))], rule).size, 1);
  assert.equal(admitted([withdraw(founder, at(1)), vouch(founder)], rule).size, 0, "events apply in time order, not listing order");
});

const ctx = (rule = parseJoinRule(undefined)!) => ({
  host: HOST,
  now: NOW,
  rule,
  members: new Map<Pid, typeof founder>([[founder.pid, founder], [admin.pid, admin]]),
  admins: new Set([admin.pid]),
});

test("a vouch is accepted only when signed by a current member, for this relay, recently", () => {
  assert.deepEqual(checkEvent(signEvent(vouch(founder), founder.signSec), ctx()), { ok: true, event: vouch(founder) });
  assert.deepEqual(checkEvent(signEvent(vouch(other), other.signSec), ctx()), { ok: false, status: 403, error: "not_a_member" });
  assert.deepEqual(checkEvent(signEvent(vouch(founder), other.signSec), ctx()), { ok: false, status: 401, error: "bad_signature" });
  assert.deepEqual(checkEvent(signEvent({ ...vouch(founder), relay: "elsewhere.example" }, founder.signSec), ctx()), { ok: false, status: 400, error: "wrong_relay" });
  assert.deepEqual(checkEvent(signEvent(vouch(founder, newcomer, at(-30)), founder.signSec), ctx()), { ok: false, status: 400, error: "stale" });
});

test("the relay's join rule and roles decide who may vouch, withdraw and remove", () => {
  assert.deepEqual(checkEvent(signEvent(vouch(founder), founder.signSec), ctx({ kind: "admins" })), { ok: false, status: 403, error: "admins_only" });
  assert.equal(checkEvent(signEvent(vouch(admin), admin.signSec), ctx({ kind: "admins" })).ok, true);
  assert.deepEqual(checkEvent(signEvent(vouch(admin), admin.signSec), ctx({ kind: "closed" })), { ok: false, status: 403, error: "join_closed" });
  assert.deepEqual(checkEvent(signEvent(remove(founder, at(0)), founder.signSec), ctx()), { ok: false, status: 403, error: "admins_only" });
  assert.equal(checkEvent(signEvent(remove(admin, at(0)), admin.signSec), ctx()).ok, true);
  assert.equal(checkEvent(signEvent(withdraw(founder, at(0)), founder.signSec), ctx()).ok, true);
});
