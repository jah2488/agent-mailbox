import { canonicalize } from "./canonical.ts";
import type { Peer, Pid } from "./identity.ts";
import { readRootEntry, type RootEntry } from "./roots.ts";
import sodium from "./sodium.ts";

// Who may use a relay beyond its founding allowlist. A member vouches for a
// newcomer by signing an event with their root key. The relay keeps one
// record per member (who currently vouches for them, and whether an admin
// removed them), so storage grows with people rather than with requests.
// A voucher can withdraw their vouch; an admin's removal sticks until an
// admin vouches for them again. The join rule says how many vouches admit.

export type JoinRule = { readonly kind: "any-member" } | { readonly kind: "admins" } | { readonly kind: "vouches"; readonly count: number } | { readonly kind: "closed" };
export type MembershipEvent = {
  readonly v: 1;
  readonly kind: "vouch" | "withdraw" | "remove";
  /** The relay's host: an event signed for one relay is refused by every other. */
  readonly relay: string;
  readonly member: RootEntry;
  readonly by: string;
  readonly ts: string;
};
export type SignedEvent = { readonly e: MembershipEvent; readonly s: string };

const DOMAIN = "agent-mailbox/v1/membership\n";
const MAX_SKEW_MS = 5 * 60_000;
const KINDS = new Set(["vouch", "withdraw", "remove"]);
// Exactly what toISOString writes: anything looser could sort or nest unexpectedly in storage keys.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const b64url = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
const signedBytes = (e: MembershipEvent) => new TextEncoder().encode(DOMAIN + canonicalize(e));

/** MAILBOX_JOIN: any-member (the default), admins, vouches:N, or closed. null when it's none of those. */
export function parseJoinRule(raw: string | undefined): JoinRule | null {
  const value = raw?.trim() ?? "any-member";
  if (value === "any-member" || value === "") return { kind: "any-member" };
  if (value === "admins" || value === "closed") return { kind: value };
  const vouches = /^vouches:([1-9][0-9]?)$/.exec(value);
  return vouches === null ? null : { kind: "vouches", count: Number(vouches[1]) };
}

export function signEvent(event: MembershipEvent, signSec: Uint8Array): SignedEvent {
  return { e: event, s: b64url(sodium.crypto_sign_detached(signedBytes(event), signSec)) };
}

/** What the relay keeps about one admitted-or-not member. */
export type MemberRecord = { readonly member: RootEntry; readonly vouchers: readonly string[]; readonly removed: boolean };

/** The record after one checked event, or why the event can't apply to this member as they stand. */
export function applyEvent(
  record: MemberRecord | undefined,
  event: MembershipEvent,
  actorIsAdmin: boolean,
): { readonly ok: true; readonly record: MemberRecord } | { readonly ok: false; readonly status: number; readonly error: string } {
  const current = record ?? { member: event.member, vouchers: [], removed: false };
  if (event.kind === "remove") return { ok: true, record: { member: current.member, vouchers: [], removed: true } };
  if (event.kind === "withdraw") return { ok: true, record: { ...current, vouchers: current.vouchers.filter((by) => by !== event.by) } };
  if (current.removed && !actorIsAdmin) return { ok: false, status: 403, error: "removed_by_admin" };
  const vouchers = current.vouchers.includes(event.by) ? current.vouchers : [...current.vouchers, event.by];
  return { ok: true, record: { member: current.member, vouchers, removed: false } };
}

export function isAdmitted(record: MemberRecord | undefined, rule: JoinRule): boolean {
  if (record === undefined || record.removed || rule.kind === "closed") return false;
  return record.vouchers.length >= (rule.kind === "vouches" ? rule.count : 1);
}

export type EventContext = {
  readonly host: string;
  readonly now: Date;
  readonly rule: JoinRule;
  /** Current members: founders plus everyone admitted so far. */
  readonly members: ReadonlyMap<Pid, Peer>;
  /** Founders are the operator's to manage (MAILBOX_ROOTS); no event withdraws or removes them. */
  readonly founders: ReadonlySet<Pid>;
  readonly admins: ReadonlySet<Pid>;
};

/** Whether the relay should record this event, checked before anything is stored. */
export function checkEvent(
  value: unknown,
  ctx: EventContext,
): { readonly ok: true; readonly event: MembershipEvent; readonly alreadyMember?: true } | { readonly ok: false; readonly status: number; readonly error: string } {
  const signed = value as Partial<SignedEvent> | null;
  const e = signed?.e as Partial<MembershipEvent> | undefined;
  if (
    typeof signed?.s !== "string" ||
    e === undefined ||
    e.v !== 1 ||
    !KINDS.has(e.kind as string) ||
    ![e.relay, e.by, e.ts].every((f) => typeof f === "string") ||
    !ISO.test(e.ts as string) ||
    new Date(e.ts as string).toISOString() !== e.ts
  ) {
    return { ok: false, status: 400, error: "malformed" };
  }
  const event = e as MembershipEvent;
  if (typeof readRootEntry(event.member) === "string") return { ok: false, status: 400, error: "bad_member" };
  const actor = ctx.members.get(event.by as Pid);
  if (actor === undefined) return { ok: false, status: 403, error: "not_a_member" };
  try {
    if (!sodium.crypto_sign_verify_detached(sodium.from_base64(signed.s, sodium.base64_variants.URLSAFE_NO_PADDING), signedBytes(event), actor.signPub)) {
      return { ok: false, status: 401, error: "bad_signature" };
    }
  } catch {
    return { ok: false, status: 401, error: "bad_signature" };
  }
  if (event.relay !== ctx.host) return { ok: false, status: 400, error: "wrong_relay" };
  if (!(Math.abs(Date.parse(event.ts) - ctx.now.getTime()) <= MAX_SKEW_MS)) return { ok: false, status: 400, error: "stale" };
  // Adding someone who's already in, a founder say, changes nothing and needs no join rule.
  if (event.kind === "vouch" && ctx.members.has(event.member.pid as Pid)) return { ok: true, event, alreadyMember: true };
  if (event.kind !== "vouch" && ctx.founders.has(event.member.pid as Pid)) return { ok: false, status: 400, error: "is_founder" };
  const isAdmin = ctx.admins.has(actor.pid);
  if (event.kind === "vouch" && ctx.rule.kind === "closed") return { ok: false, status: 403, error: "join_closed" };
  if (event.kind === "vouch" && ctx.rule.kind === "admins" && !isAdmin) return { ok: false, status: 403, error: "admins_only" };
  if (event.kind === "remove" && !isAdmin) return { ok: false, status: 403, error: "admins_only" };
  return { ok: true, event };
}
