import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, negotiate, parseVersion, securityFloor } from "./protocol-version.ts";

test("versions parse as major.minor and compare numerically", () => {
  assert.deepEqual(parseVersion("1.10"), { major: 1, minor: 10 });
  assert.equal(parseVersion("1"), null);
  assert.equal(parseVersion("1.1.0"), null);
  assert.equal(parseVersion("v1.1"), null);
  assert.equal(compareVersions("1.10", "1.9"), 1);
  assert.equal(compareVersions("1.2", "1.2"), 0);
  assert.equal(compareVersions("1.9", "2.0"), -1);
});

test("the security floor is the newest version that fixed a hole, or 1.0 when none has", () => {
  assert.equal(securityFloor([]), "1.0");
  assert.equal(securityFloor(["1.3", "1.10", "1.4"]), "1.10");
});

test("both sides at or above each other's floor talk at the older version, with a notice when they differ", () => {
  assert.deepEqual(negotiate({ mine: "1.1", theirs: "1.1", floor: "1.0", side: "relay" }), { ok: true, version: "1.1" });
  assert.deepEqual(negotiate({ mine: "1.1", theirs: "1.0", floor: "1.0", side: "relay" }), {
    ok: true,
    version: "1.0",
    notice: "the relay speaks agent-mailbox 1.0, older than your 1.1; features newer than 1.0 are off with it",
  });
  assert.deepEqual(negotiate({ mine: "1.1", theirs: "1.3", floor: "1.0", side: "relay" }), {
    ok: true,
    version: "1.1",
    notice: "the relay speaks agent-mailbox 1.3, newer than your 1.1; run mailbox update",
  });
});

test("anything below the security floor is refused, whatever else it supports", () => {
  assert.deepEqual(negotiate({ mine: "1.4", theirs: "1.2", floor: "1.3", side: "relay" }), {
    ok: false,
    error: "the relay speaks agent-mailbox 1.2, below 1.3, which fixed a security hole; its operator must update it",
  });
  assert.deepEqual(negotiate({ mine: "1.4", theirs: "garbage", floor: "1.0", side: "relay" }), { ok: false, error: "the relay sent an unreadable protocol version" });
  assert.deepEqual(negotiate({ mine: "1.4", theirs: "2.0", floor: "1.0", side: "relay" }), {
    ok: false,
    error: "the relay speaks agent-mailbox 2.0, a major version this client doesn't know; run mailbox update",
  });
});
