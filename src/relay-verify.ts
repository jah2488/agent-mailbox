// Conformance checks for a relay, run by `mailbox relay verify` and by
// scripts/smoke.ts. The read-only checks need no keys and store nothing: every
// request is one a conforming relay must refuse, or the identity probe. The
// full run writes real envelopes, so it needs throwaway identities the
// operator has added as founders (smoke.ts keys makes them).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashOf, seal, type Hash } from "./envelope.ts";
import { generateIdentity, pidOf, toPeer, type Identity } from "./identity.ts";
import { signEvent } from "./membership.ts";
import { PROTOCOL_VERSION, supports, VERSION_HEADER } from "./protocol-version.ts";
import { probeRelay } from "./relay-check.ts";
import { signRequest } from "./request-auth.ts";
import { rootEntry } from "./roots.ts";
import sodium from "./sodium.ts";

export type Check = { readonly label: string; readonly pass: boolean; readonly detail?: string };
export type TestIds = { readonly alice: Identity; readonly bob: Identity; readonly carol: Identity };

/** A status and, when there is one, the bare error code: what every check compares. */
async function outcome(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? `${res.status} ${body.error}` : String(res.status);
}
const check = (label: string, got: string, want: string): Check => (got === want ? { label, pass: true } : { label, pass: false, detail: `got ${got}, want ${want}` });

function requester(fetchFn: typeof fetch, base: string) {
  const host = new URL(base).host;
  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has(VERSION_HEADER)) headers.set(VERSION_HEADER, PROTOCOL_VERSION);
    return fetchFn(`${base}${path}`, { ...init, headers });
  };
  const signedGet = (path: string, as: Identity) => call(path, { headers: { authorization: signRequest({ method: "GET", host, path, ts: new Date().toISOString() }, as) } });
  const put = (from: Identity, seq: number, wire: Uint8Array<ArrayBuffer>) => call(`/log/${from.pid}/${seq}`, { method: "PUT", body: wire, headers: { "content-type": "application/json" } });
  return { host, call, signedGet, put };
}

function envelope(from: Identity, to: Identity, seq: number, prev: Hash | null, ref: string): Uint8Array<ArrayBuffer> {
  const sealed = seal({ from, to: toPeer(to), seq, prev, ts: new Date().toISOString(), body: { tag: "ask", ref, payload: { seq } } });
  if (!sealed.ok) throw new Error(sealed.error);
  return sealed.wire;
}

/** Checks any relay can take: identity, and the refusals the protocol requires. Stores nothing. */
export async function readOnlyChecks(fetchFn: typeof fetch, base: string): Promise<readonly Check[]> {
  const { host, call, signedGet, put } = requester(fetchFn, base);
  const stranger = generateIdentity();
  const probed = await probeRelay({ fetch: fetchFn }, base);
  const checks: Check[] = [
    probed.ok
      ? { label: "it proves its identity, signed for this host and a fresh challenge", pass: true, detail: `protocol ${probed.version}, key ${probed.relayKey}` }
      : { label: "it proves its identity, signed for this host and a fresh challenge", pass: false, detail: probed.error },
    check("a malformed challenge is refused (400 bad_challenge)", await outcome(await call("/.well-known/agent-mailbox?challenge=short")), "400 bad_challenge"),
    check("an unsigned inbox read is refused (401 unauthorized)", await outcome(await call(`/inbox/${stranger.pid}`)), "401 unauthorized"),
    check("a signed read by a non-member is refused (401 unauthorized)", await outcome(await signedGet(`/inbox/${stranger.pid}`, stranger)), "401 unauthorized"),
    check("an envelope from a non-member is refused (403 unknown_sender)", await outcome(await put(stranger, 0, envelope(stranger, generateIdentity(), 0, null, "verify"))), "403 unknown_sender"),
    check("a write without a JSON content type is refused (415)", await outcome(await call(`/log/${stranger.pid}/0`, { method: "PUT", body: "{}" })), "415 content_type_must_be_application_json"),
    check(
      "a membership event from a non-member is refused (403 not_a_member)",
      await outcome(
        await call("/members", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(signEvent({ v: 1, kind: "vouch", relay: host, member: rootEntry(toPeer(generateIdentity())), by: stranger.pid, ts: new Date().toISOString() }, stranger.signSec)),
        }),
      ),
      "403 not_a_member",
    ),
    check("a method a route doesn't take is refused (405)", await outcome(await call("/members")), "405 method_not_allowed"),
    // Status only: a host may answer paths outside the relay's routes with its own 404 page.
    check("an unknown route is 404", String((await call("/no-such-route")).status), "404"),
  ];
  // Version headers arrived in 1.1; an older relay ignores them.
  if (probed.ok && supports(probed.version, "1.1")) {
    checks.push(check("an unreadable client version is refused (400 bad_version)", await outcome(await call(`/inbox/${stranger.pid}`, { headers: { [VERSION_HEADER]: "latest" } })), "400 bad_version"));
  }
  return checks;
}

/**
 * The read-only checks plus real writes and reads, as three founders. Each run
 * writes seq 0 for alice, so every run needs fresh identities.
 */
export async function fullChecks(fetchFn: typeof fetch, base: string, { alice, bob, carol }: TestIds, raceRounds = 50): Promise<readonly Check[]> {
  const { signedGet, put } = requester(fetchFn, base);
  const ref = `verify-${Date.now()}`;
  const first = envelope(alice, bob, 0, null, ref);
  const checks: Check[] = [...(await readOnlyChecks(fetchFn, base))];
  checks.push(check("a founder's first envelope is stored (201)", await outcome(await put(alice, 0, first)), "201"));
  checks.push(check("an identical retry is accepted (200)", await outcome(await put(alice, 0, first)), "200"));
  checks.push(check("a different envelope at the same seq is refused (409 fork)", await outcome(await put(alice, 0, envelope(alice, bob, 0, null, ref))), "409 fork"));
  checks.push(check("a gap in the chain is refused (409 gap)", await outcome(await put(alice, 5, envelope(alice, bob, 5, hashOf(first), ref))), "409 gap"));
  checks.push(check("a wrong prev hash is refused (409 chain_mismatch)", await outcome(await put(alice, 1, envelope(alice, bob, 1, null, ref))), "409 chain_mismatch"));
  checks.push(check("the next envelope in the chain is stored (201)", await outcome(await put(alice, 1, envelope(alice, bob, 1, hashOf(first), ref))), "201"));

  const inbox = await signedGet(`/inbox/${bob.pid}`, bob);
  const entries = JSON.stringify(((await inbox.json().catch(() => ({}))) as { entries?: unknown }).entries ?? null);
  checks.push(check("the recipient's inbox lists both envelopes", `${inbox.status} ${entries}`, `200 ${JSON.stringify([{ from: alice.pid, seq: 0 }, { from: alice.pid, seq: 1 }])}`));
  const fetched = await signedGet(`/log/${alice.pid}/0`, bob);
  const bytes = new Uint8Array(await fetched.arrayBuffer());
  checks.push(check("the recipient fetches the exact bytes stored", `${fetched.status} ${bytes.length === first.length && sodium.memcmp(bytes, first)}`, "200 true"));
  checks.push(check("another member can't list that inbox (403 forbidden)", await outcome(await signedGet(`/inbox/${bob.pid}`, carol)), "403 forbidden"));
  checks.push(check("another member can't fetch that envelope (404 not_found)", await outcome(await signedGet(`/log/${alice.pid}/0`, carol)), "404 not_found"));

  // Concurrent writes of two different envelopes at one seq: exactly one may win.
  let doubleWins = 0;
  let prev = hashOf(new Uint8Array(await (await signedGet(`/log/${alice.pid}/1`, alice)).arrayBuffer()));
  for (let round = 0, seq = 2; round < raceRounds; round++, seq++) {
    const statuses = (await Promise.all([put(alice, seq, envelope(alice, carol, seq, prev, ref)), put(alice, seq, envelope(alice, carol, seq, prev, ref))])).map((r) => r.status);
    if (statuses.every((s) => s === 201)) doubleWins++;
    prev = hashOf(new Uint8Array(await (await signedGet(`/log/${alice.pid}/${seq}`, alice)).arrayBuffer()));
  }
  checks.push(check(`concurrent writes at one seq never both win (${raceRounds} rounds)`, `${doubleWins} double wins`, "0 double wins"));
  return checks;
}

/** The keys.json that smoke.ts keys writes: three throwaway identities, secrets included. */
export function readTestKeys(dir: string): TestIds {
  const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
  const raw = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8")) as Record<keyof TestIds, Record<string, string>>;
  const load = (k: Record<string, string> | undefined): Identity => {
    if (k === undefined) throw new Error(`${join(dir, "keys.json")} needs alice, bob and carol`);
    const signPub = unb64(k["sign_pub"]!);
    return { pid: pidOf(signPub), signPub, signSec: unb64(k["sign_sec"]!), boxPub: unb64(k["box_pub"]!), boxSec: unb64(k["box_sec"]!) };
  };
  return { alice: load(raw.alice), bob: load(raw.bob), carol: load(raw.carol) };
}
