import type { InboxCheck } from "./client.ts";

/** The hook runs on every prompt; it checks the relays at most this often. */
export const HOOK_INTERVAL_MS = 30_000;

export function shouldCheck(last: Date | null, now: Date): boolean {
  // An unreadable cache date is NaN, and every comparison with NaN is false; treat it as never checked.
  return last === null || Number.isNaN(last.getTime()) || now.getTime() - last.getTime() > HOOK_INTERVAL_MS;
}

/**
 * One line for the model's context, or null to stay silent. Counts and
 * sender names only: message bodies reach the model through mailbox_receive,
 * where they're framed as untrusted, never through this hook.
 */
export function inboxNotice(check: InboxCheck): string | null {
  const total = check.waiting + check.unread;
  if (total === 0) return null;
  const noun = total === 1 ? "message" : "messages";
  const senders = check.from.length > 0 ? ` (new from ${check.from.join(", ")})` : "";
  return `agent-mailbox: ${total} unread ${noun}${senders}. Read ${total === 1 ? "it" : "them"} with the mailbox_receive tool.`;
}
