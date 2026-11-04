import { hashOf, type Body, type Hash, type Header, type Opened, type SenderChain, type Via } from "./envelope.ts";
import { certHash } from "./cert.ts";
import type { Pid } from "./identity.ts";

// Pure state transitions for one person's mailbox. Everything here is plain
// JSON-shaped data, because the shell persists it verbatim between processes.

export type Inbound = {
  readonly from: Pid;
  readonly to: Pid;
  readonly seq: number;
  readonly hash: Hash;
  readonly ts: string;
  readonly body: Body;
  /** Erlang semantics: take() hands a message out once. thread() still shows it. */
  readonly consumed: boolean;
  /** My clock when it arrived. Ordering uses this, never the sender's ts, which can be skewed. */
  readonly receivedAt: string;
  /** Whether the person's own session sent it, or an agent acting for them. */
  readonly via: Via;
  /** 0 for a first-hand message; agents raise it, and only 0 is ever answered automatically. */
  readonly hops: number;
  /** The relay this message was fetched from. Absent on mail received before it was recorded. */
  readonly relay?: string;
};

export type Outbound = {
  readonly from: Pid;
  readonly to: Pid;
  readonly seq: number;
  readonly hash: Hash;
  readonly ts: string;
  readonly body: Body;
  /** The exact sealed bytes, kept until delivery so a failed PUT is retried byte-for-byte; null after. */
  readonly wire: string | null;
  readonly delivered: boolean;
};

export type MailboxState = {
  readonly chains: Readonly<Record<string, SenderChain>>;
  /** My own log: one chain across every recipient, in seq order. */
  readonly outbox: readonly Outbound[];
  readonly inbox: readonly Inbound[];
  /** Senders whose mail I refused (not in my roster), with the highest seq refused, so it isn't listed again. */
  readonly ignored: Readonly<Record<string, number>>;
  /** Agent certs their person revoked, keyed "pid certHash", with the last seq that cert may still have signed. */
  readonly revoked: Readonly<Record<string, number>>;
};

export type Pattern = { readonly from?: Pid; readonly tag?: string; readonly reply_to?: string };

export const emptyState: MailboxState = { chains: {}, outbox: [], inbox: [], ignored: {}, revoked: {} };

export function nextLink(state: MailboxState): { readonly seq: number; readonly prev: Hash | null } {
  const last = state.outbox.at(-1);
  return last === undefined ? { seq: 0, prev: null } : { seq: last.seq + 1, prev: last.hash };
}

/**
 * Records a message the moment it is sealed, before any network call, so a
 * crash between sealing and delivery can never reuse its seq.
 */
export function recordSealed(state: MailboxState, sealed: { readonly to: Pid; readonly ts: string; readonly body: Body; readonly wire: Uint8Array }): MailboxState {
  const text = new TextDecoder().decode(sealed.wire);
  const header = (JSON.parse(text) as { readonly h: Header }).h;
  const outbound: Outbound = {
    from: header.from,
    to: sealed.to,
    seq: header.seq,
    hash: hashOf(sealed.wire),
    ts: sealed.ts,
    body: sealed.body,
    wire: text,
    delivered: false,
  };
  return { ...state, outbox: [...state.outbox, outbound] };
}

export function markDelivered(state: MailboxState, seq: number): MailboxState {
  return { ...state, outbox: state.outbox.map((m) => (m.seq === seq ? { ...m, delivered: true, wire: null } : m)) };
}

/** Undelivered messages in seq order. The relay rejects gaps, so they must go oldest first. */
export function pendingDelivery(state: MailboxState): readonly Outbound[] {
  return state.outbox.filter((m) => !m.delivered);
}

export function recordReceived(state: MailboxState, opened: Opened, receivedAt: string, relay?: string): MailboxState {
  const { header, body, hash, chain, via } = opened;
  const inbound: Inbound = { from: header.from, to: header.to, seq: header.seq, hash, ts: header.ts, body, consumed: false, receivedAt, via, hops: header.hops, ...(relay === undefined ? {} : { relay }) };
  return { ...state, chains: { ...state.chains, [header.from]: chain }, inbox: [...state.inbox, inbound] };
}

/** Remembers that mail from `pid` up to `seq` was refused, so the relay stops listing it. Never moves backwards. */
const REVOKE_HASH = /^b2:[0-9a-f]{64}$/;

/**
 * Takes in one opened envelope. Mail signed by a revoked cert past its
 * cutoff is refused, but its chain link is kept, so the sender's later mail
 * still connects. A :revoke counts only when the person's root signed it.
 */
export function admit(state: MailboxState, opened: Opened, receivedAt: string, relay?: string): { readonly state: MailboxState; readonly refused: boolean } {
  const { header, body, via } = opened;
  if (header.cert !== undefined) {
    const cutoff = state.revoked[`${header.from} ${certHash(header.cert)}`];
    if (cutoff !== undefined && header.seq > cutoff) return { state: { ...state, chains: { ...state.chains, [header.from]: opened.chain } }, refused: true };
  }
  const received = recordReceived(state, opened, receivedAt, relay);
  const revoke = body.payload as { cert_hash?: unknown; effective_seq?: unknown } | null;
  if (body.tag !== "revoke" || via.kind !== "owner" || typeof revoke?.cert_hash !== "string" || !REVOKE_HASH.test(revoke.cert_hash) || !Number.isSafeInteger(revoke.effective_seq)) {
    return { state: received, refused: false };
  }
  return { state: { ...received, revoked: { ...received.revoked, [`${header.from} ${revoke.cert_hash}`]: revoke.effective_seq as number } }, refused: false };
}

export function ignoreThrough(state: MailboxState, pid: Pid, seq: number): MailboxState {
  const current = state.ignored[pid] ?? -1;
  return seq <= current ? state : { ...state, ignored: { ...state.ignored, [pid]: seq } };
}

/** The highest seq I hold or have refused, per sender. This is what ?after= tells the relay. */
export function knownHeads(state: MailboxState): Readonly<Record<string, number>> {
  const heads: Record<string, number> = { ...state.ignored };
  for (const [pid, chain] of Object.entries(state.chains)) {
    const head = chain.recent.at(-1)?.seq;
    if (head !== undefined) heads[pid] = Math.max(head, heads[pid] ?? -1);
  }
  return heads;
}

/**
 * Chains as open() wants them. On disk the keys are plain strings, because
 * JSON can't carry a brand. Only recordReceived writes them, always from a
 * verified header's pid, so the cast holds.
 */
export function chainsOf(state: MailboxState): ReadonlyMap<Pid, SenderChain> {
  return new Map(Object.entries(state.chains).map(([pid, chain]) => [pid as Pid, chain]));
}

export function unreadCount(state: MailboxState): number {
  return state.inbox.filter((m) => !m.consumed).length;
}

const matches = (pattern: Pattern) => (m: Inbound) =>
  !m.consumed &&
  (pattern.from === undefined || m.from === pattern.from) &&
  (pattern.tag === undefined || m.body.tag === pattern.tag) &&
  (pattern.reply_to === undefined || m.body.reply_to === pattern.reply_to);

/** Selective receive: matching unread messages, oldest first, marked consumed in the returned state. */
export function take(state: MailboxState, pattern: Pattern): { readonly messages: readonly Inbound[]; readonly state: MailboxState } {
  const isMatch = matches(pattern);
  const messages = state.inbox.filter(isMatch);
  if (messages.length === 0) return { messages, state };
  const inbox = state.inbox.map((m) => (isMatch(m) ? { ...m, consumed: true } : m));
  return { messages, state: { ...state, inbox } };
}

// Both are my own clock: ts on what I sealed, receivedAt on what arrived.
const localTime = (m: Inbound | Outbound) => ("receivedAt" in m ? m.receivedAt : m.ts);

/** Everything sent or received under one ref, in the order it happened here, consumed or not. */
export function thread(state: MailboxState, ref: string): readonly (Inbound | Outbound)[] {
  const inThread = (m: Inbound | Outbound) => m.body.ref === ref || m.body.reply_to === ref;
  return [...state.outbox.filter(inThread), ...state.inbox.filter(inThread)].sort((a, b) => {
    const [x, y] = [localTime(a), localTime(b)];
    return x === y ? 0 : x < y ? -1 : 1;
  });
}

/**
 * Everyone whose mail has reached me. Their mail only opens if they hold my
 * real key, so a contact in here is connected both ways; one missing from it
 * hasn't added me yet, or added a key that isn't mine.
 */
export function heardFrom(state: MailboxState): ReadonlySet<Pid> {
  return new Set(state.inbox.map((m) => m.from));
}
