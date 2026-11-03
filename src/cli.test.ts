import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type CliIo } from "./cli.ts";
import { readHome } from "./home.ts";
import { fingerprintOf } from "./identity.ts";
import { fileKeyStore } from "./keystore.ts";
import { parseRoots } from "./roots.ts";

/** answers are typed in order at each wizard question; when they run out, there's no terminal to ask. */
async function freshIo(answers: readonly string[] = []): Promise<CliIo & { readonly lines: string[]; readonly errors: string[]; readonly asked: string[]; readonly copied: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-cli-"));
  const lines: string[] = [];
  const errors: string[] = [];
  const asked: string[] = [];
  const copied: string[] = [];
  const queue = [...answers];
  return {
    lines,
    errors,
    asked,
    copied,
    copy: async (text) => {
      copied.push(text);
      return true;
    },
    ask: async (question) => {
      asked.push(question);
      return queue.shift() ?? null;
    },
    deps: { dir, keys: fileKeyStore(join(dir, "keys.json")), fetch: globalThis.fetch, now: () => new Date() },
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    repoRoot: "/opt/agent-mailbox",
    agentKeys: fileKeyStore(join(dir, "agent-keys.json")),
    env: {},
    stop: AbortSignal.abort(),
    exec: async () => ({ code: 0, output: "" }),
    color: false,
    launchAgents: join(dir, "LaunchAgents"),
    claudeSettings: join(dir, "claude-settings.json"),
  };
}

test("keygen creates a home and a key, and whoami says who you are in words, with no JSON", async () => {
  const io = await freshIo();
  assert.equal(await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], io), 0);
  const home = await readHome(io.deps.dir);
  assert.equal(home.me.name, "Justin");
  assert.ok(await io.deps.keys.load(home.me.pid));

  io.lines.length = 0;
  assert.equal(await run(["whoami"], io), 0);
  const text = io.lines.join("\n");
  assert.match(text, /Justin on relay\.example/);
  assert.match(text, new RegExp(fingerprintOf(home.me.signPub)));
  assert.match(text, /mailbox invite/);
  assert.ok(!text.includes("{"), text);
});

test("keygen refuses to overwrite an existing identity", async () => {
  const io = await freshIo();
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], io);
  assert.equal(await run(["keygen", "--name", "Other", "--relay", "https://relay.example"], io), 1);
  assert.match(io.errors.join("\n"), /already initialised/);
  assert.equal((await readHome(io.deps.dir)).me.name, "Justin");
});

/** Ada's invite, exactly as `mailbox invite --print` gives it, and the fingerprint she'd read out. */
async function adasInvite(): Promise<{ readonly command: string; readonly fingerprint: string }> {
  const ada = await freshIo();
  await run(["keygen", "--name", "Ada", "--relay", "https://relay.example"], ada);
  ada.lines.length = 0;
  assert.equal(await run(["invite", "--print"], ada), 0);
  assert.equal(ada.lines.length, 1, "--print writes only the command");
  return { command: ada.lines[0]!, fingerprint: fingerprintOf((await readHome(ada.deps.dir)).me.signPub) };
}

/** Runs a pasted `mailbox ...` command line the way a shell would hand it over. */
const runPasted = (command: string, io: CliIo) => run(command.replace(/^mailbox /, "").split(" "), io);

test("invite copies the exact command a teammate runs, and says to read the fingerprint on a call", async () => {
  const ada = await freshIo();
  await run(["keygen", "--name", "Ada", "--relay", "https://relay.example"], ada);
  ada.lines.length = 0;
  assert.equal(await run(["invite"], ada), 0);
  assert.match(ada.copied.at(-1) ?? "", /^mailbox peer add am1-[A-Za-z0-9_-]+$/);
  const text = ada.lines.join("\n");
  assert.match(text, /Copied/);
  assert.match(text, new RegExp(`read them your fingerprint.*${fingerprintOf((await readHome(ada.deps.dir)).me.signPub)}`, "s"));
});

test("pasting an invite shows the fingerprint and adds the person only once you confirm it was read to you", async () => {
  const ada = await adasInvite();
  const justin = await freshIo(["y"]);
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], justin);
  justin.lines.length = 0;

  assert.equal(await runPasted(ada.command, justin), 0, justin.errors.join("\n"));
  assert.match(justin.lines.join("\n"), new RegExp(ada.fingerprint));
  assert.match(justin.asked[0]!, /Did Ada read you this fingerprint/);
  assert.match(justin.lines.join("\n"), /Added Ada/);
  assert.equal((await readHome(justin.deps.dir)).contacts.size, 2);
});

test("anything but yes adds nothing", async () => {
  const ada = await adasInvite();
  for (const answer of ["n", "", "maybe"]) {
    const justin = await freshIo([answer]);
    await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], justin);
    assert.equal(await runPasted(ada.command, justin), 1);
    assert.match(justin.lines.join("\n") + justin.errors.join("\n"), /Nothing added/);
    assert.equal((await readHome(justin.deps.dir)).contacts.size, 1);
  }
});

test("with no terminal to confirm in, as when an agent runs it, an invite is refused", async () => {
  const ada = await adasInvite();
  const justin = await freshIo();
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], justin);
  assert.equal(await runPasted(ada.command, justin), 2);
  assert.match(justin.errors.join("\n"), /run it yourself in a terminal/);
  assert.equal((await readHome(justin.deps.dir)).contacts.size, 1);
});

test("an invite whose key doesn't match its pid, or that isn't an invite at all, is refused before any question", async () => {
  const ada = await adasInvite();
  const token = ada.command.split(" ").at(-1)!;
  const entry = JSON.parse(Buffer.from(token.slice("am1-".length), "base64url").toString()) as Record<string, unknown>;
  const forged = "am1-" + Buffer.from(JSON.stringify({ ...entry, pid: "aaaaaaaaaaaaaaaa" })).toString("base64url");
  const justin = await freshIo(["y"]);
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], justin);
  assert.equal(await run(["peer", "add", forged], justin), 1);
  assert.match(justin.errors.join("\n"), /pid does not match/);
  assert.equal(await run(["peer", "add", "hello"], justin), 1);
  assert.match(justin.errors.join("\n"), /not an invite/);
  assert.deepEqual(justin.asked, []);
});

test("roots prints an allowlist the relay accepts, covering me and my contacts", async () => {
  const io = await freshIo();
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], io);
  io.lines.length = 0;
  assert.equal(await run(["roots"], io), 0);
  const parsed = parseRoots(io.lines.join("\n"));
  assert.ok(parsed.ok);
  assert.equal(parsed.roots.size, 1);
});

test("install prints the setup steps and points at hook install rather than editing settings itself", async () => {
  const io = await freshIo();
  assert.equal(await run(["install"], io), 0);
  const output = io.lines.join("\n");
  assert.match(output, /claude mcp add .*agent-mailbox .*node \/opt\/agent-mailbox\/src\/mcp-main\.ts/);
  assert.match(output, /mailbox hook install/);
  await assert.rejects(readFile(io.claudeSettings, "utf8"));
});

test("an unknown command prints usage and fails", async () => {
  const io = await freshIo();
  assert.equal(await run(["frobnicate"], io), 2);
  assert.match(io.errors.join("\n"), /usage/i);
});

test("hook install merges the inbox hook into Claude settings, keeping a backup, and hook remove takes it out", async () => {
  const io = await freshIo();
  const original = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } };
  await writeFile(io.claudeSettings, JSON.stringify(original));

  assert.equal(await run(["hook", "install"], io), 0, io.errors.join("\n"));
  const installed = JSON.parse(await readFile(io.claudeSettings, "utf8"));
  assert.deepEqual(installed.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: "node /opt/agent-mailbox/src/hook.ts", timeout: 5 }] }]);
  assert.deepEqual(installed.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(JSON.parse(await readFile(`${io.claudeSettings}.agent-mailbox.bak`, "utf8")), original);

  assert.equal(await run(["hook", "remove"], io), 0);
  assert.deepEqual(JSON.parse(await readFile(io.claudeSettings, "utf8")), original);
});

test("hook install leaves a settings file it can't parse exactly as it was", async () => {
  const io = await freshIo();
  await writeFile(io.claudeSettings, "{ not json");
  assert.equal(await run(["hook", "install"], io), 1);
  assert.equal(await readFile(io.claudeSettings, "utf8"), "{ not json");
  assert.match(io.errors.join("\n"), /settings\.json/);
});

test("hook install creates settings when there are none", async () => {
  const io = await freshIo();
  assert.equal(await run(["hook", "install"], io), 0, io.errors.join("\n"));
  assert.equal(JSON.parse(await readFile(io.claudeSettings, "utf8")).hooks.UserPromptSubmit.length, 1);
});

test("hook remove with no settings file creates none", async () => {
  const io = await freshIo();
  assert.equal(await run(["hook", "remove"], io), 0);
  await assert.rejects(readFile(io.claudeSettings, "utf8"));
});

// ---- Setup wizard ----

test("setup asks for the relay, then the name it will be known by there, re-asking until each is valid", async () => {
  const io = await freshIo(["not a url", "https://relay.example", "", "Anil"]);
  assert.equal(await run(["setup"], io), 0, io.errors.join("\n"));
  assert.equal(io.asked.length, 4);
  assert.match(io.asked[0]!, /relay/i);
  assert.match(io.asked[2]!, /What name do you want to be identified as on relay\.example\?/);
  const home = await readHome(io.deps.dir);
  assert.deepEqual([home.me.name, home.me.relay], ["Anil", "https://relay.example"]);
  assert.ok(await io.deps.keys.load(home.me.pid));
  assert.ok(io.lines.some((l) => /mailbox invite/.test(l)));
  assert.ok(io.lines.some((l) => /fingerprint/i.test(l)));
});

test("setup skips the relay question when --relay is given, and both questions with --name too", async () => {
  const one = await freshIo(["David"]);
  assert.equal(await run(["setup", "--relay", "https://relay.example"], one), 0, one.errors.join("\n"));
  assert.equal(one.asked.length, 1);
  assert.match(one.asked[0]!, /name/);

  const none = await freshIo();
  assert.equal(await run(["setup", "--relay", "https://relay.example", "--name", "Sean"], none), 0, none.errors.join("\n"));
  assert.deepEqual(none.asked, []);
});

test("setup with no terminal to ask and a missing answer says which flag to pass", async () => {
  const io = await freshIo();
  assert.equal(await run(["setup", "--relay", "https://relay.example"], io), 2);
  assert.match(io.errors.join("\n"), /no terminal to ask your name; pass --name/);
});

test("setup refuses a bad --name or --relay rather than asking", async () => {
  const io = await freshIo(["Anil"]);
  assert.equal(await run(["setup", "--relay", "ftp://nope", "--name", "Anil"], io), 2);
  assert.deepEqual(io.asked, []);
  assert.match(io.errors.join("\n"), /--relay must be an https URL/);
});

test("setup on a machine that already has an identity keeps it and asks nothing", async () => {
  const io = await freshIo();
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], io);
  assert.equal(await run(["setup"], io), 0, io.errors.join("\n"));
  assert.deepEqual(io.asked, []);
  assert.equal((await readHome(io.deps.dir)).me.name, "Justin");
  assert.ok(io.lines.some((l) => /already set up as Justin/.test(l)));
});

test("setup on an existing identity renews the daemon cert for another 30 days (mailbox update runs this)", async () => {
  const io = await freshIo();
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], io);
  await run(["daemon", "setup"], { ...io, deps: { ...io.deps, now: () => new Date(Date.now() - 25 * 86_400_000) } });
  const before = Date.parse(JSON.parse(await readFile(join(io.deps.dir, "agent.json"), "utf8")).c.expires);

  assert.equal(await run(["setup"], io), 0, io.errors.join("\n"));
  const after = Date.parse(JSON.parse(await readFile(join(io.deps.dir, "agent.json"), "utf8")).c.expires);
  assert.ok(after - before > 24 * 86_400_000, `renewed by ${(after - before) / 86_400_000} days`);
});

// ---- status ----

test("status shows who you are, your fingerprint, contacts, daemon and hook beside the logo", async () => {
  const io = await freshIo();
  await run(["keygen", "--name", "Anil Kumar", "--relay", "https://relay.example"], io);
  await run(["daemon", "setup"], io);
  await run(["hook", "install"], io);
  io.lines.length = 0;

  assert.equal(await run(["status"], io), 0, io.errors.join("\n"));
  const text = io.lines.join("\n");
  const home = await readHome(io.deps.dir);
  assert.match(text, /anil-kumar@agent-mailbox/);
  assert.match(text, /Name\s+Anil Kumar/);
  assert.match(text, /Relay\s+relay\.example/);
  assert.match(text, new RegExp(`Fingerprint\\s+${fingerprintOf(home.me.signPub)}`));
  assert.match(text, /Contacts\s+none yet/);
  assert.match(text, /Daemon\s+off \(mailbox daemon start\)/);
  assert.match(text, /Certificate\s+good until \d{4}-\d{2}-\d{2}/);
  assert.match(text, /Inbox hook\s+on/);
  assert.ok(!text.includes("\x1b"), "no color when io.color is false");
});

test("status before setup says how to start", async () => {
  const io = await freshIo();
  assert.equal(await run(["status"], io), 1);
  assert.match(io.errors.join("\n"), /mailbox setup/);
});
