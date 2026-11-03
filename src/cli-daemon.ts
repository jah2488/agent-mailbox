import { access, constants, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { appendAudit, verifyAudit, type AuditEntry, type AuditEvent } from "./audit.ts";
import { certHash, certifiedKeyOf, issueCert, verifyCert, type SignedCert } from "./cert.ts";
import type { CliIo } from "./cli.ts";
import { revokeAgent, type ClientDeps } from "./client.ts";
import { acquireDaemonLock, initDaemonFiles, loadPolicy, readCert, readSince, shareDir, signPolicyFile, writeCert } from "./daemon-files.ts";
import { fresh, runDaemon, tick, type DaemonDeps } from "./daemon.ts";
import { readHome, type Home } from "./home.ts";
import { agentIdentity, pidOf, type Identity, type Pid } from "./identity.ts";
import { runResponder } from "./responder.ts";
import { readShare } from "./share.ts";
import sodium from "./sodium.ts";

const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);

// `mailbox daemon|policy|review|audit`. Setup and policy signing need the
// root key; everything the daemon itself runs uses only the agent key.

const INTERVAL_MS = 30_000;
const AUDIT_FILE = "audit.jsonl";

type Loaded = { readonly client: ClientDeps & { readonly agentCert: SignedCert }; readonly audit: Identity; readonly name: string };

async function homeOf(io: CliIo): Promise<Home | null> {
  try {
    return await readHome(io.deps.dir);
  } catch {
    io.err(`no identity in ${io.deps.dir}; run: mailbox keygen --name <name> --relay <url>`);
    return null;
  }
}

async function rootOf(io: CliIo, home: Home): Promise<Identity | null> {
  const root = await io.deps.keys.load(home.me.pid);
  if (root === null) io.err(`this needs your root key, and there is none for ${home.me.name} in the key store`);
  return root;
}

/** The daemon's credentials, checked: a current cert from this person's root, and the agent key it names. */
async function loadAgent(io: CliIo, home: Home): Promise<Loaded | null> {
  const cert = await readCert(io.deps.dir);
  if (cert === null) {
    io.err("no agent yet; run: mailbox daemon setup");
    return null;
  }
  const verified = verifyCert(cert, home.me, io.deps.now());
  if (!verified.ok) {
    io.err(`agent cert refused (${verified.error}); renew it with: mailbox daemon setup`);
    return null;
  }
  const audit = verified.auditPub === null ? null : await io.agentKeys.load(pidOf(verified.auditPub));
  if (audit === null || (await io.agentKeys.load(pidOf(verified.agentSignPub))) === null) {
    io.err(`agent "${verified.name}" is missing a key in the agent key store; run: mailbox daemon setup`);
    return null;
  }
  return { client: { ...io.deps, keys: io.agentKeys, agentCert: cert }, audit, name: verified.name };
}

function daemonDeps(io: CliIo, home: Home, loaded: Loaded, since: string, report: (event: AuditEvent) => void): DaemonDeps {
  const dir = io.deps.dir;
  return {
    client: loaded.client,
    policy: () => loadPolicy(dir, home.me),
    share: async () => (await readShare(shareDir(dir))).files,
    respond: (prompt, responder) => runResponder(responder, prompt),
    audit: async (event) => {
      await appendAudit(dir, loaded.audit.signSec, event);
      report(event);
    },
    since,
  };
}

/** The stored key for this public key, or a fresh one saved to the agent key store. Never the root. */
async function reuseOrMint(io: CliIo, root: Identity, pub: Uint8Array | null): Promise<Identity> {
  const existing = pub === null ? null : await io.agentKeys.load(pidOf(pub));
  if (existing !== null) return existing;
  const minted = agentIdentity(root);
  await io.agentKeys.save(minted);
  return minted;
}

async function setup(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { name: { type: "string" } } });
  const home = await homeOf(io);
  if (home === null) return 1;
  const root = await rootOf(io, home);
  if (root === null) return 1;

  // A re-run renews the cert for the keys the daemon already holds, so its audit log keeps verifying.
  const previous = await readCert(io.deps.dir);
  const agent = await reuseOrMint(io, root, previous === null ? null : certifiedKeyOf(previous));
  const audit = await reuseOrMint(io, root, previous?.c.audit_pub === undefined ? null : unb64(previous.c.audit_pub));
  const cert = issueCert(root, { agentSignPub: agent.signPub, auditPub: audit.signPub, name: values.name ?? "daemon", device: hostname(), now: io.deps.now() });
  const check = verifyCert(cert, home.me, io.deps.now());
  if (!check.ok) {
    io.err(check.error);
    return 1;
  }
  await writeCert(io.deps.dir, cert);
  await initDaemonFiles(io.deps.dir, io.deps.now());
  if (!(await loadPolicy(io.deps.dir, home.me)).ok) await signPolicyFile(io.deps.dir, root);

  io.out(`Agent "${cert.c.name}" certified for ${home.me.name} until ${cert.c.expires.slice(0, 10)}. Re-run this command to renew.`);
  io.out(`Share folder: ${shareDir(io.deps.dir)}  (status/ is answered from; notes/ is answered from and flagged for your review)`);
  io.out(`Policy: ${join(io.deps.dir, "policy.cedar")}  (after editing, run: mailbox policy sign)`);
  io.out("Try one pass now: mailbox daemon once   Start it at login: mailbox daemon install");
  return 0;
}

async function runOnce(io: CliIo, forever: boolean): Promise<number> {
  const home = await homeOf(io);
  if (home === null) return 1;
  const loaded = await loadAgent(io, home);
  if (loaded === null) return 1;
  const since = await readSince(io.deps.dir);
  if (since === null) {
    io.err("no daemon start point recorded; run: mailbox daemon setup");
    return 1;
  }
  const release = await acquireDaemonLock(io.deps.dir);
  if (release === null) {
    io.err(`a daemon is already running for ${home.me.name}; stop it first (launchctl bootout, or Ctrl-C)`);
    return 1;
  }
  try {
    const deps = daemonDeps(io, home, loaded, since, (event) => io.out(`${event.kind} ${JSON.stringify(event.data)}`));
    await deps.audit({ kind: "started", data: { agent: loaded.name, mode: forever ? "run" : "once" } });
    if (forever) await runDaemon(deps, { intervalMs: INTERVAL_MS, signal: io.stop, log: io.err });
    else await tick(deps, fresh);
    await deps.audit({ kind: "stopped", data: {} });
    return 0;
  } finally {
    await release();
  }
}

async function findOnPath(program: string, path: string): Promise<string | null> {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, program);
    if (await access(candidate, constants.X_OK).then(() => true, () => false)) return candidate;
  }
  return null;
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Writes the plist into the mailbox home and prints how to load it. Never touches ~/Library or launchctl itself. */
async function install(io: CliIo): Promise<number> {
  const home = await homeOf(io);
  if (home === null) return 1;
  if ((await loadAgent(io, home)) === null) return 1;
  const label = `com.agent-mailbox.daemon.${home.me.pid}`;
  const plistPath = join(io.deps.dir, `${label}.plist`);
  const policy = await loadPolicy(io.deps.dir, home.me);
  if (!policy.ok) {
    io.err(`no policy in force (${policy.error}); run: mailbox policy sign`);
    return 1;
  }
  const responder = policy.responder.command[0]!;
  const found = responder.includes("/") ? responder : await findOnPath(responder, io.env["PATH"] ?? "");
  // launchd starts with a bare PATH, so the responder's directory is carried over explicitly.
  const path = [...new Set([...(found === null ? [] : [dirname(found)]), "/usr/bin", "/bin"])].join(delimiter);
  const env: Record<string, string> = { MAILBOX_HOME: io.deps.dir, PATH: path, ...(io.env["MAILBOX_KEYSTORE"] === undefined ? {} : { MAILBOX_KEYSTORE: io.env["MAILBOX_KEYSTORE"] }) };
  const args = [process.execPath, join(io.repoRoot, "src", "cli-main.ts"), "daemon", "run"];
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `  <key>Label</key><string>${xml(label)}</string>`,
    "  <key>ProgramArguments</key><array>",
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>EnvironmentVariables</key><dict>",
    ...Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`),
    "  </dict>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><true/>",
    "  <key>ThrottleInterval</key><integer>30</integer>",
    `  <key>StandardOutPath</key><string>${xml(join(io.deps.dir, "daemon.log"))}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(join(io.deps.dir, "daemon.log"))}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
  await writeFile(plistPath, plist, { mode: 0o600 });

  if (found === null) io.err(`warning: "${responder}" is not on your PATH; the daemon will defer every ask until it is`);
  io.out(`Wrote ${plistPath}. To start the daemon now and at every login:`);
  io.out(`  cp '${plistPath}' ~/Library/LaunchAgents/`);
  io.out(`  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${label}.plist`);
  io.out(`To stop it: launchctl bootout gui/$(id -u)/${label}`);
  io.out("macOS will show a background-item notice, and endpoint security software may flag a new launch agent.");
  return 0;
}

async function policy(args: readonly string[], io: CliIo): Promise<number> {
  const home = await homeOf(io);
  if (home === null) return 1;
  if (args[0] === "sign") {
    const root = await rootOf(io, home);
    if (root === null) return 1;
    const signed = await signPolicyFile(io.deps.dir, root);
    if (!signed.ok) {
      io.err(signed.error);
      return 1;
    }
    io.out(`Signed policy version ${signed.version}. The daemon picks it up on its next pass.`);
    return 0;
  }
  if (args[0] === "show") {
    const loaded = await loadPolicy(io.deps.dir, home.me);
    if (!loaded.ok) {
      io.err(`no policy in force: ${loaded.error}`);
      return 1;
    }
    io.out(`Policy in force: version ${loaded.version}`);
    io.out(loaded.cedar);
    return 0;
  }
  io.err("usage: mailbox policy sign|show");
  return 2;
}

async function readAudit(io: CliIo, home: Home): Promise<readonly AuditEntry[] | null> {
  const cert = await readCert(io.deps.dir);
  if (cert === null) {
    io.err("no agent yet; run: mailbox daemon setup");
    return null;
  }
  // The root's signature on agent.json is what makes its audit key trustworthy. Judged at issue time, so an expired cert's log still verifies.
  const trusted = verifyCert(cert, home.me, new Date(cert.c.issued));
  const key = trusted.ok ? trusted.auditPub : null;
  if (key === null) {
    io.err(`agent.json is not a cert your root key signed with an audit key${trusted.ok ? "" : ` (${trusted.error})`}; the audit log cannot be trusted`);
    return null;
  }
  const text = await readFile(join(io.deps.dir, AUDIT_FILE), "utf8").catch(() => "");
  const verified = verifyAudit(text, key);
  if (!verified.ok) {
    io.err(`audit log failed verification at entry ${verified.seq}: ${verified.reason}`);
    return null;
  }
  return verified.entries;
}

async function auditVerify(io: CliIo): Promise<number> {
  const home = await homeOf(io);
  if (home === null) return 1;
  const entries = await readAudit(io, home);
  if (entries === null) return 1;
  io.out(`${entries.length} entries, chain intact, every one signed by the audit key your root certified.`);
  return 0;
}

/** What needs the owner: deferred asks, answers drawn from flagged files, and errors. */
async function review(io: CliIo): Promise<number> {
  const home = await homeOf(io);
  if (home === null) return 1;
  const entries = await readAudit(io, home);
  if (entries === null) return 1;
  const needs = entries.filter((e) => {
    const data = e.data as { status?: string; flagged?: boolean };
    return e.kind === "error" || (e.kind === "reply_sent" && (data.status === "deferred" || data.flagged === true));
  });
  if (needs.length === 0) {
    io.out("Nothing needs you.");
    return 0;
  }
  for (const entry of needs) {
    const data = entry.data as { ref?: string; from?: string; status?: string; reason?: string; error?: string };
    const ask = home.state.inbox.find((m) => m.from === data.from && m.body.ref === data.ref);
    const who = home.contacts.get(data.from as Pid)?.name ?? data.from;
    const why = data.status === "answered" ? "answered from flagged files" : (data.reason ?? data.error ?? "");
    io.out(`${entry.ts.slice(0, 16)}  ${data.status ?? entry.kind}  ${who}  ref ${data.ref}  (${why})`);
    // JSON-escaped on one line: a terminal agent reading this can't mistake the asker's words for ours.
    if (ask?.body.prose !== undefined) io.out(`    untrusted text from ${who}: ${JSON.stringify(ask.body.prose.slice(0, 500))}`);
  }
  io.out("To answer one yourself, reply in Claude Code with mailbox_send and that ref as reply_to.");
  return 0;
}

/**
 * Revokes the current agent: every contact is told (as the root) to refuse
 * anything its cert signs from here on, its keys are deleted, and its cert and
 * audit log are archived side by side so the old log stays verifiable.
 */
async function revoke(io: CliIo): Promise<number> {
  const home = await homeOf(io);
  if (home === null) return 1;
  const root = await rootOf(io, home);
  if (root === null) return 1;
  const cert = await readCert(io.deps.dir);
  const trusted = cert === null ? null : verifyCert(cert, home.me, new Date(cert.c.issued));
  if (cert === null || trusted === null || !trusted.ok) {
    io.err("no agent of yours to revoke in agent.json");
    return 1;
  }
  const release = await acquireDaemonLock(io.deps.dir);
  if (release === null) {
    io.err("stop the daemon first (launchctl bootout, or Ctrl-C), then revoke");
    return 1;
  }
  try {
    const sent = await revokeAgent(io.deps, cert);
    const audit = trusted.auditPub === null ? null : await io.agentKeys.load(pidOf(trusted.auditPub));
    if (audit !== null) await appendAudit(io.deps.dir, audit.signSec, { kind: "revoked", data: { cert: certHash(cert), told: sent.map((s) => s.toName) } });
    for (const pub of [trusted.agentSignPub, trusted.auditPub]) if (pub !== null) await io.agentKeys.remove(pidOf(pub));
    const stamp = io.deps.now().toISOString().replace(/[:.]/g, "-");
    await rename(join(io.deps.dir, "agent.json"), join(io.deps.dir, `agent.revoked-${stamp}.json`));
    await rename(join(io.deps.dir, AUDIT_FILE), join(io.deps.dir, `audit.revoked-${stamp}.jsonl`)).catch(() => undefined);
    const queued = sent.filter((s) => !s.delivered).map((s) => s.toName);
    io.out(`Revoked agent "${cert.c.name}". Told ${sent.length} contact${sent.length === 1 ? "" : "s"}${queued.length > 0 ? ` (queued for ${queued.join(", ")}; delivered on the next sync)` : ""}.`);
    io.out(`If it was installed: launchctl bootout gui/$(id -u)/com.agent-mailbox.daemon.${home.me.pid}`);
    io.out("For a new agent: mailbox daemon setup");
    return 0;
  } finally {
    await release();
  }
}

export async function daemonCommand(args: readonly string[], io: CliIo): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "setup":
      return setup(rest, io);
    case "once":
      return runOnce(io, false);
    case "run":
      return runOnce(io, true);
    case "install":
      return install(io);
    case "revoke":
      return revoke(io);
  }
  io.err("usage: mailbox daemon setup [--name <agent>] | once | run | install | revoke");
  return 2;
}

export { auditVerify, policy as policyCommand, review };
