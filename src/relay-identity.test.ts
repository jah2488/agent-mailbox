import { test } from "node:test";
import assert from "node:assert/strict";
import { PROTOCOL_VERSION } from "./protocol-version.ts";
import { describeRelay, RELAY_PROTOCOL, relayKeyFromSeed, verifyRelayDescription } from "./relay-identity.ts";

const relay = relayKeyFromSeed("A".repeat(43));
const other = relayKeyFromSeed("B".repeat(42) + "A");
const CHALLENGE = "c2hhbGxvdy1jaGFsbGVuZ2U";

test("a relay's description verifies for its own host and the challenge it was given", () => {
  const description = describeRelay(relay, "relay.example", CHALLENGE);
  const verified = verifyRelayDescription(description, "relay.example", CHALLENGE);
  assert.ok(verified.ok, JSON.stringify(verified));
  assert.equal(verified.relayKey, relay.publicKey);
  assert.equal(description.protocol, RELAY_PROTOCOL);
});

test("a description replayed for another challenge, or served for another host, is refused", () => {
  const description = describeRelay(relay, "relay.example", CHALLENGE);
  assert.deepEqual(verifyRelayDescription(description, "relay.example", "a-different-challenge"), { ok: false, error: "answered a different challenge" });
  assert.deepEqual(verifyRelayDescription(description, "lookalike.example", CHALLENGE), { ok: false, error: "describes a different host" });
});

test("a description whose signature doesn't match its key, or that speaks another protocol, is refused", () => {
  const description = describeRelay(relay, "relay.example", CHALLENGE);
  const swapped = { ...description, relay_key: other.publicKey };
  assert.deepEqual(verifyRelayDescription(swapped, "relay.example", CHALLENGE), { ok: false, error: "bad signature" });
  assert.deepEqual(verifyRelayDescription({ ...description, protocol: "agent-mailbox/0" }, "relay.example", CHALLENGE), { ok: false, error: "speaks agent-mailbox/0, not agent-mailbox/1" });
  assert.deepEqual(verifyRelayDescription("nope", "relay.example", CHALLENGE), { ok: false, error: "not a relay description" });
});

test("relay keys come from a 32-byte seed, so an operator stores one short secret", () => {
  assert.throws(() => relayKeyFromSeed("too-short"), /32-byte seed/);
  assert.equal(relayKeyFromSeed("A".repeat(43)).publicKey, relay.publicKey, "the same seed always gives the same key");
});

test("a description carries a signed version; one from before versioning reads as 1.0 and still verifies", () => {
  const description = describeRelay(relay, "relay.example", CHALLENGE);
  const verified = verifyRelayDescription(description, "relay.example", CHALLENGE);
  assert.ok(verified.ok);
  assert.equal(verified.version, PROTOCOL_VERSION);
  const { version: _v, sv: _sv, ...legacy } = description;
  const old = verifyRelayDescription(legacy, "relay.example", CHALLENGE);
  assert.ok(old.ok, "the legacy signature alone still verifies");
  assert.equal(old.version, "1.0");
});

test("a version the relay didn't sign is refused, so nobody in between can talk a relay down to an older version", () => {
  const description = describeRelay(relay, "relay.example", CHALLENGE);
  assert.deepEqual(verifyRelayDescription({ ...description, version: "1.0" }, "relay.example", CHALLENGE), { ok: false, error: "bad version signature" });
  assert.deepEqual(verifyRelayDescription({ ...description, sv: undefined }, "relay.example", CHALLENGE), { ok: false, error: "bad version signature" });
});
