import type { Pid } from "./identity.ts";
import type { Inbound, MailboxState } from "./mailbox.ts";
import { decide } from "./policy.ts";
import { buildPrompt, type ResponderResult } from "./responder.ts";
import type { ShareFile } from "./share.ts";

// The daemon's decisions, with no I/O: which asks it owes an answer, what
// context policy lets it use for each, and whether a drafted answer may go out.

export type Plan =
  | { readonly kind: "ignore" }
  | { readonly kind: "defer"; readonly reason: string }
  | { readonly kind: "ask-model"; readonly prompt: string; readonly files: readonly ShareFile[]; readonly flagged: boolean };

export type PlanContext = {
  readonly policy: string;
  readonly contacts: ReadonlySet<Pid>;
  readonly files: readonly ShareFile[];
  readonly owner: string;
  readonly askerName: string;
  /** The ask's hop count. Only first-hand asks (0) are answered, so daemons can't chain. */
  readonly hops: number;
};

export function planAnswer(ask: Inbound, ctx: PlanContext): Plan {
  // Asks from people only. Never replies, never another agent's mail, never anything forwarded.
  if (ask.body.tag !== "ask" || ask.via.kind === "agent" || ctx.hops > 0) return { kind: "ignore" };
  const decided = ctx.files.map((file) => ({ file, tier: decide(ctx.policy, { principal: ask.from, path: file.path, contacts: ctx.contacts }).tier }));
  const usable = decided.filter((d) => d.tier === "allow" || d.tier === "flag");
  if (usable.length === 0) return { kind: "defer", reason: "nothing you share covers this asker" };
  const files = usable.map((d) => d.file).sort((a, b) => (a.path < b.path ? -1 : 1));
  const question = ask.body.prose ?? JSON.stringify(ask.body.payload);
  return {
    kind: "ask-model",
    prompt: buildPrompt({ owner: ctx.owner, asker: ctx.askerName, question, files }),
    files,
    flagged: usable.some((d) => d.tier === "flag"),
  };
}

// Secret-shaped strings that must never leave in an answer, whatever policy allowed in.
const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["aws access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["netlify token", /\bnfp_[A-Za-z0-9]{30,}\b/],
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
];

export function findSecrets(text: string): readonly string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/** The last gate before sending: a drafted answer that looks like it carries a secret is deferred instead. */
export function settleAnswer(result: ResponderResult): ResponderResult {
  if (result.kind !== "answer") return result;
  const hits = findSecrets(result.text);
  return hits.length === 0 ? result : { kind: "defer", reason: `the drafted answer looked like it contained a secret (${hits.join(", ")})` };
}

/**
 * Asks the daemon still owes a response: from someone else, received since
 * the daemon started, with nothing of mine replying to them. Derived from
 * state rather than tracked separately, so a crash mid-answer is retried.
 */
export function unanswered(state: MailboxState, options: { readonly me: Pid; readonly since: string }): readonly Inbound[] {
  const repliedTo = new Set(state.outbox.flatMap((m) => (m.body.reply_to === undefined ? [] : [m.body.reply_to])));
  return state.inbox.filter((m) => m.body.tag === "ask" && m.from !== options.me && m.receivedAt >= options.since && !repliedTo.has(m.body.ref));
}
