import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuditEvent } from "./audit.ts";
import { receive, send } from "./client.ts";
import { fresh, runDaemon, tick, type DaemonDeps } from "./daemon.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import { DEFAULT_RESPONDER, type ResponderResult } from "./responder.ts";
import type { ShareFile } from "./share.ts";
import { daemonOf, world, type Person } from "./test-world.ts";

const STATUS: ShareFile = { path: "status/today.md", content: "Shipping the relay redeploy today." };

async function daemonFor(person: Person, options: { readonly files?: readonly ShareFile[]; readonly respond?: (prompt: string) => Promise<ResponderResult> } = {}) {
  const audit: AuditEvent[] = [];
  const prompts: string[] = [];
  const deps: DaemonDeps = {
    client: await daemonOf(person),
    policy: async () => ({ ok: true, cedar: DEFAULT_POLICY, version: 7, responder: DEFAULT_RESPONDER, hash: "b2:policy" }),
    share: async () => options.files ?? [STATUS],
    respond: async (prompt) => {
      prompts.push(prompt);
      return options.respond === undefined ? { kind: "answer", text: "Bob is shipping the relay redeploy today." } : options.respond(prompt);
    },
    audit: async (event) => {
      audit.push(event);
    },
    since: new Date(0).toISOString(),
  };
  return { deps, audit, prompts };
}

test("an ask the policy covers is answered by the agent, threaded to the ask, and audited", async () => {
  const { alice, bob } = await world();
  const daemon = await daemonFor(bob);
  const asked = await send(alice.deps, { to: "Bob", tag: "ask", text: "what are you shipping?" });

  await tick(daemon.deps, fresh);

  const { messages } = await receive(alice.deps, { reply_to: asked.ref });
  assert.deepEqual(messages.map((m) => [m.body.tag, m.body.prose, m.via, m.hops]), [["reply", "Bob is shipping the relay redeploy today.", { kind: "agent", name: "daemon" }, 1]]);
  assert.match(daemon.prompts[0]!, /Shipping the relay redeploy today\./);
  assert.deepEqual(daemon.audit.map((e) => e.kind), ["decision", "reply_sent"]);
  assert.deepEqual(daemon.audit[0]!.data, { ref: asked.ref, from: alice.id.pid, policy: { version: 7, hash: "b2:policy" }, outcome: "ask-model", files: ["status/today.md"], flagged: false });
  assert.equal((daemon.audit[1]!.data as { status: string }).status, "answered");
});

test("an ask nothing shared covers is deferred to the owner without asking the model, and the reason stays private", async () => {
  const { alice, bob } = await world();
  const daemon = await daemonFor(bob, { files: [{ path: "secret/keys.md", content: "hunter2" }] });
  const asked = await send(alice.deps, { to: "Bob", tag: "ask", text: "keys?" });

  await tick(daemon.deps, fresh);

  const { messages } = await receive(alice.deps, { reply_to: asked.ref });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0]!.body.payload, { status: "deferred" });
  assert.doesNotMatch(messages[0]!.body.prose ?? "", /shares|covers|policy|hunter2/);
  assert.deepEqual(daemon.prompts, []);
  assert.deepEqual(daemon.audit.map((e) => [e.kind, (e.data as { status?: string }).status]), [["decision", undefined], ["reply_sent", "deferred"]]);
});

test("a drafted answer carrying a secret is deferred and never sent", async () => {
  const { alice, bob } = await world();
  const leak = "the key is nfp_" + "a".repeat(40);
  const daemon = await daemonFor(bob, { respond: async () => ({ kind: "answer", text: leak }) });
  const asked = await send(alice.deps, { to: "Bob", tag: "ask", text: "token?" });

  await tick(daemon.deps, fresh);

  const { messages } = await receive(alice.deps, { reply_to: asked.ref });
  assert.deepEqual(messages.map((m) => m.body.payload), [{ status: "deferred" }]);
  assert.doesNotMatch(JSON.stringify(messages), /nfp_/);
  assert.deepEqual(daemon.audit.map((e) => [e.kind, (e.data as { status?: string }).status]), [["decision", undefined], ["reply_sent", "deferred"]]);
});

test("an unreadable policy defers every ask", async () => {
  const { alice, bob } = await world();
  const daemon = await daemonFor(bob);
  const deps: DaemonDeps = { ...daemon.deps, policy: async () => ({ ok: false, error: "bad signature" }) };
  const asked = await send(alice.deps, { to: "Bob", tag: "ask", text: "status?" });

  await tick(deps, fresh);

  const { messages } = await receive(alice.deps, { reply_to: asked.ref });
  assert.deepEqual(messages.map((m) => m.body.payload), [{ status: "deferred" }]);
  assert.deepEqual(daemon.prompts, []);
  assert.match((daemon.audit[0]!.data as { reason: string }).reason, /policy unavailable: bad signature/);
});

test("an ask is answered once, however many ticks follow", async () => {
  const { alice, bob } = await world();
  const daemon = await daemonFor(bob);
  await send(alice.deps, { to: "Bob", tag: "ask", text: "status?" });

  let handled = await tick(daemon.deps, fresh);
  handled = await tick(daemon.deps, handled);
  await tick(daemon.deps, handled);

  assert.equal(daemon.prompts.length, 1);
  assert.deepEqual(daemon.audit.map((e) => e.kind), ["decision", "reply_sent"]);
});

test("an ask sent by another agent is ignored, audited once, and never answered", async () => {
  const { alice, bob } = await world();
  const daemon = await daemonFor(bob);
  const asked = await send(await daemonOf(alice), { to: "Bob", tag: "ask", text: "status?" });

  const handled = await tick(daemon.deps, fresh);
  await tick(daemon.deps, handled);

  assert.deepEqual((await receive(alice.deps, { reply_to: asked.ref })).messages, []);
  assert.deepEqual(daemon.audit.map((e) => [e.kind, (e.data as { outcome?: string }).outcome]), [["decision", "ignore"]]);
});

test("asks received before the daemon started are left for the owner", async () => {
  const { alice, bob } = await world();
  await send(alice.deps, { to: "Bob", tag: "ask", text: "old question" });
  await receive(bob.deps, {});
  const daemon = await daemonFor(bob);

  await tick({ ...daemon.deps, since: new Date(Date.now() + 1000).toISOString() }, fresh);

  assert.deepEqual(daemon.prompts, []);
  assert.deepEqual(daemon.audit, []);
});

test("the loop outlives a failing tick and stops when aborted", async () => {
  const { alice, bob } = await world();
  const daemon = await daemonFor(bob);
  let policyCalls = 0;
  const flaky: DaemonDeps = {
    ...daemon.deps,
    policy: async () => {
      policyCalls++;
      if (policyCalls === 1) throw new Error("disk hiccup");
      return { ok: true, cedar: DEFAULT_POLICY, version: 7, responder: DEFAULT_RESPONDER, hash: "b2:policy" };
    },
  };
  await send(alice.deps, { to: "Bob", tag: "ask", text: "status?" });
  const stop = new AbortController();
  const logged: string[] = [];
  const running = runDaemon(flaky, { intervalMs: 1, signal: stop.signal, log: (line) => logged.push(line) });
  while (!daemon.audit.some((e) => e.kind === "reply_sent")) await new Promise((resolve) => setTimeout(resolve, 5));
  stop.abort();
  await running;
  assert.match(logged[0]!, /disk hiccup/);
  assert.deepEqual(daemon.audit.map((e) => e.kind), ["decision", "reply_sent"]);
});

test("when the model defers, the files it was shown are still on the record", async () => {
  const { alice, bob } = await world();
  const daemon = await daemonFor(bob, { respond: async () => ({ kind: "defer", reason: "not in the files" }) });
  await send(alice.deps, { to: "Bob", tag: "ask", text: "lunch?" });

  await tick(daemon.deps, fresh);

  assert.deepEqual((daemon.audit[0]!.data as { files: string[] }).files, ["status/today.md"]);
  assert.deepEqual(daemon.audit[1]!.data, { ref: (daemon.audit[0]!.data as { ref: string }).ref, from: alice.id.pid, status: "deferred", reason: "not in the files", reply: (daemon.audit[1]!.data as { reply: string }).reply, delivered: true });
});

test("a drafted answer whose send failed is resent next tick without asking the model again", async () => {
  const { alice, bob } = await world();
  const daemon = await daemonFor(bob);
  // The second key load is the send's; fail it once, as a lock timeout or a key-store hiccup would.
  let loads = 0;
  const keys = daemon.deps.client.keys;
  const flaky: DaemonDeps = {
    ...daemon.deps,
    client: { ...daemon.deps.client, keys: { ...keys, load: async (pid) => (++loads === 2 ? Promise.reject(new Error("keychain locked")) : keys.load(pid)) } },
  };
  const asked = await send(alice.deps, { to: "Bob", tag: "ask", text: "status?" });

  const handled = await tick(flaky, fresh);
  await tick(flaky, handled);

  assert.equal(daemon.prompts.length, 1);
  assert.equal((await receive(alice.deps, { reply_to: asked.ref })).messages.length, 1);
  assert.deepEqual(daemon.audit.map((e) => e.kind), ["decision", "error", "decision", "reply_sent"]);
});
