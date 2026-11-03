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

/** The hook asks GitHub whether a newer version exists at most this often. */
export const UPDATE_INTERVAL_MS = 24 * 60 * 60_000;

export function updateDue(last: Date | null, now: Date): boolean {
  return last === null || Number.isNaN(last.getTime()) || now.getTime() - last.getTime() > UPDATE_INTERVAL_MS;
}

type Exec = (program: string, args: readonly string[]) => Promise<{ readonly code: number; readonly output: string }>;

/**
 * One line when this install is behind main on its origin, otherwise null.
 * Any failure (offline, no git, a timeout) is silence: the hook must never
 * get in the way of a prompt.
 */
export async function updateNotice(exec: Exec, root: string): Promise<string | null> {
  const [local, remote] = await Promise.all([exec("git", ["-C", root, "rev-parse", "HEAD"]), exec("git", ["-C", root, "ls-remote", "origin", "refs/heads/main"])]);
  const remoteSha = remote.output.split(/\s/)[0] ?? "";
  if (local.code !== 0 || remote.code !== 0 || local.output === "" || remoteSha === "" || local.output.trim() === remoteSha) return null;
  return "agent-mailbox: a newer version is available. Tell the user they can run `mailbox update` in a terminal, then restart Claude Code.";
}
