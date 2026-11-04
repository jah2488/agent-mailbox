// `mailbox doctor`: checks the whole setup and says what's wrong and how to
// fix it. Where a fix is safe to do automatically it asks first, and does it
// only on a yes; otherwise it prints the command. Problems exit 1; warnings
// alone (a broad share folder, say) are reported but pass.
import { appendFile, readFile, chmod, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonInstalled } from "./cli-daemon.ts";
import { hookCommand, type CliIo } from "./cli.ts";
import { hasAskRule, hasHook } from "./claude-settings.ts";
import { loadPolicy, readCert } from "./daemon-files.ts";
import { readHome, type Home } from "./home.ts";
import { checkRelay } from "./relay-check.ts";
import { readSettings, resolveFolder } from "./settings.ts";

type Fix = { readonly how: string; readonly apply?: () => Promise<string> };
type Finding = { readonly level: "ok" | "warn" | "fail"; readonly text: string; readonly fix?: Fix };
const ok = (text: string): Finding => ({ level: "ok", text });
const warn = (text: string, fix?: Fix): Finding => ({ level: "warn", text, ...(fix === undefined ? {} : { fix }) });
const fail = (text: string, fix?: Fix): Finding => ({ level: "fail", text, ...(fix === undefined ? {} : { fix }) });

const MIN_NODE = [22, 18] as const;

function pathCheck(io: CliIo): Finding {
  const home = io.env["HOME"] ?? homedir();
  const bin = join(home, ".local", "bin");
  if ((io.env["PATH"] ?? "").split(":").includes(bin)) return ok("~/.local/bin is on your PATH");
  const shell = (io.env["SHELL"] ?? "").endsWith("bash") ? ".bash_profile" : ".zshrc";
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  return fail("~/.local/bin isn't on your PATH, so the mailbox command only runs by its full path", {
    how: `add ${line} to ~/${shell}`,
    apply: async () => {
      await appendFile(join(home, shell), `\n# Added by mailbox doctor\n${line}\n`);
      return `added it to ~/${shell}; open a new terminal`;
    },
  });
}

function nodeCheck(): Finding {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const new_enough = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return new_enough ? ok(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} is older than ${MIN_NODE.join(".")}`, { how: "install Node 22.18 or newer" });
}

async function homeChecks(io: CliIo): Promise<readonly Finding[]> {
  const info = await stat(io.deps.dir).catch(() => null);
  if (info === null) return [fail(`${io.deps.dir} doesn't exist`, { how: "mailbox setup" })];
  const findings: Finding[] = [];
  if ((info.mode & 0o077) !== 0) {
    findings.push(warn(`${io.deps.dir} can be read by other users on this Mac`, { how: `chmod 700 ${io.deps.dir}`, apply: async () => (await chmod(io.deps.dir, 0o700), "made it private") }));
  }
  return findings;
}

async function identityCheck(io: CliIo, home: Home): Promise<Finding> {
  const root = await io.deps.keys.load(home.me.pid).catch(() => null);
  return root === null ? fail(`your root key for ${home.me.name} isn't in the key store`, { how: "restore it, or run mailbox setup to make a new identity" }) : ok("your identity and root key are here");
}

async function relayChecks(io: CliIo, home: Home): Promise<readonly Finding[]> {
  const relays = [home.me.relay, ...new Set([...home.contacts.values()].map((c) => c.relay).filter((r) => r !== home.me.relay))];
  return Promise.all(
    relays.map(async (relay) => {
      const host = new URL(relay).host;
      const mine = relay === home.me.relay;
      const checked = await checkRelay(io.deps, relay);
      const label = mine ? `your relay ${host}` : `a contact's relay ${host}`;
      if (!checked.ok) return (mine ? fail : warn)(`${label} ${checked.error}`, { how: `mailbox relay verify ${relay}` });
      if (checked.notice !== undefined) return warn(`${label}: ${checked.notice}`);
      return ok(`${label} proves its identity (protocol ${checked.version})`);
    }),
  );
}

async function configChecks(io: CliIo, home: Home): Promise<readonly Finding[]> {
  const read = await readSettings(io.deps.dir, io.env["HOME"] ?? homedir());
  if (!read.ok) return read.errors.map((e) => fail(`config.toml: ${e}`, { how: `edit ${join(io.deps.dir, "config.toml")}` }));
  const findings: Finding[] = [ok(read.exists ? "config.toml is valid" : "config.toml isn't there, so the defaults apply")];
  for (const w of read.warnings) findings.push(warn(w, { how: "share a narrower folder; edit config.toml, then mailbox policy sign" }));
  // Drift only matters once a daemon has a signed policy to compare with.
  if ((await readCert(io.deps.dir)) !== null) {
    const policy = await loadPolicy(io.deps.dir, home.me);
    if (!policy.ok) {
      findings.push(fail(`the daemon's policy: ${policy.error}`, { how: "mailbox policy sign" }));
    } else {
      const listed = read.settings.share.folders;
      const wanted = listed === null ? null : Object.fromEntries(Object.entries(listed).map(([n, p]) => [n, resolveFolder(p, io.env["HOME"] ?? homedir())]));
      if (JSON.stringify(wanted) !== JSON.stringify(policy.folders ?? null)) {
        findings.push(warn("config.toml's share folders aren't signed yet: your daemon still reads the old ones", { how: "mailbox policy sign" }));
      }
    }
  }
  return findings;
}

async function agentChecks(io: CliIo): Promise<readonly Finding[]> {
  const settings = await readFile(io.claudeSettings, "utf8").then((t) => JSON.parse(t) as unknown, () => ({}));
  const wired = hasHook(settings as never) && hasAskRule(settings as never);
  const hook = wired
    ? ok("the inbox hook and the send approval rule are in your agent's settings")
    : fail("the inbox hook or the send approval rule is missing from your agent's settings", {
        how: "mailbox hook install",
        apply: async () => ((await hookCommand("install", { ...io, out: () => undefined })) === 0 ? "installed them" : "couldn't; run mailbox hook install"),
      });
  const registered = (await io.exec("claude", ["mcp", "get", "agent-mailbox"])).code === 0;
  const server = `node ${io.repoRoot}/src/mcp-main.ts`;
  const mcp = registered
    ? ok("the MCP server is registered with your agent")
    : fail("the MCP server isn't registered with your agent", {
        how: `claude mcp add --scope user agent-mailbox -- ${server}`,
        apply: async () => ((await io.exec("claude", ["mcp", "add", "--scope", "user", "agent-mailbox", "--", "node", `${io.repoRoot}/src/mcp-main.ts`])).code === 0 ? "registered it; restart your agent" : "couldn't; run the command above"),
      });
  return [hook, mcp];
}

async function daemonChecks(io: CliIo, home: Home): Promise<readonly Finding[]> {
  if (!(await daemonInstalled(io, home))) return [];
  const cert = await readCert(io.deps.dir);
  if (cert === null) return [fail("the daemon is on but has no cert", { how: "mailbox daemon setup" })];
  const days = Math.floor((Date.parse(cert.c.expires) - io.deps.now().getTime()) / 86_400_000);
  if (days < 0) return [fail("the daemon's cert has expired, so it can't answer", { how: "mailbox daemon setup" })];
  return [days < 7 ? warn(`the daemon's cert runs out in ${days} days`, { how: "mailbox daemon setup" }) : ok(`the daemon's cert is good for ${days} more days`)];
}

export async function doctor(io: CliIo): Promise<number> {
  const home = await readHome(io.deps.dir).catch(() => null);
  const findings: Finding[] = [pathCheck(io), nodeCheck(), ...(await homeChecks(io))];
  if (home === null) findings.push(fail("no agent-mailbox identity here yet", { how: "mailbox setup" }));
  else {
    findings.push(await identityCheck(io, home), ...(await relayChecks(io, home)), ...(await configChecks(io, home)), ...(await agentChecks(io)), ...(await daemonChecks(io, home)));
  }
  let problems = 0;
  let warnings = 0;
  for (const f of findings) {
    io.out(`${{ ok: "✓", warn: "⚠", fail: "✗" }[f.level]} ${f.text}`);
    if (f.fix === undefined) {
      if (f.level === "fail") problems++;
      if (f.level === "warn") warnings++;
      continue;
    }
    io.out(`   to fix: ${f.fix.how}`);
    const approved = f.fix.apply !== undefined && /^y(es)?$/i.test((await io.ask("   Fix this now? [y/N] "))?.trim() ?? "");
    if (approved) {
      io.out(`   fixed: ${await f.fix.apply!()}`);
      continue;
    }
    if (f.level === "fail") problems++;
    if (f.level === "warn") warnings++;
  }
  io.out(problems + warnings === 0 ? "No problems found." : `${problems} problem${problems === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.`);
  return problems === 0 ? 0 : 1;
}
