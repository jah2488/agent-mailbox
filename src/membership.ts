import { canonicalize } from "./canonical.ts";
import type { Peer, Pid } from "./identity.ts";
import { readRootEntry, type RootEntry } from "./roots.ts";
import sodium from "./sodium.ts";

// Who may use a relay beyond its founding allowlist. A member vouches for a
// newcomer by signing an event with their root key; the relay keeps every
// event, and replaying them in time order says who's admitted. A voucher can
// withdraw their vouch and an admin can remove anyone. The relay's join rule
// says how many vouches admit someone, and whose count.

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

/** Everyone the events admit under this rule, replayed in time order. */
export function admitted(events: readonly MembershipEvent[], rule: JoinRule): ReadonlyMap<Pid, Peer> {
  if (rule.kind === "closed") return new Map();
  const needed = rule.kind === "vouches" ? rule.count : 1;
  const vouchers = new Map<Pid, { readonly peer: Peer; readonly by: Set<string> }>();
  for (const e of [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))) {
    const peer = readRootEntry(e.member);
    if (typeof peer === "string") continue;
    const entry = vouchers.get(peer.pid) ?? { peer, by: new Set<string>() };
    if (e.kind === "vouch") entry.by.add(e.by);
    else if (e.kind === "withdraw") entry.by.delete(e.by);
    else entry.by.clear();
    vouchers.set(peer.pid, entry);
  }
  return new Map([...vouchers.values()].filter((v) => v.by.size >= needed).map((v) => [v.peer.pid, v.peer]));
}

export type EventContext = {
  readonly host: string;
  readonly now: Date;
  readonly rule: JoinRule;
  /** Current members: founders plus everyone admitted so far. */
  readonly members: ReadonlyMap<Pid, Peer>;
  readonly admins: ReadonlySet<Pid>;
};

/** Whether the relay should record this event, checked before anything is stored. */
export function checkEvent(
  value: unknown,
  ctx: EventContext,
): { readonly ok: true; readonly event: MembershipEvent; readonly alreadyMember?: true } | { readonly ok: false; readonly status: number; readonly error: string } {
  const signed = value as Partial<SignedEvent> | null;
  const e = signed?.e as Partial<MembershipEvent> | undefined;
  if (typeof signed?.s !== "string" || e === undefined || e.v !== 1 || !KINDS.has(e.kind as string) || ![e.relay, e.by, e.ts].every((f) => typeof f === "string")) {
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
  const isAdmin = ctx.admins.has(actor.pid);
  if (event.kind === "vouch" && ctx.rule.kind === "closed") return { ok: false, status: 403, error: "join_closed" };
  if (event.kind === "vouch" && ctx.rule.kind === "admins" && !isAdmin) return { ok: false, status: 403, error: "admins_only" };
  if (event.kind === "remove" && !isAdmin) return { ok: false, status: 403, error: "admins_only" };
  return { ok: true, event };
}
