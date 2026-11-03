import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { auditVerify, daemonCommand, policyCommand, review } from "./cli-daemon.ts";
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
  "  daemon setup [--name <agent>]        certify a daemon key and create the share folder and policy",
  "  daemon once | run                    answer waiting asks once, or every 30 s until stopped",
  "  daemon install                       write a launchd plist and print the commands that load it",
  "  policy sign | show                   sign policy.cedar as the next version, or print the one in force",
  "  review                               list what the daemon deferred or flagged for you",
  "  audit verify                         check the daemon's audit log is intact and signed",
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
  const hook = { UserPromptSubmit: [{ hooks: [{ type: "command", command: node("hook.ts"), timeout: 5 }] }] };
  io.out("1. Register the MCP server (once):");
  io.out(`   claude mcp add --scope user agent-mailbox -- ${node("mcp-main.ts")}`);
  io.out('2. Merge this into the "hooks" object in ~/.claude/settings.json, keeping any hooks you already have:');
  io.out(`   ${JSON.stringify(hook)}`);
  io.out("3. Restart Claude Code. Leave mailbox_send off your permission allowlist, so you approve every send.");
  io.out("Both read MAILBOX_HOME (default ~/.agent-mailbox). This command never edits your settings.");
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
    case "audit":
      if (rest[0] === "verify") return auditVerify(io);
      break;
  }
  io.err(USAGE);
  return 2;
}
