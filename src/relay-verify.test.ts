import { test } from "node:test";
import assert from "node:assert/strict";
import { generateIdentity, toPeer } from "./identity.ts";
import { memoryStore } from "./memory-store.ts";
import { handle } from "./relay.ts";
import { relayKeyFromSeed } from "./relay-identity.ts";
import { fullChecks, readOnlyChecks } from "./relay-verify.ts";

const ids = { alice: generateIdentity(), bob: generateIdentity(), carol: generateIdentity() };
const roots = new Map(Object.values(ids).map((id) => [id.pid, toPeer(id)]));
const BASE = "https://relay.test";

/** A conforming relay in memory, optionally broken by a wrapper that answers some requests itself. */
function relayFetch(breakWith?: (req: Request) => Response | undefined): typeof fetch {
  const deps = { store: memoryStore(), roots, now: () => new Date(), identity: relayKeyFromSeed("A".repeat(43)), join: { kind: "any-member" } as const };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    return breakWith?.(req.clone()) ?? handle(req, deps);
  }) as typeof fetch;
}
const failed = (checks: readonly { label: string; pass: boolean }[]) => checks.filter((c) => !c.pass).map((c) => c.label);

test("a conforming relay passes every read-only check", async () => {
  const checks = await readOnlyChecks(relayFetch(), BASE);
  assert.deepEqual(failed(checks), []);
  assert.ok(checks.length >= 9);
});

test("a relay that serves inbox reads without a signature fails the unsigned-read check, and the identity check that probes for it", async () => {
  const leaky = relayFetch((req) => (req.method === "GET" && new URL(req.url).pathname.startsWith("/inbox/") && !req.headers.has("authorization") ? Response.json({ entries: [] }) : undefined));
  assert.deepEqual(failed(await readOnlyChecks(leaky, BASE)), ["it proves its identity, signed for this host and a fresh challenge", "an unsigned inbox read is refused (401 unauthorized)"]);
});

test("a relay that stores mail from anyone fails the non-member write check", async () => {
  const open = relayFetch((req) => (req.method === "PUT" ? Response.json({ ok: true }, { status: 201 }) : undefined));
  assert.ok(failed(await readOnlyChecks(open, BASE)).includes("an envelope from a non-member is refused (403 unknown_sender)"));
});

test("with founder keys, the full run checks writes, chains, forks, reads and a write race", async () => {
  const checks = await fullChecks(relayFetch(), BASE, ids, 3);
  assert.deepEqual(failed(checks), []);
  assert.ok(checks.some((c) => c.label.startsWith("concurrent writes")));
});

test("a relay that lets a second write at the same seq overwrite the first fails the fork check", async () => {
  let puts = 0;
  const forgetful = relayFetch((req) => (req.method === "PUT" && new URL(req.url).pathname === `/log/${ids.alice.pid}/0` && ++puts === 3 ? Response.json({}, { status: 201 }) : undefined));
  assert.ok(failed(await fullChecks(forgetful, BASE, ids, 1)).includes("a different envelope at the same seq is refused (409 fork)"));
});
