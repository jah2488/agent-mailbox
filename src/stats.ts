import type { AuditEntry } from "./audit.ts";
import type { Pid } from "./identity.ts";
import type { MailboxState } from "./mailbox.ts";
import { ledger } from "./promises.ts";

// The test's measurements (spec P6), derived from mail plus the daemon's audit
// log. Only the mailbox side: Slack DMs the owner still counts by hand.

export type Grade = "right" | "wrong";
/** The owner's verdicts on daemon answers, keyed by gradeKey(asker, ask ref). */
export type Grades = Readonly<Record<string, Grade>>;
export type DaemonReply = { readonly from: Pid; readonly ref: string; readonly status: "answered" | "deferred"; readonly reply: string };
export type AskCounts = { readonly asks: number; readonly byPerson: number; readonly byAgent: number; readonly deferred: number; readonly unanswered: number };
export type Stats = {
  readonly sent: AskCounts;
  readonly received: AskCounts;
  readonly promises: { readonly made: number; readonly kept: number; readonly broken: number; readonly open: number; readonly overdue: number };
  readonly grading: { readonly answered: number; readonly right: number; readonly wrong: number; readonly ungraded: number };
};

export const gradeKey = (from: Pid, ref: string) => `${from} ${ref}`;

type Outcome = "byPerson" | "byAgent" | "deferred" | "unanswered";
const tally = (outcomes: readonly Outcome[]): AskCounts => ({
  asks: outcomes.length,
  byPerson: outcomes.filter((o) => o === "byPerson").length,
  byAgent: outcomes.filter((o) => o === "byAgent").length,
  deferred: outcomes.filter((o) => o === "deferred").length,
  unanswered: outcomes.filter((o) => o === "unanswered").length,
});

const isDeferral = (payload: unknown) => typeof payload === "object" && payload !== null && (payload as { status?: unknown }).status === "deferred";

/** The daemon's sent replies, from its reply_sent audit entries. */
export function daemonReplies(entries: readonly AuditEntry[]): DaemonReply[] {
  return entries.flatMap((e) => {
    const d = e.data as Partial<DaemonReply>;
    return e.kind === "reply_sent" && (d.status === "answered" || d.status === "deferred") && typeof d.ref === "string" && typeof d.reply === "string" && typeof d.from === "string"
      ? [{ from: d.from, ref: d.ref, status: d.status, reply: d.reply }]
      : [];
  });
}

export function stats(input: { readonly state: MailboxState; readonly me: Pid; readonly daemon: readonly DaemonReply[]; readonly grades: Grades; readonly since: string; readonly now: Date }): Stats {
  const { state, me, since } = input;
  const daemonRefs = new Map(input.daemon.map((d) => [d.reply, d.status]));

  const received = state.inbox.filter((m) => m.body.tag === "ask" && m.receivedAt >= since);
  const receivedOutcomes = received.map((ask): Outcome => {
    const replies = state.outbox.filter((m) => m.to === ask.from && m.body.reply_to === ask.body.ref);
    // A reply of mine the daemon didn't send settles it as mine, even after a deferral.
    if (replies.some((r) => !daemonRefs.has(r.body.ref))) return "byPerson";
    if (replies.some((r) => daemonRefs.get(r.body.ref) === "answered")) return "byAgent";
    return replies.length > 0 ? "deferred" : "unanswered";
  });

  const sent = state.outbox.filter((m) => m.from === me && m.body.tag === "ask" && m.ts >= since);
  const sentOutcomes = sent.map((ask): Outcome => {
    const replies = state.inbox.filter((m) => m.from === ask.to && m.body.reply_to === ask.body.ref);
    const answers = replies.filter((r) => !isDeferral(r.body.payload));
    // Mail stored before via was recorded predates agents, so it came from the person.
    if (answers.some((r) => !("via" in r) || r.via.kind === "owner")) return "byPerson";
    if (answers.length > 0) return "byAgent";
    return replies.length > 0 ? "deferred" : "unanswered";
  });

  const inWindow = { ...state, inbox: state.inbox.filter((m) => m.receivedAt >= since), outbox: state.outbox.filter((m) => m.ts >= since) };
  const made = ledger(inWindow, me, input.now).made;

  const askedInWindow = new Set(received.map((m) => gradeKey(m.from, m.body.ref)));
  const answered = input.daemon.filter((d) => d.status === "answered" && askedInWindow.has(gradeKey(d.from, d.ref)));
  const verdicts = answered.map((d) => input.grades[gradeKey(d.from, d.ref)]);

  return {
    sent: tally(sentOutcomes),
    received: tally(receivedOutcomes),
    promises: {
      made: made.length,
      kept: made.filter((p) => p.status === "fulfilled").length,
      broken: made.filter((p) => p.status === "broken").length,
      open: made.filter((p) => p.status === "open").length,
      overdue: made.filter((p) => p.overdue).length,
    },
    grading: {
      answered: answered.length,
      right: verdicts.filter((v) => v === "right").length,
      wrong: verdicts.filter((v) => v === "wrong").length,
      ungraded: verdicts.filter((v) => v === undefined).length,
    },
  };
}
