import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity, toPeer } from "./identity.ts";
import { decide, DEFAULT_POLICY, signPolicy, verifyPolicy } from "./policy.ts";

const justin = generateIdentity();
const anyone = generateIdentity();
const outsider = generateIdentity();
const contacts = new Set([anyone.pid]);

test("the default policy: status is answered, notes are flagged, secrets are refused, the rest defers", () => {
  const tier = (path: string) => decide(DEFAULT_POLICY, { principal: anyone.pid, path, contacts }).tier;
  assert.equal(tier("status/today.md"), "allow");
  assert.equal(tier("notes/plan.md"), "flag");
  assert.equal(tier("notes/secret-launch.md"), "deny");
  assert.equal(tier("status/private.md"), "deny");
  assert.equal(tier("drafts/x.md"), "defer");
});

test("someone outside the roster matches no permit, so everything defers", () => {
  assert.equal(decide(DEFAULT_POLICY, { principal: outsider.pid, path: "status/today.md", contacts }).tier, "defer");
});

test("policies can name one person, and an unannotated permit is treated as flag, never silent allow", () => {
  const cedar = `permit(principal == Person::"${anyone.pid}", action == Action::"read", resource) when { resource.path like "projects/*" };`;
  assert.equal(decide(cedar, { principal: anyone.pid, path: "projects/x.md", contacts }).tier, "flag");
  assert.equal(decide(cedar, { principal: outsider.pid, path: "projects/x.md", contacts }).tier, "defer");
});

test("a policy that does not parse decides deny for everything, failing closed", () => {
  const result = decide("permit(this is not cedar", { principal: anyone.pid, path: "status/today.md", contacts });
  assert.equal(result.tier, "deny");
});

test("a signed policy verifies against its root and reports its version", () => {
  const signed = signPolicy(justin, 3, DEFAULT_POLICY);
  const verified = verifyPolicy(signed, toPeer(justin), 0);
  assert.ok(verified.ok);
  assert.equal(verified.version, 3);
  assert.equal(verified.cedar, DEFAULT_POLICY);
});

test("an edited policy, another root's policy, or an older version is refused", () => {
  const signed = signPolicy(justin, 3, DEFAULT_POLICY);
  assert.deepEqual(verifyPolicy({ ...signed, p: { ...signed.p, cedar: "permit(principal, action, resource);" } }, toPeer(justin), 0), { ok: false, error: "bad policy signature" });
  assert.deepEqual(verifyPolicy(signPolicy(outsider, 3, DEFAULT_POLICY), toPeer(justin), 0), { ok: false, error: "bad policy signature" });
  assert.deepEqual(verifyPolicy(signed, toPeer(justin), 4), { ok: false, error: "policy version 3 is older than 4" });
});

test("a policy that does not parse is refused at verify time, before it can be used", () => {
  assert.deepEqual(verifyPolicy(signPolicy(justin, 1, "permit(oops"), toPeer(justin), 0).ok, false);
});
