import { mkdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { renderStatus, styles, type Fact } from "./banner.ts";
import { hasHook, withHook, withoutHook } from "./claude-settings.ts";
import { isDevCheckout } from "./config.ts";
import { auditVerify, daemonCommand, daemonInstalled, daemonStop, policyCommand, review } from "./cli-daemon.ts";
import { readCert, shareDir } from "./daemon-files.ts";
import { send, sync, type ClientDeps } from "./client.ts";
import { heardFrom } from "./mailbox.ts";
import { addContact, initHome, readHome, type Home } from "./home.ts";
import { fingerprintOf, generateIdentity, toPeer } from "./identity.ts";
import type { KeyStore } from "./keystore.ts";
import { contact, inviteToken, normaliseName, normaliseRelay, readInvite, rosterEntry } from "./roster.ts";

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
  /** Asks the person at the terminal; null when there is no terminal to ask. */
  readonly ask: (question: string) => Promise<string | null>;
  /** Whether output goes to a terminal that wants color (a TTY, and NO_COLOR unset). */
  readonly color: boolean;
  /** Runs a command on the user's own terminal (its output shows, and it can prompt). Returns the exit code. */
  readonly attach: (program: string, args: readonly string[]) => Promise<number>;
  /** Puts text on the clipboard; false when there is no clipboard to use. */
  readonly copy: (text: string) => Promise<boolean>;
};

const USAGE = [
  "usage: mailbox <command>",
  "  setup [--relay <url>] [--name <name>] first-run wizard: identity, daemon key, and how to share",
  "  keygen --name <name> --relay <url>   create your identity (key goes to the Keychain)",
  "  status                               who you are, what to share, and what's running",
  "  whoami                               your name, relay and fingerprint",
  "  invite [--print]                     copy the command a teammate runs to add you",
  "  peer add <invite>                    add a teammate from their invite",
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

/** Creates the home and stores the key. Home first: it refuses an existing identity before a new key is stored. */
async function createIdentity(io: CliIo, name: string, relay: string): Promise<Home | null> {
  const identity = generateIdentity();
  const me = contact(toPeer(identity), name, relay);
  try {
    await initHome(io.deps.dir, me);
  } catch (error) {
    io.err((error as Error).message);
    return null;
  }
  await io.deps.keys.save(identity);
  return readHome(io.deps.dir);
}

const NAME_RULE = "1-32 letters, digits, spaces, or . _ ' -";

async function keygen(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { name: { type: "string" }, relay: { type: "string" } } });
  const relay = normaliseRelay(values.relay);
  const name = normaliseName(values.name);
  if (name === null || relay === null) {
    io.err(`keygen needs --name (${NAME_RULE}) and an https --relay URL`);
    return 2;
  }
  const home = await createIdentity(io, name, relay);
  if (home === null) return 1;
  io.out(`Created ${home.me.name} (${home.me.pid}) in ${io.deps.dir}`);
  return whoami(io);
}

/** Asks until the answer passes check, or returns null when there is no terminal to ask. */
async function askUntil(io: CliIo, question: string, check: (raw: string) => string | null, retry: string): Promise<string | null> {
  for (;;) {
    const answer = await io.ask(question);
    if (answer === null) return null;
    const valid = check(answer);
    if (valid !== null) return valid;
    io.err(retry);
  }
}

/**
 * The first-run wizard: the relay (unless --relay), then the name to be known
 * by there (unless --name), then the identity and the daemon's key, then how
 * to introduce yourself to teammates. An existing identity is kept.
 */
async function setup(args: readonly string[], io: CliIo): Promise<number> {
  const s = styles(io.color);
  const { values } = parseArgs({ args: [...args], options: { name: { type: "string" }, relay: { type: "string" } } });
  const existing = await readHome(io.deps.dir).catch(() => null);
  if (existing !== null) {
    io.out(`You're already set up as ${existing.me.name} on ${new URL(existing.me.relay).host}; keeping that identity.`);
  } else {
    const relay =
      values.relay === undefined
        ? await askUntil(io, `${s.accent("Relay URL")} ${s.dim("(your team's agent-mailbox relay, https://...)")}: `, normaliseRelay, "That isn't an https URL (http is allowed only for localhost). Try again.")
        : normaliseRelay(values.relay);
    if (values.relay !== undefined && relay === null) {
      io.err("--relay must be an https URL (http only for localhost)");
      return 2;
    }
    if (relay === null) {
      io.err("no terminal to ask your relay; pass --relay <url>");
      return 2;
    }
    const name =
      values.name === undefined
        ? await askUntil(io, `${s.accent(`What name do you want to be identified as on ${new URL(relay).host}?`)} `, normaliseName, `A name is ${NAME_RULE}. Try again.`)
        : normaliseName(values.name);
    if (values.name !== undefined && name === null) {
      io.err(`--name must be ${NAME_RULE}`);
      return 2;
    }
    if (name === null) {
      io.err("no terminal to ask your name; pass --name <name>");
      return 2;
    }
    const home = await createIdentity(io, name, relay);
    if (home === null) return 1;
    io.out(`You're ${home.me.name} on ${new URL(relay).host}. Your secret key is stored on this machine and never leaves it.`);
  }
  // The status panel below shows the cert, so daemon setup's own report would only repeat it.
  const daemon = await daemonCommand(["setup"], { ...io, out: () => undefined });
  if (daemon !== 0 || existing !== null) return daemon;
  io.out("");
  await status(io);
  io.out("");
  io.out(s.accent("Next: introduce yourself to each teammate"));
  io.out(`  1. Run ${s.cmd("mailbox invite")}. It copies the command your teammates run to add you; paste it to them.`);
  io.out(`  2. Run each teammate's invite command. That's all it takes to add them.`);
  io.out(`  3. Optional: put a note on what you're working on in ${s.bold(join(shareDir(io.deps.dir), "status"))},`);
  io.out(`     then run ${s.cmd("mailbox daemon start")} so your agent can answer teammates while you're busy.`);
  return 0;
}

async function whoami(io: CliIo): Promise<number> {
  const home = await homeOrExplain(io);
  if (home === null) return 1;
  const s = styles(io.color);
  io.out(`You're ${s.bold(home.me.name)} on ${new URL(home.me.relay).host}.`);
  io.out(`Your fingerprint is ${s.bold(fingerprintOf(home.me.signPub))}.`);
  io.out(`To invite a teammate: ${s.cmd("mailbox invite")}`);
  return 0;
}

/** The exact command a teammate runs to add you: copied to the clipboard, or printed alone with --print. */
async function invite(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { print: { type: "boolean" } } });
  const home = await homeOrExplain(io);
  if (home === null) return 1;
  const command = `mailbox peer add ${inviteToken(home.me)}`;
  if (values.print === true) {
    io.out(command);
    return 0;
  }
  const s = styles(io.color);
  io.out((await io.copy(command)) ? `${s.accent("Copied")} the command your teammates run to add you:` : "Send your teammates this command, which adds you:");
  io.out(`  ${s.cmd(command)}`);
  io.out(`Paste it to them in Slack or anywhere. ${s.dim("It holds no secrets.")}`);
  return 0;
}

/**
 * Pasting a teammate's invite is all it takes to add them. Their fingerprint
 * is shown here and kept in `mailbox peers`, so anyone who wants to check it
 * against what the teammate says can do so later.
 */
async function peerAdd(args: readonly string[], io: CliIo): Promise<number> {
  const token = args[0];
  if (token === undefined) {
    io.err("usage: mailbox peer add <invite>   (the command `mailbox invite` copies, run as-is)");
    return 2;
  }
  const read = readInvite(token.trim());
  if (!read.ok) {
    io.err(read.error);
    return 1;
  }
  const them = read.contact;
  try {
    await addContact(io.deps.dir, them);
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
  const s = styles(io.color);
  io.out(`${s.accent("Added")} ${s.bold(them.name)} on ${new URL(them.relay).host}.`);
  io.out(s.dim(`Their fingerprint is ${fingerprintOf(them.signPub)}.`));
  // The hello is how they see you're connected. Only someone holding your real key can answer it.
  const hello = await send(io.deps, { to: them.pid, tag: "hello", text: `I added you on agent-mailbox.` }).catch((error: Error) => ({ delivered: false, error: error.message }));
  io.out(
    hello.delivered
      ? `Told ${them.name} you added them. Once they add you too, ${s.cmd("mailbox peers")} shows you as connected.`
      : `${them.name} will hear you added them once the relay accepts your messages.`,
  );
  return 0;
}

/** Contacts, and whether each has added you back. A swapped invite shows here as a contact that never connects. */
async function peers(io: CliIo): Promise<number> {
  if ((await homeOrExplain(io)) === null) return 1;
  await sync(io.deps).catch(() => undefined); // offline still lists what's known
  const home = await readHome(io.deps.dir);
  const heard = heardFrom(home.state);
  const s = styles(io.color);
  for (const c of home.contacts.values()) {
    if (c.pid === home.me.pid) continue;
    const link = heard.has(c.pid) ? s.accent("connected") : s.dim("waiting for them to add you");
    io.out(`${s.bold(c.name)}  ${link}  ${s.dim(`fingerprint ${fingerprintOf(c.signPub)}`)}`);
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
  // Attached, so npm's progress shows and the wizard can ask if this home has no identity yet.
  const installed = await io.attach("env", [`AGENT_MAILBOX_DIR=${root}`, "bash", join(root, "install.sh")]);
  if (installed !== 0) {
    io.err("the installer failed after pulling; its output is above");
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

/** The fastfetch-style block: who you are on which relay, what to share, and what's running. */
async function status(io: CliIo): Promise<number> {
  const home = await readHome(io.deps.dir).catch(() => null);
  if (home === null) {
    io.err("not set up yet; run: mailbox setup");
    return 1;
  }
  const heard = heardFrom(home.state);
  const others = [...home.contacts.values()].filter((c) => c.pid !== home.me.pid).map((c) => (heard.has(c.pid) ? c.name : `${c.name} (waiting)`));
  const cert = await readCert(io.deps.dir);
  const expires = cert === null ? null : Date.parse(cert.c.expires);
  const daysLeft = expires === null ? null : Math.floor((expires - io.deps.now().getTime()) / 86_400_000);
  const settings = await readFile(io.claudeSettings, "utf8").then((raw) => JSON.parse(raw) as unknown, () => null);
  const version = await io.exec("git", ["-C", io.repoRoot, "rev-parse", "--short", "HEAD"]);
  const facts: Fact[] = [
    { key: "Name", value: home.me.name, strong: true },
    { key: "Relay", value: new URL(home.me.relay).host },
    { key: "Fingerprint", value: fingerprintOf(home.me.signPub), strong: true },
    { key: "Contacts", value: others.length === 0 ? "none yet" : others.join(", ") },
    { key: "Daemon", value: (await daemonInstalled(io, home)) ? "on, and at every login" : "off (mailbox daemon start)" },
    {
      key: "Certificate",
      value:
        expires === null || daysLeft === null
          ? "none (mailbox daemon setup)"
          : daysLeft < 0
            ? "expired (mailbox daemon setup)"
            : daysLeft <= 7
              ? `expires in ${daysLeft} days (mailbox daemon setup)`
              : `good until ${new Date(expires).toISOString().slice(0, 10)}`,
    },
    { key: "Inbox hook", value: hasHook(settings) ? "on" : "off (mailbox hook install)" },
    ...(version.code === 0 && version.output !== "" ? [{ key: "Version", value: version.output }] : []),
  ];
  const title = `${home.me.name.toLowerCase().replace(/\s+/g, "-")}@agent-mailbox`;
  for (const line of renderStatus(title, facts, io.color)) io.out(line);
  return 0;
}

export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "setup":
      return setup(rest, io);
    case "keygen":
      return keygen(rest, io);
    case "whoami":
      return whoami(io);
    case "invite":
      return invite(rest, io);
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
    case "status":
      return status(io);
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
