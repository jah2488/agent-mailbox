// End-to-end check of the real processes: two identities on one machine, each
// with its own MAILBOX_HOME, talking through the MCP stdio server and a live
// relay, plus the UserPromptSubmit hook.
//   node scripts/e2e.ts <alice-home> <bob-home>
// Both homes must already exist (mailbox keygen), know each other (mailbox
// peer add), and be on the relay's allowlist. Keys come from MAILBOX_KEYSTORE.
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [aliceHome, bobHome] = process.argv.slice(2);
if (!aliceHome || !bobHome) {
  console.error("usage: node scripts/e2e.ts <alice-home> <bob-home>");
  process.exit(2);
}

const envFor = (home: string): Record<string, string> => ({ ...(process.env as Record<string, string>), MAILBOX_HOME: resolve(home) });

async function serverFor(home: string): Promise<Client> {
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [join(root, "src/mcp-main.ts")], env: envFor(home) }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const out = result.content.map((c) => c.text).join("\n");
  if (result.isError) throw new Error(`${name} failed: ${out}`);
  return out;
}

function hook(home: string): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile("node", [join(root, "src/hook.ts")], { env: envFor(home) }, (error, stdout) => (error ? fail(error) : done(stdout.trim())));
    child.stdin?.end("{}");
  });
}

let failures = 0;
function check(label: string, pass: boolean, detail = ""): void {
  if (!pass) failures++;
  console.log(`${pass ? "✓" : "✗"} ${label}${pass || !detail ? "" : `\n    ${detail.replace(/\n/g, "\n    ")}`}`);
}

console.log(`e2e | ${new Date().toISOString()} | homes ${aliceHome} ${bobHome}`);
const alice = await serverFor(aliceHome);
const bob = await serverFor(bobHome);
const stamp = Date.now().toString(36);

const peers = await call(alice, "mailbox_peers");
check("alice's server lists bob", /\bBob\b/.test(peers), peers);

const sent = await call(alice, "mailbox_send", { to: "Bob", text: `e2e ask ${stamp}: what are you working on?` });
const ref = /ref: (\S+)/.exec(sent)?.[1];
check("alice's send is delivered and returns a ref", /^Sent to Bob/.test(sent) && ref !== undefined, sent);

await rm(join(bobHome, "hook-cache.json"), { force: true });
const notice = await hook(bobHome);
check("bob's prompt hook announces the mail without its text", /agent-mailbox: \d+ unread/.test(notice) && !notice.includes(stamp), notice);

const inbox = await call(bob, "mailbox_receive", { from: "Alice" });
check("bob receives alice's ask, framed as untrusted", inbox.includes(`e2e ask ${stamp}`) && inbox.includes("UNTRUSTED"), inbox);

const replied = await call(bob, "mailbox_send", { to: "Alice", tag: "reply", reply_to: ref, text: `e2e reply ${stamp}: testing agent-mailbox v0.3` });
check("bob's reply is delivered", /^Sent to Alice/.test(replied), replied);

const answer = await call(alice, "mailbox_receive", { reply_to: ref, wait_seconds: 15 });
check("alice receives the reply by ref", answer.includes(`e2e reply ${stamp}`), answer);

const thread = await call(alice, "mailbox_thread", { ref });
check("alice's thread shows ask then reply", thread.indexOf(`e2e ask ${stamp}`) < thread.indexOf(`e2e reply ${stamp}`) && thread.includes("you:"), thread);

await alice.close();
await bob.close();
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
