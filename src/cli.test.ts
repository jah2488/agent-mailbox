import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type CliIo } from "./cli.ts";
import { readHome } from "./home.ts";
import { fileKeyStore } from "./keystore.ts";
import { parseRoots } from "./roots.ts";
import { parseRoster } from "./roster.ts";

async function freshIo(): Promise<CliIo & { readonly lines: string[]; readonly errors: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-cli-"));
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    deps: { dir, keys: fileKeyStore(join(dir, "keys.json")), fetch: globalThis.fetch, now: () => new Date() },
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    repoRoot: "/opt/agent-mailbox",
    agentKeys: fileKeyStore(join(dir, "agent-keys.json")),
    env: {},
    stop: AbortSignal.abort(),
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

test("install prints commands with absolute paths and never edits settings itself", async () => {
  const io = await freshIo();
  assert.equal(await run(["install"], io), 0);
  const output = io.lines.join("\n");
  assert.match(output, /claude mcp add .*agent-mailbox .*node \/opt\/agent-mailbox\/src\/mcp-main\.ts/);
  assert.match(output, /UserPromptSubmit/);
  assert.match(output, /\/opt\/agent-mailbox\/src\/hook\.ts/);
});

test("an unknown command prints usage and fails", async () => {
  const io = await freshIo();
  assert.equal(await run(["frobnicate"], io), 2);
  assert.match(io.errors.join("\n"), /usage/i);
});
