import { hashOf, verifyOuter, type OuterError } from "./envelope.ts";
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
  readonly list: (prefix: string) => Promise<readonly string[]>;
};

export type RelayDeps = {
  readonly store: Store;
  readonly roots: ReadonlyMap<Pid, Peer>;
  readonly now: () => Date;
};

const PID = "[a-z2-7]{16}";
const LOG_ROUTE = new RegExp(`^/log/(${PID})/(0|[1-9][0-9]{0,15})$`);
const INBOX_ROUTE = new RegExp(`^/inbox/(${PID})$`);

const logKey = (from: string, seq: number) => `log/${from}/${String(seq).padStart(16, "0")}`;
const inboxKey = (to: string, from: string, seq: number) => `inbox/${to}/${from}/${String(seq).padStart(16, "0")}`;

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status: number, error: string) => reply(status, { error });

const OUTER_STATUS: Readonly<Record<OuterError, number>> = {
  too_large: 413,
  malformed: 400,
  non_canonical: 400,
  unsupported: 400,
  unknown_sender: 403,
  bad_signature: 401,
};

export async function handle(req: Request, deps: RelayDeps): Promise<Response> {
  const url = new URL(req.url);
  const log = LOG_ROUTE.exec(url.pathname);
  if (log !== null) {
    const [, from, seq] = log as unknown as [string, Pid, string];
    if (req.method === "PUT") return putEnvelope(from, Number(seq), req, deps);
    if (req.method === "GET") return getEnvelope(from, Number(seq), req, url, deps);
    return refuse(405, "method_not_allowed");
  }
  const inbox = INBOX_ROUTE.exec(url.pathname);
  if (inbox !== null) {
    if (req.method === "GET") return listInbox(inbox[1] as Pid, req, url, deps);
    return refuse(405, "method_not_allowed");
  }
  return refuse(404, "not_found");
}

async function putEnvelope(from: Pid, seq: number, req: Request, { store, roots }: RelayDeps): Promise<Response> {
  // netlify dev delivers an empty body when content-type is missing; naming
  // the header here beats a "malformed" that sends people hunting the envelope.
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim();
  if (contentType !== "application/json") return refuse(415, "content_type_must_be_application_json");
  const wire = new Uint8Array(await req.arrayBuffer());
  const outer = verifyOuter(wire, roots);
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
  const auth = verifyRequest(req.headers.get("authorization"), { method: req.method, path: url.pathname + url.search }, roots, now());
  if (!auth.ok) return refuse(401, "unauthorized");
  // Hash the nonce so a caller-chosen string never becomes a raw storage key.
  const nonceKey = `nonce/${auth.pid}/${sodium.to_hex(sodium.crypto_generichash(16, auth.nonce))}`;
  if (!(await store.createOnly(nonceKey, new Uint8Array()))) return refuse(401, "replayed");
  return auth.pid;
}

async function getEnvelope(from: Pid, seq: number, req: Request, url: URL, deps: RelayDeps): Promise<Response> {
  const caller = await authorize(req, url, deps);
  if (caller instanceof Response) return caller;
  const wire = await deps.store.get(logKey(from, seq));
  if (wire === null) return refuse(404, "not_found");
  const outer = verifyOuter(wire, deps.roots);
  if (!outer.ok) return refuse(500, "stored_envelope_invalid");
  if (caller !== outer.header.from && caller !== outer.header.to) return refuse(403, "forbidden");
  return new Response(wire, { status: 200, headers: { "content-type": "application/json" } });
}

async function listInbox(to: Pid, req: Request, url: URL, deps: RelayDeps): Promise<Response> {
  const caller = await authorize(req, url, deps);
  if (caller instanceof Response) return caller;
  if (caller !== to) return refuse(403, "forbidden");

  const after = parseAfter(url.searchParams.get("after"));
  const prefix = `inbox/${to}/`;
  const entries = (await deps.store.list(prefix))
    .map((key) => {
      const [from = "", seq = ""] = key.slice(prefix.length).split("/");
      return { from, seq: Number(seq) };
    })
    .filter(({ from, seq }) => seq > (after.get(from) ?? -1));
  return reply(200, { entries });
}

/** "pid:seq,pid:seq" -> the caller's known head per sender. Malformed parts are ignored. */
function parseAfter(raw: string | null): ReadonlyMap<string, number> {
  const pairs = (raw ?? "")
    .split(",")
    .map((part) => part.split(":"))
    .filter((pair): pair is [string, string] => pair.length === 2 && /^\d+$/.test(pair[1] ?? ""))
    .map(([pid, seq]) => [pid, Number(seq)] as const);
  return new Map(pairs);
}
