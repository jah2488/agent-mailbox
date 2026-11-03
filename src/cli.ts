import { mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { withHook, withoutHook } from "./claude-settings.ts";
import { isDevCheckout } from "./config.ts";
import { auditVerify, daemonCommand, daemonInstalled, daemonStop, policyCommand, review } from "./cli-daemon.ts";
import { sync, type ClientDeps } from "./client.ts";
import { addContact, initHome, readHome, type Home } from "./home.ts";
import { fingerprintOf, generateIdentity, toPeer } from "./identity.ts";
import type { KeyStore } from "./keystore.ts";
import { contact, normaliseRelay, parseRoster, rosterEntry } from "./roster.ts";

export type CliIo = {
  readonly deps: ClientDeps;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Absolute path of this checkout, for the commands `install` prints. */
  readonly repoRoot: string;
  /** Where the daemon's agent key lives, apart from the root key in `deps.keys`. */
  readonly agentKeys: KeyStore;
  /** Carried into the launchd plist (PATH, MAILBOX_KEYSTORE). */
  readonly env: NodeJS.ProcessEnv;
  /** Ends `daemon run`. */
  readonly stop: AbortSignal;
  /** Runs launchctl and claude for daemon start/stop and uninstall. Injected so tests see exactly what would run. */
  readonly exec: (program: string, args: readonly string[]) => Promise<{ readonly code: number; readonly output: string }>;
  /** ~/Library/LaunchAgents, where daemon start puts the plist. */
  readonly launchAgents: string;
  /** ~/.claude/settings.json, where hook install adds the inbox hook. */
  readonly claudeSettings: string;
};

const USAGE = [
  "usage: mailbox <command>",
  "  keygen --name <name> --relay <url>   create your identity (key goes to the Keychain)",
  "  whoami                               print your roster entry and fingerprint to share",
  '  peer add <entry> --fingerprint "…"   trust someone, after they read you their fingerprint',
  "  peers                                list contacts with fingerprints",
  "  sync                                 fetch new mail now",
  "  roots                                print the relay allowlist for you and your contacts",
  "  install                              print the Claude Code setup commands",
  "  hook install | remove                add or remove the inbox hook in ~/.claude/settings.json",
  "  daemon setup [--name <agent>]        certify a daemon key and create the share folder and policy",
  "  daemon once | run                    answer waiting asks once, or every 30 s until stopped",
  "  daemon start | stop                  turn the daemon on (now and at login) or off",
  "  daemon revoke                        tell contacts to refuse the agent from now on, and retire its keys",
  "  policy sign | show                   sign policy.cedar as the next version, or print the one in force",
  "  review                               list what the daemon deferred or flagged for you",
  "  audit verify                         check the daemon's audit log is intact and signed",
  "  update                               get the latest version and restart what runs it",
  "  uninstall                            stop the daemon, unregister from Claude Code, remove the command",
].join("\n");

async function homeOrExplain(io: CliIo): Promise<Home | null> {
  try {
    return await readHome(io.deps.dir);
  } catch {
    io.err(`no identity in ${io.deps.dir}; run: mailbox keygen --name <name> --relay <url>`);
    return null;
  }
}

async function keygen(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { name: { type: "string" }, relay: { type: "string" } } });
  const relay = normaliseRelay(values.relay);
  if (!values.name?.trim() || relay === null) {
    io.err("keygen needs --name and an https --relay URL");
    return 2;
  }
  const identity = generateIdentity();
  const me = contact(toPeer(identity), values.name.trim(), relay);
  try {
    // Home first: it refuses an existing identity before a new key is stored.
    await initHome(io.deps.dir, me);
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
  await io.deps.keys.save(identity);
  io.out(`Created ${me.name} (${me.pid}) in ${io.deps.dir}`);
  return whoami(io);
}

async function whoami(io: CliIo): Promise<number> {
  const home = await homeOrExplain(io);
  if (home === null) return 1;
  io.out("Share this line with each person you want to exchange mail with:");
  io.out(JSON.stringify(rosterEntry(home.me)));
  io.out(`fingerprint: ${fingerprintOf(home.me.signPub)}`);
  return 0;
}

const normaliseFingerprint = (text: string) => text.replace(/\s+/g, "").toLowerCase();

/**
 * Trust needs two things from the other person: their whoami line (which can
 * travel over Slack) and their fingerprint, read aloud on a call. A key whose
 * fingerprint doesn't match what they said is never added.
 */
async function peerAdd(args: readonly string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...args], options: { fingerprint: { type: "string" } }, allowPositionals: true });
  const source = positionals[0];
  if (source === undefined || values.fingerprint === undefined) {
    io.err('usage: mailbox peer add <entry-json | file> --fingerprint "<what they read out to you>"');
    return 2;
  }
  const json = source.trim().startsWith("{") ? source : await readFile(source, "utf8").catch(() => "");
  const parsed = parseRoster(`[${json}]`);
  if (!parsed.ok) {
    io.err(parsed.error.replace(/^roster 0: /, "entry rejected: "));
    return 1;
  }
  const added = [...parsed.contacts.values()][0]!;
  const actual = fingerprintOf(added.signPub);
  if (normaliseFingerprint(values.fingerprint) !== normaliseFingerprint(actual)) {
    io.err(`fingerprint does not match ${added.name}'s key (theirs is ${actual}); nothing was added`);
    return 1;
  }
  try {
    await addContact(io.deps.dir, added);
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
  io.out(`Added ${added.name} (${added.pid}), fingerprint verified.`);
  return 0;
}

async function peers(io: CliIo): Promise<number> {
  const home = await homeOrExplain(io);
  if (home === null) return 1;
  for (const c of home.contacts.values()) {
    io.out(`${c.name}${c.pid === home.me.pid ? " (you)" : ""}  ${c.pid}  ${c.relay}  fingerprint: ${fingerprintOf(c.signPub)}`);
  }
  return 0;
}

async function syncNow(io: CliIo): Promise<number> {
  if ((await homeOrExplain(io)) === null) return 1;
  const result = await sync(io.deps);
  io.out(`Received ${result.received} new message${result.received === 1 ? "" : "s"}.`);
  for (const error of result.errors) io.err(`  ${error}`);
  return result.errors.length === 0 ? 0 : 1;
}

async function roots(io: CliIo): Promise<number> {
  const home = await homeOrExplain(io);
  if (home === null) return 1;
  io.out(JSON.stringify([...home.contacts.values()].map(rosterEntry)));
  return 0;
}

function install(io: CliIo): number {
  const node = (file: string) => `node ${io.repoRoot}/src/${file}`;
  io.out("1. Register the MCP server (once):");
  io.out(`   claude mcp add --scope user agent-mailbox -- ${node("mcp-main.ts")}`);
  io.out("2. Add the inbox hook, which mentions new mail at the start of each prompt (keeps your other settings and a backup):");
  io.out("   mailbox hook install");
  io.out("3. Restart Claude Code. Leave mailbox_send off your permission allowlist, so you approve every send.");
  io.out("Both read MAILBOX_HOME (default ~/.agent-mailbox). This command never edits your settings.");
  return 0;
}

/**
 * Adds or removes the inbox hook in ~/.claude/settings.json. Only that one
 * entry changes; a file that isn't valid JSON is left untouched, and the
 * previous file is kept beside it as .agent-mailbox.bak.
 */
export async function hookCommand(action: string | undefined, io: CliIo): Promise<number> {
  if (action !== "install" && action !== "remove") {
    io.err("usage: mailbox hook install|remove");
    return 2;
  }
  const path = io.claudeSettings;
  const before = await readFile(path, "utf8").catch(() => null);
  if (before === null && action === "remove") return 0;
  let next: unknown;
  try {
    const current: unknown = before === null ? {} : JSON.parse(before);
    next = action === "install" ? withHook(current, `node ${io.repoRoot}/src/hook.ts`) : withoutHook(current);
  } catch (error) {
    io.err(`left ${path} unchanged: ${error instanceof SyntaxError ? "settings.json is not valid JSON" : (error as Error).message}`);
    return 1;
  }
  await mkdir(dirname(path), { recursive: true });
  if (before !== null) await writeFile(`${path}.agent-mailbox.bak`, before);
  const tmp = `${path}.agent-mailbox.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n");
  await rename(tmp, path);
  io.out(action === "install" ? "Inbox hook on: Claude Code mentions new mail at the start of each prompt." : "Inbox hook removed from Claude Code.");
  return 0;
}

/** Turns everything off that install set up. Keys, mail and the audit log stay until the owner deletes them. */
export async function uninstall(io: CliIo): Promise<number> {
  if ((await daemonStop(io)) !== 0) io.err("no mailbox identity here, so there was no daemon to stop");
  await hookCommand("remove", io);
  const mcp = await io.exec("claude", ["mcp", "remove", "--scope", "user", "agent-mailbox"]);
  io.out(mcp.code === 0 ? "Removed the agent-mailbox MCP server from Claude Code." : "The agent-mailbox MCP server was not registered with Claude Code.");
  const link = join(io.env["HOME"] ?? "", ".local", "bin", "mailbox");
  // Only our own link: a different `mailbox` on the PATH is someone else's.
  if ((await readlink(link).catch(() => null)) === join(io.repoRoot, "bin", "mailbox")) {
    await rm(link);
    io.out(`Removed ${link}.`);
  }
  io.out("Your identity, contacts, mail and audit log are kept. To delete them too:");
  io.out(`  rm -rf '${io.deps.dir}' '${io.repoRoot}'`);
  io.out("  security delete-generic-password -s agent-mailbox   (and -s agent-mailbox-agent; repeat each until it says the item could not be found)");
  return 0;
}

/**
 * Pulls the latest code into this checkout, then runs the pulled installer
 * (dependencies, MCP registration, hook) and restarts a running daemon, both
 * through the new code rather than this process's old copy.
 */
async function update(io: CliIo): Promise<number> {
  const root = io.repoRoot;
  // The installer installs without dev dependencies, which would strip a developer's toolchain.
  if (await isDevCheckout(root)) {
    io.err(`${root} is a development checkout; update it with git pull and npm install instead`);
    return 1;
  }
  const pulled = await io.exec("git", ["-C", root, "pull", "--ff-only"]);
  if (pulled.code !== 0) {
    io.err(`git pull failed in ${root}; nothing was changed:\n${pulled.output}`);
    return 1;
  }
  const installed = await io.exec("env", [`AGENT_MAILBOX_DIR=${root}`, "bash", join(root, "install.sh")]);
  if (installed.code !== 0) {
    io.err(`the installer failed after pulling:\n${installed.output}`);
    return 1;
  }
  const home = await readHome(io.deps.dir).catch(() => null);
  if (home !== null && (await daemonInstalled(io, home))) {
    const restarted = await io.exec(join(root, "bin", "mailbox"), ["daemon", "start"]);
    io.out(restarted.code === 0 ? "Daemon restarted on the new version." : `The daemon did not restart; run: mailbox daemon start\n${restarted.output}`);
  }
  const head = await io.exec("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
  io.out(`agent-mailbox is up to date${head.code === 0 && head.output !== "" ? ` (${head.output})` : ""}. Restart Claude Code to load the new MCP server.`);
  return 0;
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "keygen":
      return keygen(rest, io);
    case "whoami":
      return whoami(io);
    case "peer":
      if (rest[0] === "add") return peerAdd(rest.slice(1), io);
      break;
    case "peers":
      return peers(io);
    case "sync":
      return syncNow(io);
    case "roots":
      return roots(io);
    case "install":
      return install(io);
    case "daemon":
      return daemonCommand(rest, io);
    case "policy":
      return policyCommand(rest, io);
    case "review":
      return review(io);
    case "update":
      return update(io);
    case "hook":
      return hookCommand(rest[0], io);
    case "uninstall":
      return uninstall(io);
    case "audit":
      if (rest[0] === "verify") return auditVerify(io);
      break;
  }
  io.err(USAGE);
  return 2;
}
