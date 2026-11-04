// Protocol versions, shared by the relay and its clients. A version is
// major.minor: a minor bump adds something both sides can live without, and a
// major bump breaks the wire format. Mismatched minors talk at the older one.
// The one hard rule: a version listed in SECURITY_FIXES fixed a hole, so
// nothing older than the newest such version is accepted, in either direction.

/** This build's protocol version. Bump it with every protocol change, and note it in docs/relay-protocol.md. */
export const PROTOCOL_VERSION = "1.1";
/** Versions whose release fixed a security hole. Adding one here makes it a floor for every peer. */
export const SECURITY_FIXES: readonly string[] = [];
/** What a relay with no version field speaks: everything before versioning existed. */
export const UNVERSIONED = "1.0";
/** Clients name their version on every request, so a relay can refuse one below its floor. */
export const VERSION_HEADER = "agent-mailbox-version";

export type Version = { readonly major: number; readonly minor: number };

export function parseVersion(text: string): Version | null {
  const m = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/.exec(text);
  return m === null ? null : { major: Number(m[1]), minor: Number(m[2]) };
}

/** -1, 0 or 1. Both must parse; callers check that first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)!, y = parseVersion(b)!;
  return Math.sign(x.major - y.major || x.minor - y.minor);
}

export function securityFloor(fixes: readonly string[] = SECURITY_FIXES): string {
  return fixes.reduce((max, v) => (compareVersions(v, max) > 0 ? v : max), UNVERSIONED);
}

export type Negotiated = { readonly ok: true; readonly version: string; readonly notice?: string } | { readonly ok: false; readonly error: string };

/** Which version two sides talk at, or why they can't. side names the other party in messages. */
export function negotiate({ mine, theirs, floor, side }: { readonly mine: string; readonly theirs: string; readonly floor: string; readonly side: "relay" | "client" }): Negotiated {
  const them = side === "relay" ? "the relay" : "the client";
  const v = parseVersion(theirs);
  if (v === null) return { ok: false, error: `${them} sent an unreadable protocol version` };
  const upgrade = side === "relay" ? "its operator must update it" : "it must run mailbox update";
  if (compareVersions(theirs, floor) < 0) return { ok: false, error: `${them} speaks agent-mailbox ${theirs}, below ${floor}, which fixed a security hole; ${upgrade}` };
  if (v.major !== parseVersion(mine)!.major) {
    return compareVersions(theirs, mine) > 0
      ? { ok: false, error: `${them} speaks agent-mailbox ${theirs}, a major version this client doesn't know; run mailbox update` }
      : { ok: false, error: `${them} speaks agent-mailbox ${theirs}, an older major version; ${upgrade}` };
  }
  const order = compareVersions(theirs, mine);
  if (order === 0) return { ok: true, version: mine };
  if (order < 0) return { ok: true, version: theirs, notice: `${them} speaks agent-mailbox ${theirs}, older than your ${mine}; features newer than ${theirs} are off with it` };
  return { ok: true, version: mine, notice: `${them} speaks agent-mailbox ${theirs}, newer than your ${mine}; run mailbox update` };
}

/** Whether a negotiated version has a feature that arrived in since. */
export const supports = (version: string, since: string): boolean => compareVersions(version, since) >= 0;
