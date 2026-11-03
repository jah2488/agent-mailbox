import type { Peer, Pid } from "./identity.ts";
import { readRootEntry, rootEntry, type RootEntry } from "./roots.ts";

/** A person you can mail: their keys, what to call them, and their home relay. */
export type Contact = Peer & { readonly name: string; readonly relay: string };

/**
 * A contact as it travels between people and sits on disk. It's a superset of
 * RootEntry, so one roster file can also serve as a relay's MAILBOX_ROOTS.
 */
export type RosterEntry = RootEntry & { readonly name: string; readonly relay: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_NAME = 32;

export function contact(peer: Peer, name: string, relay: string): Contact {
  return { ...peer, name, relay };
}

export function rosterEntry(c: Contact): RosterEntry {
  return { ...rootEntry(c), name: c.name, relay: c.relay };
}

/** The relay's origin, or null. Plain http only for a relay on this machine. */
export function normaliseRelay(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
  const bare = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";
  return secure && bare ? url.origin : null;
}

// A peer picks their own name, and it is printed outside the untrusted frame
// (the prompt hook, the peers list, sync errors). Plain name characters and a
// short length keep it from carrying punctuation-shaped instructions or frame markers.
const NAME_PATTERN = new RegExp(`^[\\p{L}\\p{N} ._'-]{1,${MAX_NAME}}$`, "u");

export function normaliseName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return NAME_PATTERN.test(name) ? name : null;
}

/**
 * All or nothing, like parseRoots. Names must be unique ignoring case,
 * because "send to sam" has to mean exactly one person.
 */
export function parseRoster(json: string): { readonly ok: true; readonly contacts: ReadonlyMap<Pid, Contact> } | { readonly ok: false; readonly error: string } {
  let entries: unknown;
  try {
    entries = JSON.parse(json);
  } catch {
    return { ok: false, error: "roster is not valid JSON" };
  }
  if (!Array.isArray(entries)) return { ok: false, error: "roster must be a JSON array" };

  const contacts: Contact[] = [];
  for (const [index, entry] of entries.entries()) {
    const fail = (why: string) => ({ ok: false as const, error: `roster ${index}: ${why}` });
    const peer = readRootEntry(entry);
    if (typeof peer === "string") return fail(peer);
    const name = normaliseName(entry?.name);
    if (name === null) return fail(`name must be 1-${MAX_NAME} letters, digits, spaces or . _ ' -`);
    if (contacts.some((c) => c.name.toLowerCase() === name.toLowerCase())) return fail(`name "${name}" is already used`);
    const relay = normaliseRelay(entry?.relay);
    if (relay === null) return fail("relay must be https (or http on localhost)");
    contacts.push(contact(peer, name, relay));
  }
  return { ok: true, contacts: new Map(contacts.map((c) => [c.pid, c])) };
}

const INVITE_PREFIX = "am1-";

/**
 * A person's roster entry as one paste-safe word: base64url, so it survives
 * Slack, shells and line wrapping without quotes. Public keys only.
 */
export function inviteToken(c: Contact): string {
  return INVITE_PREFIX + Buffer.from(JSON.stringify(rosterEntry(c))).toString("base64url");
}

/** The contact an invite names, checked exactly as a roster entry is (pid against key, name, relay). */
export function readInvite(token: string): { readonly ok: true; readonly contact: Contact } | { readonly ok: false; readonly error: string } {
  const notInvite = { ok: false, error: "that's not an invite; ask them for the command `mailbox invite` copies" } as const;
  if (!token.startsWith(INVITE_PREFIX)) return notInvite;
  const json = Buffer.from(token.slice(INVITE_PREFIX.length), "base64url").toString("utf8");
  const parsed = parseRoster(`[${json}]`);
  if (!parsed.ok) return json.trim().startsWith("{") ? { ok: false, error: parsed.error.replace(/^roster 0: /, "invite rejected: ") } : notInvite;
  return { ok: true, contact: [...parsed.contacts.values()][0]! };
}
