import { test } from "node:test";
import assert from "node:assert/strict";
import { issueCert, verifyCert } from "./cert.ts";
import { generateIdentity, toPeer } from "./identity.ts";

const justin = generateIdentity();
const daemon = generateIdentity(); // only its signing key matters here
const other = generateIdentity();
const now = new Date("2026-11-02T12:00:00Z");

test("a cert issued by a root verifies against that root's roster entry", () => {
  const cert = issueCert(justin, { agentSignPub: daemon.signPub, name: "daemon", device: "laptop", now });
  const verified = verifyCert(cert, toPeer(justin), now);
  assert.ok(verified.ok, verified.ok ? "" : verified.error);
  assert.deepEqual(verified.agentSignPub, daemon.signPub);
  assert.equal(verified.name, "daemon");
});

test("a cert never verifies against someone else's root", () => {
  const cert = issueCert(justin, { agentSignPub: daemon.signPub, name: "daemon", device: "laptop", now });
  assert.deepEqual(verifyCert(cert, toPeer(other), now), { ok: false, error: "cert is for a different person" });
});

test("a cert that names the right person but was signed by another key is refused", () => {
  const forged = issueCert(other, { agentSignPub: daemon.signPub, name: "daemon", device: "laptop", now });
  const relabelled = { ...forged, c: { ...forged.c, person: justin.pid } };
  assert.deepEqual(verifyCert(relabelled, toPeer(justin), now), { ok: false, error: "bad cert signature" });
});

test("certs expire, and one from the future is refused too", () => {
  const cert = issueCert(justin, { agentSignPub: daemon.signPub, name: "daemon", device: "laptop", now, ttlDays: 30 });
  assert.equal(verifyCert(cert, toPeer(justin), new Date("2026-12-03T12:00:00Z")).ok, false);
  assert.equal(verifyCert(cert, toPeer(justin), new Date("2026-11-02T11:00:00Z")).ok, false);
  assert.equal(verifyCert(cert, toPeer(justin), new Date("2026-11-02T11:56:00Z")).ok, true, "5 minutes of clock skew is tolerated");
});

test("editing any cert field breaks its signature", () => {
  const cert = issueCert(justin, { agentSignPub: daemon.signPub, name: "daemon", device: "laptop", now });
  const stretched = { ...cert, c: { ...cert.c, expires: "2099-01-01T00:00:00.000Z" } };
  assert.deepEqual(verifyCert(stretched, toPeer(justin), now), { ok: false, error: "bad cert signature" });
});
