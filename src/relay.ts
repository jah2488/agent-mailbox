import { hashOf, verifyOuter, type OuterError } from "./envelope.ts";
import { CHALLENGE_PATTERN, describeRelay, WELL_KNOWN_PATH, type RelayKey } from "./relay-identity.ts";
import type { Peer, Pid } from "./identity.ts";
import { verifyRequest } from "./request-auth.ts";
import sodium from "./sodium.ts";

/**
 * The relay's only side effects. Write-once here is defense in depth: the
 * receiver's chain check is what actually catches a fork, so a store that
 * degrades to last-write-wins weakens the relay without breaking safety.
 */
export type Store = {
  readonly get: (key: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  /** Writes only if the key is absent; true when this call created it. */
  readonly createOnly: (key: string, value: Uint8Array<ArrayBuffer>) => Promise<boolean>;
  /** Full keys under prefix, in no promised order. */
  readonly list: (prefix: string) => Promise<readonly string[]>;
  /** Names of the immediate child segments under prefix (prefix ends in "/"), in no promised order. */
  readonly listDirectories: (prefix: string) => Promise<readonly string[]>;
};

/**
 * Inbox index entries are grouped 1000 seqs to a bucket, so a caught-up reader
 * lists only its sender's newest bucket, not that sender's whole history.
 * Blobs list has no start-after, so buckets are what bound a read.
 * Cost per inbox read: one directory listing per root, plus one list per
 * bucket at or after the caller's head for that root, run concurrently. A
 * first read with no ?after= therefore lists every bucket of every sender.
 */
const INBOX_BUCKET = 1000;

export type RelayDeps = {
  readonly store: Store;
  readonly roots: ReadonlyMap<Pid, Peer>;
  readonly now: () => Date;
  /** The relay's own key, from MAILBOX_RELAY_KEY. Without it the relay can't prove which relay it is, and clients refuse it. */
  readonly identity?: RelayKey;
};

const PID = "[a-z2-7]{16}";
// 15 digits keeps every seq inside Number.MAX_SAFE_INTEGER. Routes and the
// inbox's ?after= share this grammar, so neither can feed the other a seq the
// bucket math was not built for.
const SEQ = "0|[1-9][0-9]{0,14}";
const LOG_ROUTE = new RegExp(`^/log/(${PID})/(${SEQ})$`);
const AFTER_SEQ = new RegExp(`^(${SEQ})$`);
const INBOX_ROUTE = new RegExp(`^/inbox/(${PID})$`);

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const bucketOf = (seq: number) => pad(Math.floor(seq / INBOX_BUCKET), 13);
const logKey = (from: string, seq: number) => `log/${from}/${pad(seq, 16)}`;
const senderPrefix = (to: string, from: string) => `inbox/${to}/${from}/`;
const inboxKey = (to: string, from: string, seq: number) => `${senderPrefix(to, from)}${bucketOf(seq)}/${pad(seq, 16)}`;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, error: string) => reply(status, { error });

const OUTER_STATUS: Readonly<Record<OuterError, number>> = {
  too_large: 413,
  malformed: 400,
  non_canonical: 400,
  unsupported: 400,
  unknown_sender: 403,
  bad_cert: 401,
  bad_signature: 401,
};

export async function handle(req: Request, deps: RelayDeps): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === WELL_KNOWN_PATH) {
    if (req.method !== "GET") return refuse(405, "method_not_allowed");
    if (deps.identity === undefined) return refuse(503, "relay_has_no_key");
    const challenge = url.searchParams.get("challenge") ?? "";
    if (!CHALLENGE_PATTERN.test(challenge)) return refuse(400, "bad_challenge");
    return reply(200, describeRelay(deps.identity, url.host, challenge));
  }
  const log = LOG_ROUTE.exec(url.pathname);
  if (log !== null) {
    const from = log[1] as Pid;
    const seq = Number(log[2]);
    if (req.method === "PUT") return putEnvelope(from, seq, req, deps);
    if (req.method === "GET") return getEnvelope(from, seq, req, url, deps);
    return refuse(405, "method_not_allowed");
  }
  const inbox = INBOX_ROUTE.exec(url.pathname);
  if (inbox !== null) {
    if (req.method === "GET") return listInbox(inbox[1] as Pid, req, url, deps);
    return refuse(405, "method_not_allowed");
  }
  return refuse(404, "not_found");
}

async function putEnvelope(from: Pid, seq: number, req: Request, { store, roots, now }: RelayDeps): Promise<Response> {
  // netlify dev delivers an empty body when content-type is missing; naming
  // the header here beats a "malformed" that sends people hunting the envelope.
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim();
  if (contentType !== "application/json") return refuse(415, "content_type_must_be_application_json");
  const wire = new Uint8Array(await req.arrayBuffer());
  const outer = verifyOuter(wire, roots, now());
  if (!outer.ok) return refuse(OUTER_STATUS[outer.error], outer.error);
  const { header } = outer;
  if (header.from !== from || header.seq !== seq) return refuse(400, "path_mismatch");
  if (!roots.has(header.to)) return refuse(400, "unknown_recipient");

  const key = logKey(from, seq);
  const stored = await store.get(key);
  if (stored !== null) return settleExisting(stored, wire, header.to, from, seq, store);

  if (seq === 0) {
    if (header.prev !== null) return refuse(409, "chain_mismatch");
  } else {
    const previous = await store.get(logKey(from, seq - 1));
    if (previous === null) return refuse(409, "gap");
    if (hashOf(previous) !== header.prev) return refuse(409, "chain_mismatch");
  }

  if (!(await store.createOnly(key, wire))) {
    // Lost a race with a concurrent PUT of the same seq.
    const winner = await store.get(key);
    return winner === null ? refuse(500, "store_inconsistent") : settleExisting(winner, wire, header.to, from, seq, store);
  }
  await store.createOnly(inboxKey(header.to, from, seq), new Uint8Array());
  return reply(201, { from, seq });
}

/** Same bytes is a retry: make sure it is indexed and say 200. Different bytes is a fork. */
async function settleExisting(stored: Uint8Array, wire: Uint8Array, to: Pid, from: Pid, seq: number, store: Store): Promise<Response> {
  if (!sodium.memcmp(stored, wire)) return refuse(409, "fork");
  await store.createOnly(inboxKey(to, from, seq), new Uint8Array());
  return reply(200, { from, seq });
}

/** Verifies a signed read and spends its nonce. Returns the caller's pid, or a refusal. */
async function authorize(req: Request, url: URL, { store, roots, now }: RelayDeps): Promise<Pid | Response> {
  const target = { method: req.method, host: url.host, path: url.pathname + url.search };
  const auth = verifyRequest(req.headers.get("authorization"), target, roots, now());
  if (!auth.ok) return refuse(401, "unauthorized");
  // Hash the nonce so a caller-chosen string never becomes a raw storage key.
  // The minute bucket lets a future sweep drop whole buckets. A ts signed at
  // M:59 stays valid until M+5:59, so the sweep must keep the last skew window
  // plus one minute. Until that sweep exists, one tiny blob per read accumulates.
  const minute = auth.at.toISOString().slice(0, 16);
  const nonceKey = `nonce/${auth.pid}/${minute}/${sodium.to_hex(sodium.crypto_generichash(16, auth.nonce))}`;
  if (!(await store.createOnly(nonceKey, new Uint8Array()))) return refuse(401, "replayed");
  return auth.pid;
}

async function getEnvelope(from: Pid, seq: number, req: Request, url: URL, deps: RelayDeps): Promise<Response> {
  const caller = await authorize(req, url, deps);
  if (caller instanceof Response) return caller;
  // One answer for "absent", "not yours" and "sender since removed from the
  // allowlist", so no root can probe another root's log length.
  const notFound = () => refuse(404, "not_found");
  const wire = await deps.store.get(logKey(from, seq));
  if (wire === null) return notFound();
  const outer = verifyOuter(wire, deps.roots);
  if (!outer.ok) return outer.error === "unknown_sender" ? notFound() : refuse(500, "stored_envelope_invalid");
  if (caller !== outer.header.from && caller !== outer.header.to) return notFound();
  return new Response(wire, { status: 200, headers: { "content-type": "application/json" } });
}

async function listInbox(to: Pid, req: Request, url: URL, deps: RelayDeps): Promise<Response> {
  const caller = await authorize(req, url, deps);
  if (caller instanceof Response) return caller;
  if (caller !== to) return refuse(403, "forbidden");

  const after = parseAfter(url.searchParams.get("after"));
  const perSender = await Promise.all([...deps.roots.keys()].map((from) => newFromSender(to, from, after.get(from) ?? -1, deps.store)));
  const entries = perSender.flat().sort((a, b) => (a.from === b.from ? a.seq - b.seq : a.from < b.from ? -1 : 1));
  return reply(200, { entries });
}

/** Entries from one sender above the caller's head, reading only buckets that can hold them. */
async function newFromSender(to: Pid, from: Pid, head: number, store: Store): Promise<readonly { from: Pid; seq: number }[]> {
  const prefix = senderPrefix(to, from);
  const firstBucket = bucketOf(head + 1);
  const buckets = (await store.listDirectories(prefix)).filter((bucket) => bucket >= firstBucket);
  const keys = (await Promise.all(buckets.map((bucket) => store.list(`${prefix}${bucket}/`)))).flat();
  return keys.map((key) => ({ from, seq: Number(key.slice(key.lastIndexOf("/") + 1)) })).filter(({ seq }) => seq > head);
}

/** "pid:seq,pid:seq" -> the caller's known head per sender. Malformed parts are ignored. */
function parseAfter(raw: string | null): ReadonlyMap<string, number> {
  const pairs = (raw ?? "")
    .split(",")
    .map((part) => part.split(":"))
    .filter((pair): pair is [string, string] => pair.length === 2 && AFTER_SEQ.test(pair[1] ?? ""))
    .map(([pid, seq]) => [pid, Number(seq)] as const);
  return new Map(pairs);
}
