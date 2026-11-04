import type { Json } from "./canonical.ts";
import type { Pid } from "./identity.ts";
import type { Inbound, MailboxState, Outbound } from "./mailbox.ts";

// Promises (spec 9), derived from mail rather than stored: a :promise opens
// an obligation tied to an ask, and the promiser's :fulfil or :break closes
// it. Keyed by promiser, ask ref and item. Only the promiser's own messages
// count, and among them the highest seq wins.

export type PromiseStatus = "open" | "fulfilled" | "broken";
export type Commitment = {
  /** The other person: who I promised, or who promised me. */
  readonly counterparty: Pid;
  /** The ask this promise answers. */
  readonly ref: string;
  readonly item: string;
  readonly condition?: string;
  readonly due?: string;
  readonly status: PromiseStatus;
  readonly reason?: string;
  readonly overdue: boolean;
  /** Open, with no due date, and promised more than 30 days ago. */
  readonly stale: boolean;
};
export type Ledger = { readonly made: readonly Commitment[]; readonly owed: readonly Commitment[] };

const TAGS = new Set(["promise", "fulfil", "break"]);
const STALE_MS = 30 * 86_400_000;

type Field = Readonly<Record<string, Json>>;
const fieldsOf = (payload: Json): Field => (typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Field) : {});
const text = (value: Json | undefined) => (typeof value === "string" ? value : undefined);

/** Why a promise, fulfil or break can't be sent as written, or null when it can (or isn't one). */
export function checkPromiseBody(tag: string, replyTo: string | undefined, payload: Json): string | null {
  if (!TAGS.has(tag)) return null;
  if (replyTo === undefined) return `a ${tag} needs reply_to: the ref of the ask it answers`;
  const fields = fieldsOf(payload);
  if (typeof fields["item"] !== "string" || fields["item"].trim() === "") return `a ${tag} needs payload.item, naming what was promised`;
  if (tag === "promise" && fields["due"] !== undefined && (typeof fields["due"] !== "string" || Number.isNaN(Date.parse(fields["due"])))) {
    return "payload.due must be a date, like 2026-11-20";
  }
  return null;
}

function commitments(messages: readonly { readonly seq: number; readonly at: string; readonly body: Inbound["body"] }[], counterparty: Pid, now: Date): Commitment[] {
  const byKey = new Map<string, Commitment & { readonly promisedAt: string }>();
  for (const m of [...messages].sort((a, b) => a.seq - b.seq)) {
    const fields = fieldsOf(m.body.payload);
    const item = text(fields["item"]);
    if (!TAGS.has(m.body.tag) || m.body.reply_to === undefined || item === undefined) continue;
    const key = JSON.stringify([m.body.reply_to, item]);
    const open = byKey.get(key);
    if (m.body.tag === "promise") {
      const condition = text(fields["condition"]);
      const due = text(fields["due"]);
      byKey.set(key, {
        counterparty,
        ref: m.body.reply_to,
        item,
        ...(condition === undefined ? {} : { condition }),
        ...(due === undefined ? {} : { due }),
        status: "open",
        overdue: false,
        stale: false,
        promisedAt: m.at,
      });
    } else if (open !== undefined) {
      // A close with no promise before it on the same chain is ignored.
      const reason = text(fields["reason"]);
      const { reason: _old, ...rest } = open;
      byKey.set(key, { ...rest, status: m.body.tag === "fulfil" ? "fulfilled" : "broken", ...(reason === undefined ? {} : { reason }) });
    }
  }
  return [...byKey.values()].map(({ promisedAt, ...c }) => ({
    ...c,
    overdue: c.status === "open" && c.due !== undefined && Date.parse(c.due) < now.getTime(),
    stale: c.status === "open" && c.due === undefined && now.getTime() - Date.parse(promisedAt) > STALE_MS,
  }));
}

/** Promises I made (my own messages) and promises made to me (each sender's messages), per counterparty. */
export function ledger(state: MailboxState, me: Pid, now: Date): Ledger {
  const groupBy = <T extends Inbound | Outbound>(items: readonly T[], who: (m: T) => Pid) => {
    const groups = new Map<Pid, T[]>();
    for (const m of items) groups.set(who(m), [...(groups.get(who(m)) ?? []), m]);
    return [...groups.entries()];
  };
  const made = groupBy(state.outbox.filter((m) => m.from === me), (m) => m.to).flatMap(([to, ms]) => commitments(ms.map((m) => ({ seq: m.seq, at: m.ts, body: m.body })), to, now));
  const owed = groupBy(state.inbox, (m) => m.from).flatMap(([from, ms]) => commitments(ms.map((m) => ({ seq: m.seq, at: m.receivedAt, body: m.body })), from, now));
  return { made, owed };
}
