import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity, toPeer } from "./identity.ts";
import { parseRoots, rootEntry } from "./roots.ts";

const alice = generateIdentity();
const bob = generateIdentity();

test("a root list round-trips through its JSON form", () => {
  const parsed = parseRoots(JSON.stringify([rootEntry(toPeer(alice)), rootEntry(toPeer(bob))]));
  assert.ok(parsed.ok);
  assert.deepEqual([...parsed.roots.keys()].sort(), [alice.pid, bob.pid].sort());
  assert.deepEqual(parsed.roots.get(alice.pid), toPeer(alice));
});

test("an entry whose pid does not match its signing key is refused", () => {
  const forged = { ...rootEntry(toPeer(alice)), pid: bob.pid };
  const parsed = parseRoots(JSON.stringify([forged]));
  assert.deepEqual(parsed, { ok: false, error: `root 0: pid does not match sign_pub` });
});

test("malformed root lists are refused, never half-loaded", () => {
  assert.equal(parseRoots("not json").ok, false);
  assert.equal(parseRoots("").ok, false);
  assert.deepEqual(parseRoots("[]"), { ok: false, error: "roots list is empty" });
  assert.equal(parseRoots("{}").ok, false);
  assert.equal(parseRoots(JSON.stringify([{ pid: "x" }])).ok, false);
  assert.equal(parseRoots(JSON.stringify([{ ...rootEntry(toPeer(alice)), sign_pub: "AAAA" }])).ok, false);
});

test("entries marked admin are the relay's admins; others are plain members", () => {
  const parsed = parseRoots(JSON.stringify([{ ...rootEntry(toPeer(alice)), admin: true }, rootEntry(toPeer(bob))]));
  assert.ok(parsed.ok);
  assert.deepEqual([...parsed.admins], [alice.pid]);
});
