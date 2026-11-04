// `mailbox config`: read and change config.toml. Every change is checked
// against the schema before it's written, and a share folder that breaks the
// security contract (see settings.ts) is refused here: someone who really
// means it edits the file by hand, and `mailbox doctor` keeps flagging it.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "./cli.ts";
import { CONFIG_FILE, readSettings, setSetting, type Settings } from "./settings.ts";
import { stringifyToml, type TomlTable } from "./toml.ts";

const USAGE = `usage: mailbox config [show | path | get <key> | set <key> <value> | unset <key>]
       mailbox config share add <name> <path> | share remove <name>`;

/** The settings in force, as the TOML a person would write. */
function asToml(settings: Settings): string {
  const { folders } = settings.share;
  const table = { ...(folders === null ? {} : { share: { folders } }), daemon: settings.daemon, notifications: settings.notifications } as unknown as TomlTable;
  const note = folders === null ? "# [share.folders] not set: the daemon reads ~/.agent-mailbox/share/\n\n" : "";
  return note + stringifyToml(table);
}

function lookup(settings: Settings, key: string): string | null {
  let value: unknown = settings;
  for (const part of key.split(".")) value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part] : undefined;
  if (value === undefined || (typeof value === "object" && value !== null && !Array.isArray(value))) return null;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

async function change(io: CliIo, key: string, value: string | null, after?: string): Promise<number> {
  const path = join(io.deps.dir, CONFIG_FILE);
  const text = await readFile(path, "utf8").catch(() => "");
  const next = setSetting(text, key, value, homedir());
  if (!next.ok) {
    io.err(next.error);
    return 1;
  }
  await writeFile(path, next.text, { mode: 0o600 });
  io.out(value === null ? `Removed ${key}.` : `Set ${key}.`);
  if (after !== undefined) io.out(after);
  return 0;
}

export async function configCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  const path = join(io.deps.dir, CONFIG_FILE);
  const SIGN = "Run mailbox policy sign to let your daemon read it.";
  switch (sub) {
    case undefined:
    case "show": {
      const read = await readSettings(io.deps.dir, homedir());
      io.out(`${path}${read.exists ? "" : " (not created yet; these are the defaults)"}`);
      if (!read.ok) {
        for (const error of read.errors) io.err(`✗ ${error}`);
        return 1;
      }
      io.out(asToml(read.settings).trimEnd());
      for (const warning of read.warnings) io.out(`⚠ ${warning}`);
      return 0;
    }
    case "path":
      io.out(path);
      return 0;
    case "get": {
      const read = await readSettings(io.deps.dir, homedir());
      if (!read.ok) {
        for (const error of read.errors) io.err(`✗ ${error}`);
        return 1;
      }
      const value = rest[0] === undefined ? null : lookup(read.settings, rest[0]);
      if (value === null) {
        io.err(rest[0] === undefined ? USAGE : `${rest[0]}: unknown setting`);
        return rest[0] === undefined ? 2 : 1;
      }
      io.out(value);
      return 0;
    }
    case "set":
      if (rest.length !== 2) break;
      return change(io, rest[0]!, rest[1]!, rest[0]!.startsWith("share.folders.") ? SIGN : undefined);
    case "unset":
      if (rest.length !== 1) break;
      return change(io, rest[0]!, null);
    case "share":
      if (rest[0] === "add" && rest.length === 3) return change(io, `share.folders.${rest[1]}`, rest[2]!, SIGN);
      if (rest[0] === "remove" && rest.length === 2) return change(io, `share.folders.${rest[1]}`, null, "Run mailbox policy sign so your daemon stops reading it.");
      break;
  }
  io.err(USAGE);
  return 2;
}
