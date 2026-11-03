import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type CliIo } from "./cli.ts";
import { readHome } from "./home.ts";
import { fileKeyStore } from "./keystore.ts";
import { parseRoots } from "./roots.ts";
import { parseRoster } from "./roster.ts";

/** answers are typed in order at each wizard question; when they run out, there's no terminal to ask. */
async function freshIo(answers: readonly string[] = []): Promise<CliIo & { readonly lines: string[]; readonly errors: string[]; readonly asked: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-cli-"));
  const lines: string[] = [];
  const errors: string[] = [];
  const asked: string[] = [];
  const queue = [...answers];
  return {
    lines,
    errors,
    asked,
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
    launchAgents: join(dir, "LaunchAgents"),
    claudeSettings: join(dir, "claude-settings.json"),
  };
}

test("keygen creates a home and a key, and whoami prints a roster entry others can add", async () => {
  const io = await freshIo();
  assert.equal(await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], io), 0);
  const home = await readHome(io.deps.dir);
  assert.equal(home.me.name, "Justin");
  assert.ok(await io.deps.keys.load(home.me.pid));

  io.lines.length = 0;
  assert.equal(await run(["whoami"], io), 0);
  const entryLine = io.lines.find((l) => l.startsWith("{"));
  assert.ok(entryLine, io.lines.join("\n"));
  const parsed = parseRoster(`[${entryLine}]`);
  assert.ok(parsed.ok);
  assert.ok(io.lines.some((l) => /fingerprint: ([a-z2-7]{4} ){5}[a-z2-7]{4}/.test(l)), io.lines.join("\n"));
});

test("keygen refuses to overwrite an existing identity", async () => {
  const io = await freshIo();
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], io);
  assert.equal(await run(["keygen", "--name", "Other", "--relay", "https://relay.example"], io), 1);
  assert.match(io.errors.join("\n"), /already initialised/);
  assert.equal((await readHome(io.deps.dir)).me.name, "Justin");
});

async function adasWhoami(): Promise<{ readonly entry: string; readonly fingerprint: string }> {
  const ada = await freshIo();
  await run(["keygen", "--name", "Ada", "--relay", "https://relay.example"], ada);
  ada.lines.length = 0;
  await run(["whoami"], ada);
  return {
    entry: ada.lines.find((l) => l.startsWith("{"))!,
    fingerprint: ada.lines.find((l) => l.startsWith("fingerprint: "))!.slice("fingerprint: ".length),
  };
}

test("peer add trusts a key only with the fingerprint its owner read out", async () => {
  const ada = await adasWhoami();
  const justin = await freshIo();
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], justin);
  justin.lines.length = 0;
  assert.equal(await run(["peer", "add", ada.entry, "--fingerprint", ada.fingerprint], justin), 0);
  assert.match(justin.lines.join("\n"), /Added Ada/);
  assert.equal((await readHome(justin.deps.dir)).contacts.size, 2);
});

test("peer add without a fingerprint, or with the wrong one, trusts nothing", async () => {
  const ada = await adasWhoami();
  const justin = await freshIo();
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], justin);
  assert.equal(await run(["peer", "add", ada.entry], justin), 2);
  assert.match(justin.errors.join("\n"), /--fingerprint/);
  assert.equal(await run(["peer", "add", ada.entry, "--fingerprint", "aaaa bbbb cccc dddd eeee ffff"], justin), 1);
  assert.match(justin.errors.join("\n"), /fingerprint does not match/);
  assert.equal((await readHome(justin.deps.dir)).contacts.size, 1);
});

test("peer add rejects an entry whose pid does not match its key", async () => {
  const io = await freshIo();
  await run(["keygen", "--name", "Justin", "--relay", "https://relay.example"], io);
  const other = await freshIo();
  await run(["keygen", "--name", "Grace", "--relay", "https://relay.example"], other);
  other.lines.length = 0;
  await run(["whoami"], other);
  const forged = JSON.stringify({ ...JSON.parse(other.lines.find((l) => l.startsWith("{"))!), pid: "aaaaaaaaaaaaaaaa" });
  assert.equal(await run(["peer", "add", forged, "--fingerprint", "aaaa bbbb cccc dddd eeee ffff"], io), 1);
  assert.match(io.errors.join("\n"), /pid does not match/);
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
  assert.ok(io.lines.some((l) => /mailbox whoami/.test(l)));
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
