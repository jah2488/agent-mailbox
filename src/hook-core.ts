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
  return `agent-mailbox: ${total} unread ${noun}${senders}. Read ${total === 1 ? "it" : "them"} with the mailbox_receive tool, then tell the user what arrived and what needs them.`;
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

/** Warn about the daemon's cert this long before it expires. Certs last 30 days. */
export const CERT_WARNING_MS = 7 * 86_400_000;

/**
 * One line once the daemon's cert is inside its last week or past it, so it
 * never quietly stops answering. null expires means there is no daemon.
 */
export function certNotice(expires: string | null, daemonOn: boolean, now: Date): string | null {
  const left = expires === null ? Number.NaN : Date.parse(expires) - now.getTime();
  // Setup certifies a key for everyone; only a daemon that was started can stop answering.
  if (!daemonOn || Number.isNaN(left) || left > CERT_WARNING_MS) return null;
  const renew = "Tell the user to run `mailbox daemon setup` in a terminal to renew it for 30 days.";
  if (left <= 0) return `agent-mailbox: the user's daemon certificate has expired, so their daemon has stopped answering. ${renew}`;
  const days = Math.floor(left / 86_400_000);
  return `agent-mailbox: the user's daemon certificate expires in ${days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`}. ${renew}`;
}
