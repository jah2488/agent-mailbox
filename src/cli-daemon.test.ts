import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run, type CliIo } from "./cli.ts";
import { receive, send } from "./client.ts";
import { readCert } from "./daemon-files.ts";
import { fileKeyStore } from "./keystore.ts";
import { world, type Person } from "./test-world.ts";

// A stand-in for `claude -p`: reads the prompt, answers in claude's --output-format json shape.
const FAKE_RESPONDER = [process.execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({structured_output:{answer:'All green.'}})))"];

function ioFor(person: Person, env: NodeJS.ProcessEnv = {}): CliIo & { readonly lines: string[]; readonly errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    deps: person.deps,
    agentKeys: fileKeyStore(join(person.deps.dir, "agent-keys.json")),
    env,
    stop: AbortSignal.abort(),
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    repoRoot: "/opt/agent-mailbox",
  };
}

async function setUp(person: Person) {
  const io = ioFor(person);
  assert.equal(await run(["daemon", "setup"], io), 0, io.errors.join("\n"));
  await writeFile(join(person.deps.dir, "responder.json"), JSON.stringify({ command: FAKE_RESPONDER }));
  await writeFile(join(person.deps.dir, "share", "status", "today.md"), "Relay redeploy is green.");
  return io;
}

test("after setup, one daemon tick answers an ask from the share folder, and the audit verifies", async () => {
  const { alice, bob } = await world();
  const io = await setUp(bob);
  const asked = await send(alice.deps, { to: "Bob", tag: "ask", text: "how is the redeploy?" });

  assert.equal(await run(["daemon", "once"], io), 0, io.errors.join("\n"));

  const { messages } = await receive(alice.deps, { reply_to: asked.ref });
  assert.deepEqual(messages.map((m) => [m.body.prose, m.via]), [["All green.", { kind: "agent", name: "daemon" }]]);
  io.lines.length = 0;
  assert.equal(await run(["audit", "verify"], io), 0, io.errors.join("\n"));
  assert.match(io.lines.join("\n"), /3 entries/);
});

test("setup never stores the root key where the daemon reads keys, and a re-run renews the same agent key", async () => {
  const { bob } = await world();
  const io = await setUp(bob);
  assert.equal(await io.agentKeys.load(bob.id.pid), null);
  const first = await readCert(bob.deps.dir);
  assert.equal(await run(["daemon", "setup"], io), 0);
  const second = await readCert(bob.deps.dir);
  assert.equal(second!.c.agent_sign_pub, first!.c.agent_sign_pub);
});

test("review lists what the daemon deferred, with the question and the private reason", async () => {
  const { alice, bob } = await world();
  const io = await setUp(bob);
  await writeFile(join(bob.deps.dir, "share", "status", "today.md"), "");
  await writeFile(join(bob.deps.dir, "responder.json"), JSON.stringify({ command: [process.execPath, "-e", "process.exit(3)"] }));
  await send(alice.deps, { to: "Bob", tag: "ask", text: "can you rotate the keys?" });
  await run(["daemon", "once"], io);

  io.lines.length = 0;
  assert.equal(await run(["review"], io), 0);
  const shown = io.lines.join("\n");
  assert.match(shown, /Alice/);
  assert.match(shown, /can you rotate the keys\?/);
  assert.match(shown, /responder exited 3/);
});

test("audit verify fails, naming the entry, once the log is edited", async () => {
  const { alice, bob } = await world();
  const io = await setUp(bob);
  await send(alice.deps, { to: "Bob", tag: "ask", text: "status?" });
  await run(["daemon", "once"], io);
  const path = join(bob.deps.dir, "audit.jsonl");
  await writeFile(path, (await readFile(path, "utf8")).replace('"answered"', '"ignored"'));

  assert.equal(await run(["audit", "verify"], io), 1);
  assert.match(io.errors.join("\n"), /entry 1: bad signature/);
});

test("install writes a launchd plist into the mailbox home and only prints the commands that load it", async () => {
  const { bob } = await world();
  const io = ioFor(bob, { MAILBOX_KEYSTORE: "file", PATH: "/usr/bin:/bin" });
  await run(["daemon", "setup"], io);
  io.lines.length = 0;
  assert.equal(await run(["daemon", "install"], io), 0, io.errors.join("\n"));

  const label = `com.agent-mailbox.daemon.${bob.id.pid}`;
  const plist = await readFile(join(bob.deps.dir, `${label}.plist`), "utf8");
  assert.match(plist, new RegExp(`<string>${label}</string>`));
  assert.match(plist, /<string>daemon<\/string>\s*<string>run<\/string>/);
  assert.match(plist, /<key>MAILBOX_KEYSTORE<\/key>\s*<string>file<\/string>/);
  assert.match(io.lines.join("\n"), /launchctl bootstrap gui\/\$\(id -u\)/);
});

test("policy sign refuses a policy that does not parse and leaves the signed one in force", async () => {
  const { bob } = await world();
  const io = await setUp(bob);
  await writeFile(join(bob.deps.dir, "policy.cedar"), "permit(principal,");
  assert.equal(await run(["policy", "sign"], io), 1);
  io.lines.length = 0;
  assert.equal(await run(["policy", "show"], io), 0);
  assert.match(io.lines.join("\n"), /version 1/);
});
