import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, signPolicyFile } from "./daemon-files.ts";
import { generateIdentity, toPeer } from "./identity.ts";
import { DEFAULT_POLICY } from "./policy.ts";
import { DEFAULT_RESPONDER } from "./responder.ts";

const root = generateIdentity();
const home = () => mkdtemp(join(tmpdir(), "mailbox-daemon-files-"));
async function responderOf(dir: string) {
  const loaded = await loadPolicy(dir, toPeer(root));
  assert.ok(loaded.ok, JSON.stringify(loaded));
  return loaded.responder;
}

test("a signed policy loads; an older one put back afterwards is refused", async () => {
  const dir = await home();
  await writeFile(join(dir, "policy.cedar"), DEFAULT_POLICY);
  assert.deepEqual(await signPolicyFile(dir, root), { ok: true, version: 1 });
  const v1 = await readFile(join(dir, "policy.json"), "utf8");
  assert.equal((await loadPolicy(dir, toPeer(root))).ok, true);

  assert.deepEqual(await signPolicyFile(dir, root), { ok: true, version: 2 });
  assert.equal((await loadPolicy(dir, toPeer(root))).ok, true);

  await writeFile(join(dir, "policy.json"), v1);
  assert.deepEqual(await loadPolicy(dir, toPeer(root)), { ok: false, error: "policy version 1 is older than 2" });
});

test("a policy edited after signing is refused", async () => {
  const dir = await home();
  await writeFile(join(dir, "policy.cedar"), DEFAULT_POLICY);
  await signPolicyFile(dir, root);
  const signed = JSON.parse(await readFile(join(dir, "policy.json"), "utf8"));
  await writeFile(join(dir, "policy.json"), JSON.stringify({ ...signed, p: { ...signed.p, cedar: "permit(principal, action, resource);" } }));
  assert.deepEqual(await loadPolicy(dir, toPeer(root)), { ok: false, error: "bad policy signature" });
});

test("a policy that does not parse is never signed", async () => {
  const dir = await home();
  await writeFile(join(dir, "policy.cedar"), "permit(principal,");
  assert.equal((await signPolicyFile(dir, root)).ok, false);
  assert.deepEqual(await loadPolicy(dir, toPeer(root)), { ok: false, error: "no signed policy; run: mailbox policy sign" });
});

test("the responder is the default claude -p command unless a signed policy names another", async () => {
  const dir = await home();
  await writeFile(join(dir, "policy.cedar"), DEFAULT_POLICY);
  await signPolicyFile(dir, root);
  assert.deepEqual(await responderOf(dir), DEFAULT_RESPONDER);
  await writeFile(join(dir, "responder.json"), JSON.stringify({ command: ["my-model", "--quiet"] }));
  await signPolicyFile(dir, root);
  assert.deepEqual(await responderOf(dir), { command: ["my-model", "--quiet"] });
});

test("editing responder.json changes nothing until the root re-signs", async () => {
  const dir = await home();
  await writeFile(join(dir, "policy.cedar"), DEFAULT_POLICY);
  await signPolicyFile(dir, root);
  await writeFile(join(dir, "responder.json"), JSON.stringify({ command: ["/tmp/evil"] }));
  assert.deepEqual(await responderOf(dir), DEFAULT_RESPONDER);
});

test("a malformed responder.json is never signed", async () => {
  const dir = await home();
  await writeFile(join(dir, "policy.cedar"), DEFAULT_POLICY);
  await writeFile(join(dir, "responder.json"), JSON.stringify({ command: "rm -rf /" }));
  const signed = await signPolicyFile(dir, root);
  assert.equal(signed.ok, false);
  assert.match((signed as { error: string }).error, /responder\.json/);
});
