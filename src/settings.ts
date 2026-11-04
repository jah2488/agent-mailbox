// The client's config.toml: which folders the daemon may read, how the
// daemon behaves, and which notices the inbox hook shows. The file is
// schema-checked: an unknown key or a wrong type is an error, never ignored.
//
// Share folders carry the security contract, so two rules apply to them.
// The daemon reads only the folders the signed policy names (`mailbox policy
// sign` copies them in), so editing this file alone widens nothing. And a
// folder that covers far more than a person means to share, like ~/ or
// ~/.ssh, is a warning here and something `mailbox config` won't write:
// someone who means it edits the file by hand.
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { parseToml, stringifyToml, type TomlTable, type TomlValue } from "./toml.ts";

export type Settings = {
  /** null: no folders listed, so the daemon reads ~/.agent-mailbox/share as it always has. */
  readonly share: { readonly folders: Readonly<Record<string, string>> | null };
  readonly daemon: {
    /** false: the daemon defers every ask to you instead of answering. */
    readonly answer: boolean;
    readonly poll_seconds: number;
    /** Contact names the daemon answers, or ["*"] for every contact. Your signed policy still decides what each may see. */
    readonly contacts: readonly string[];
  };
  readonly notifications: { readonly inbox_hook: boolean; readonly promise_reminders: boolean; readonly update_check: boolean };
};

export const DEFAULT_SETTINGS: Settings = {
  share: { folders: null },
  daemon: { answer: true, poll_seconds: 30, contacts: ["*"] },
  notifications: { inbox_hook: true, promise_reminders: true, update_check: true },
};

export const CONFIG_FILE = "config.toml";
const FOLDER_NAME = /^[a-z0-9_-]{1,32}$/;
const SECTIONS = ["share", "daemon", "notifications"] as const;
const BOOL = (v: TomlValue | undefined) => typeof v === "boolean";

/** Who reads `[share.folders]` needs it explained; these are the folders no daemon should be pointed at. */
const CREDENTIAL_DIRS = [".ssh", ".gnupg", ".aws", ".config", ".kube", ".docker", "Library", ".agent-mailbox"];
const STANDARD_DIRS = ["Documents", "Desktop", "Downloads", "Pictures", "Movies", "Music"];

/** An absolute, normalised path, with ~ expanded. */
export function resolveFolder(path: string, home: string): string {
  const expanded = path === "~" ? home : path.startsWith("~/") ? posix.join(home, path.slice(2)) : path;
  const normal = posix.normalize(expanded);
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
}

const inside = (path: string, dir: string) => dir === "/" || path === dir || path.startsWith(dir + "/");

/** Why a folder is too broad to share, or null when it's fine. */
export function broadFolder(path: string, home: string): string | null {
  const p = resolveFolder(path, home);
  if (inside(home, p)) return "covers your whole home folder";
  // The share folder is the one part of ~/.agent-mailbox meant for this.
  if (inside(p, join(home, ".agent-mailbox", "share"))) return null;
  const credential = CREDENTIAL_DIRS.find((d) => inside(p, join(home, d)));
  if (credential !== undefined) return `holds keys or credentials (~/${credential})`;
  const standard = STANDARD_DIRS.find((d) => p === join(home, d));
  return standard === undefined ? null : `is a whole standard folder (~/${standard})`;
}

/** A config file checked against the schema: the settings and any warnings, or every error. */
export type SettingsRead = { readonly ok: true; readonly settings: Settings; readonly warnings: readonly string[] } | { readonly ok: false; readonly errors: readonly string[] };
type Result = SettingsRead;
const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks a parsed file against the schema: every problem, in a stable order. */
function validate(raw: TomlTable, home: string): Result {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!(SECTIONS as readonly string[]).includes(key)) errors.push(`${key}: ${isTable(value) ? "unknown section" : "unknown setting"}`);
    else if (!isTable(value)) errors.push(`${key}: must be a [${key}] section`);
  }
  const section = (name: string) => (isTable(raw[name]) ? (raw[name] as TomlTable) : {});
  const known = (name: string, keys: readonly string[]) => {
    for (const key of Object.keys(section(name))) if (!keys.includes(key)) errors.push(`${name}.${key}: unknown setting`);
  };

  const d = section("daemon");
  known("daemon", ["answer", "poll_seconds", "contacts"]);
  if (d["answer"] !== undefined && !BOOL(d["answer"])) errors.push("daemon.answer: must be true or false");
  const poll = d["poll_seconds"];
  if (poll !== undefined && !(typeof poll === "number" && poll >= 10 && poll <= 3600)) errors.push("daemon.poll_seconds: must be a whole number from 10 to 3600");
  const contacts = d["contacts"];
  if (contacts !== undefined && !(Array.isArray(contacts) && contacts.length > 0 && contacts.every((c) => typeof c === "string" && c.trim() !== ""))) {
    errors.push('daemon.contacts: must list at least one contact name, or "*" for everyone');
  }

  const n = section("notifications");
  known("notifications", ["inbox_hook", "promise_reminders", "update_check"]);
  for (const key of ["inbox_hook", "promise_reminders", "update_check"]) if (n[key] !== undefined && !BOOL(n[key])) errors.push(`notifications.${key}: must be true or false`);

  known("share", ["folders"]);
  const folders = section("share")["folders"];
  if (folders !== undefined && !isTable(folders)) errors.push("share.folders: must be a [share.folders] section");
  const listed = isTable(folders) ? Object.entries(folders) : [];
  for (const [name, path] of listed) {
    if (!FOLDER_NAME.test(name)) errors.push(`share.folders.${name}: folder names are lowercase letters, digits, _ and -`);
    else if (typeof path !== "string") errors.push(`share.folders.${name}: must be a path in quotes`);
    else if (!(path.startsWith("/") || path === "~" || path.startsWith("~/"))) errors.push(`share.folders.${name}: must be an absolute path or start with ~/`);
    else {
      const broad = broadFolder(path, home);
      if (broad !== null) warnings.push(`share.folders.${name} (${path}) ${broad}`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    settings: {
      share: { folders: isTable(folders) ? (Object.fromEntries(listed) as Record<string, string>) : null },
      daemon: { answer: (d["answer"] as boolean | undefined) ?? true, poll_seconds: (poll as number | undefined) ?? 30, contacts: (contacts as string[] | undefined) ?? ["*"] },
      notifications: {
        inbox_hook: (n["inbox_hook"] as boolean | undefined) ?? true,
        promise_reminders: (n["promise_reminders"] as boolean | undefined) ?? true,
        update_check: (n["update_check"] as boolean | undefined) ?? true,
      },
    },
  };
}

export function parseSettings(text: string, home: string): Result {
  const parsed = parseToml(text);
  return parsed.ok ? validate(parsed.value, home) : { ok: false, errors: [parsed.error] };
}

/** The settings in a home dir, or the defaults when there's no config.toml yet. */
export async function readSettings(dir: string, home: string): Promise<Result & { readonly exists: boolean }> {
  const text = await readFile(join(dir, CONFIG_FILE), "utf8").catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  return { ...parseSettings(text ?? "", home), exists: text !== null };
}

const HEADER = `# agent-mailbox client settings. Edit by hand, or with mailbox config set; mailbox doctor checks this file.
# Changes to [share.folders] take effect once you run mailbox policy sign.

`;

/** How `config set` reads a value typed on the command line, by the setting it's for. */
function typedValue(key: string, value: string): TomlValue {
  if (key === "daemon.contacts") return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (/^(true|false)$/.test(value) && !key.startsWith("share.")) return value === "true";
  if (/^-?\d+$/.test(value) && !key.startsWith("share.")) return Number(value);
  return value;
}

/**
 * The file with one setting changed (or removed, when value is null), checked
 * against the schema. Comments aren't kept: the CLI writes the file in a
 * standard form.
 */
export function setSetting(text: string, key: string, value: string | null, home: string): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  const parsed = parseToml(text);
  if (!parsed.ok) return { ok: false, error: `config.toml doesn't parse (${parsed.error}); fix it by hand first` };
  const path = key.split(".");
  const isFolder = path.length === 3 && path[0] === "share" && path[1] === "folders";
  const known: Readonly<Record<string, readonly string[]>> = { daemon: ["answer", "poll_seconds", "contacts"], notifications: ["inbox_hook", "promise_reminders", "update_check"] };
  if (!isFolder) {
    if (path.length !== 2 || known[path[0]!] === undefined) return { ok: false, error: `${path[0]}: unknown section` };
    if (!known[path[0]!]!.includes(path[1]!)) return { ok: false, error: `${key}: unknown setting` };
  }
  const next = structuredClone(parsed.value) as Record<string, TomlValue>;
  let table = next;
  for (const segment of path.slice(0, -1)) table = (isTable(table[segment]) ? table[segment] : (table[segment] = {})) as Record<string, TomlValue>;
  if (value === null) delete table[path.at(-1)!];
  else table[path.at(-1)!] = typedValue(key, value);
  const checked = validate(next, home);
  if (!checked.ok) return { ok: false, error: checked.errors.find((e) => e.startsWith(key)) ?? checked.errors[0]! };
  if (isFolder && value !== null) {
    const broad = broadFolder(value, home);
    if (broad !== null) return { ok: false, error: `${key} (${value}) ${broad}. That would let your daemon read far more than you mean to share, so the CLI won't add it. If you really mean it, edit config.toml by hand.` };
  }
  return { ok: true, text: HEADER + stringifyToml(next) };
}
