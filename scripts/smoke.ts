// End-to-end check of a running relay (netlify dev or a deploy).
//   node scripts/smoke.ts keys <dir>          write 3 test identities + roots.json
//   node scripts/smoke.ts run <dir> <url>     exercise the relay; exit 1 on any failure
// Identities are throwaway: they only exist for the relay under test.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashOf, seal, type Hash } from "../src/envelope.ts";
import { generateIdentity, pidOf, toPeer, type Identity } from "../src/identity.ts";
import { signRequest } from "../src/request-auth.ts";
import { rootEntry } from "../src/roots.ts";
import sodium from "../src/sodium.ts";

const NAMES = ["alice", "bob", "carol"] as const;
type Name = (typeof NAMES)[number];

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);

function writeKeys(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const ids = Object.fromEntries(NAMES.map((name) => [name, generateIdentity()])) as Record<Name, Identity>;
  const secrets = Object.fromEntries(
    NAMES.map((name) => [name, { sign_sec: b64(ids[name].signSec), sign_pub: b64(ids[name].signPub), box_sec: b64(ids[name].boxSec), box_pub: b64(ids[name].boxPub) }]),
  );
  writeFileSync(join(dir, "keys.json"), JSON.stringify(secrets, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, "roots.json"), JSON.stringify(NAMES.map((name) => rootEntry(toPeer(ids[name])))));
  console.log(`wrote ${join(dir, "keys.json")} and roots.json`);
}

function readKeys(dir: string): Record<Name, Identity> {
  const raw = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8")) as Record<Name, Record<string, string>>;
  const load = (k: Record<string, string>): Identity => {
    const signPub = unb64(k["sign_pub"]!);
    return { pid: pidOf(signPub), signPub, signSec: unb64(k["sign_sec"]!), boxPub: unb64(k["box_pub"]!), boxSec: unb64(k["box_sec"]!) };
  };
  return { alice: load(raw.alice), bob: load(raw.bob), carol: load(raw.carol) };
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`${pass ? "✓" : "✗"} ${label}${pass ? "" : `: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
}

async function run(dir: string, base: string): Promise<void> {
  const { alice, bob, carol } = readKeys(dir);
  const runTag = Date.now();
  const wire = (from: Identity, to: Identity, seq: number, prev: Hash | null) => {
    const sealed = seal({ from, to: toPeer(to), seq, prev, ts: new Date().toISOString(), body: { tag: "ask", ref: `smoke-${runTag}`, payload: { seq } } });
    if (!sealed.ok) throw new Error(sealed.error);
    return sealed.wire;
  };
  const put = (from: Identity, seq: number, bytes: Uint8Array<ArrayBuffer>) => fetch(`${base}/log/${from.pid}/${seq}`, { method: "PUT", body: bytes, headers: { "content-type": "application/json" } });
  const get = (path: string, as: Identity) =>
    fetch(`${base}${path}`, { headers: { authorization: signRequest({ method: "GET", host: new URL(base).host, path, ts: new Date().toISOString() }, as) } });

  // Each run uses fresh identities' first seqs, so rerunning needs fresh keys.
  const first = wire(alice, bob, 0, null);
  check("PUT seq 0 -> 201", (await put(alice, 0, first)).status, 201);
  check("identical retry -> 200", (await put(alice, 0, first)).status, 200);
  check("different envelope at seq 0 -> 409", (await put(alice, 0, wire(alice, bob, 0, null))).status, 409);
  check("PUT seq 1 chained -> 201", (await put(alice, 1, wire(alice, bob, 1, hashOf(first)))).status, 201);

  const inbox = await get(`/inbox/${bob.pid}`, bob);
  check("bob lists his inbox", [inbox.status, await inbox.json()], [200, { entries: [{ from: alice.pid, seq: 0 }, { from: alice.pid, seq: 1 }] }]);
  const fetched = await get(`/log/${alice.pid}/0`, bob);
  const fetchedBytes = new Uint8Array(await fetched.arrayBuffer());
  check("bob fetches identical bytes", [fetched.status, fetchedBytes.length === first.length && sodium.memcmp(fetchedBytes, first)], [200, true]);
  check("carol cannot read bob's inbox -> 403", (await get(`/inbox/${bob.pid}`, carol)).status, 403);
  check("unsigned read -> 401", (await fetch(`${base}/inbox/${bob.pid}`)).status, 401);

  // U2: concurrent PUTs of different envelopes at one seq. Exactly one may win.
  const rounds = 50;
  let doubleWins = 0;
  let seq = 2;
  let prev = (await (await get(`/log/${alice.pid}/1`, alice)).arrayBuffer().then((b) => hashOf(new Uint8Array(b))));
  for (let round = 0; round < rounds; round++, seq++) {
    const a = wire(alice, carol, seq, prev);
    const b = wire(alice, carol, seq, prev);
    const statuses = (await Promise.all([put(alice, seq, a), put(alice, seq, b)])).map((r) => r.status).sort();
    if (statuses[0] === 201 && statuses[1] === 201) doubleWins++;
    const stored = await get(`/log/${alice.pid}/${seq}`, alice);
    prev = hashOf(new Uint8Array(await stored.arrayBuffer()));
  }
  check(`U2 race: ${rounds} rounds, rounds where both PUTs won`, doubleWins, 0);

  console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

const [mode, dir, url] = process.argv.slice(2);
if (mode === "keys" && dir) writeKeys(dir);
else if (mode === "run" && dir && url) await run(dir, url.replace(/\/$/, ""));
else {
  console.error("usage: smoke.ts keys <dir> | run <dir> <url>");
  process.exit(2);
}
