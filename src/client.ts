import type { Json } from "./canonical.ts";
import { certHash, verifyCert, type SignedCert } from "./cert.ts";
import { open, seal, type Body } from "./envelope.ts";
import { readHome, withLock, writeState, type Home } from "./home.ts";
import { pidOf, type BoxKeys, type Pid } from "./identity.ts";
import type { KeyStore } from "./keystore.ts";
import {
  admit,
  chainsOf,
  ignoreThrough,
  knownHeads,
  markDelivered,
  nextLink,
  pendingDelivery,
  recordSealed,
  take,
  thread,
  unreadCount,
  type Inbound,
  type MailboxState,
  type Outbound,
  type Pattern,
} from "./mailbox.ts";
import { ledger, type Commitment } from "./promises.ts";
import { signEvent } from "./membership.ts";
import { checkRelay } from "./relay-check.ts";
import { rootEntry } from "./roots.ts";
import { signRequest, type RequestSigner } from "./request-auth.ts";
import type { Contact } from "./roster.ts";
import sodium from "./sodium.ts";

// The imperative shell around the mailbox core: home dir, key store, and
// the relays. Every state write happens under the home lock.

export type ClientDeps = {
  readonly dir: string;
  readonly keys: KeyStore;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  /** Per relay request. Keeps every lock hold well under the lock's stale age. Default 10 s. */
  readonly timeoutMs?: number;
  /**
   * Daemon mode. When set, `keys` holds the certified agent's signing key
   * (filed under the agent's pid, with the person's box keys) and the root
   * signing key is never loaded: reads, sends and decryption all go through
   * the agent key.
   */
  readonly agentCert?: SignedCert;
};

/** How this process acts for the person: decrypts with their box keys, signs as their root or as a certified agent. */
type Acting = { readonly box: BoxKeys; readonly signer: RequestSigner };

const DEFAULT_TIMEOUT_MS = 10_000;
const PID_PATTERN = /^[a-z2-7]{16}$/;
const ERROR_CODE = /^[a-z_]{1,64}$/;
export type Outgoing = { readonly to: string; readonly tag: string; readonly text?: string; readonly payload?: Json; readonly reply_to?: string; readonly hops?: number };
/** toName is the contact the `to` argument resolved to, so callers report a name rather than echo raw input. */
export type SendResult = { readonly ref: string; readonly seq: number; readonly toName: string; readonly delivered: boolean; readonly error?: string };
export type SyncResult = { readonly received: number; readonly errors: readonly string[] };
export type InboxCheck = { readonly waiting: number; readonly unread: number; readonly from: readonly string[] };

type InboxEntry = { readonly from: string; readonly seq: number };

function resolveContact(contacts: ReadonlyMap<Pid, Contact>, to: string): Contact {
  const wanted = to.trim().toLowerCase();
  const found = contacts.get(to.trim() as Pid) ?? [...contacts.values()].find((c) => c.name.toLowerCase() === wanted);
  if (found === undefined) throw new Error(`no contact named or with pid "${to}"`);
  return found;
}

async function actingFor(deps: ClientDeps, home: Home): Promise<Acting> {
  if (deps.agentCert === undefined) {
    const identity = await deps.keys.load(home.me.pid);
    if (identity === null) throw new Error(`no secret key for ${home.me.name} (${home.me.pid}) in the key store`);
    return { box: identity, signer: identity };
  }
  // Checked here so an expired or foreign cert fails with a clear reason rather than a bare relay 401.
  const cert = verifyCert(deps.agentCert, home.me, deps.now());
  if (!cert.ok) throw new Error(`agent cert refused: ${cert.error}`);
  const agent = await deps.keys.load(pidOf(cert.agentSignPub));
  if (agent === null) throw new Error(`no key for agent "${cert.name}" in the key store`);
  if (!sodium.memcmp(agent.boxPub, home.me.boxPub)) throw new Error(`agent "${cert.name}" holds box keys for someone other than ${home.me.name}`);
  return {
    box: { pid: home.me.pid, boxPub: agent.boxPub, boxSec: agent.boxSec },
    signer: { pid: home.me.pid, signSec: agent.signSec, cert: deps.agentCert },
  };
}

const newRef = (now: Date) => `${now.getTime().toString(36)}-${sodium.to_hex(sodium.randombytes_buf(4))}`;

/**
 * Relay responses end up in tool results the model reads, so only the status
 * and a bare error code survive. Free text from a relay could carry instructions.
 */
async function describeFailure(res: Response): Promise<string> {
  const code = await res
    .json()
    .then((body: unknown) => (body as { error?: unknown })?.error)
    .catch(() => undefined);
  return `relay answered ${res.status}${typeof code === "string" && ERROR_CODE.test(code) ? ` ${code}` : ""}`;
}

/** Every relay call goes through here, so none can hold the home lock indefinitely. */
function relayFetch(deps: ClientDeps, url: string, init: RequestInit = {}): Promise<Response> {
  return deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
}

/** Puts every undelivered message on my home relay, oldest first, stopping at the first failure. */
async function flush(deps: ClientDeps, home: Home, state: MailboxState): Promise<{ readonly state: MailboxState; readonly error?: string }> {
  if (pendingDelivery(state).length === 0) return { state };
  const relay = await checkRelay(deps, home.me.relay);
  if (!relay.ok) return { state, error: `${home.me.relay}: ${relay.error}` };
  let current = state;
  for (const message of pendingDelivery(state)) {
    if (message.wire === null) continue; // Unreachable: pending messages always keep their bytes.
    try {
      const res = await relayFetch(deps, `${home.me.relay}/log/${message.from}/${message.seq}`, {
        method: "PUT",
        body: new TextEncoder().encode(message.wire),
        headers: { "content-type": "application/json" },
      });
      if (res.status !== 200 && res.status !== 201) return { state: current, error: await describeFailure(res) };
      current = markDelivered(current, message.seq);
    } catch (error) {
      return { state: current, error: (error as Error).message };
    }
  }
  return { state: current };
}

export async function send(deps: ClientDeps, message: Outgoing): Promise<SendResult> {
  return withLock(deps.dir, async () => {
    const home = await readHome(deps.dir);
    const recipient = resolveContact(home.contacts, message.to);
    const acting = await actingFor(deps, home);
    const now = deps.now();
    const body: Body = {
      tag: message.tag,
      ref: newRef(now),
      payload: message.payload ?? null,
      ...(message.reply_to === undefined ? {} : { reply_to: message.reply_to }),
      ...(message.text === undefined ? {} : { prose: message.text }),
    };
    const { seq, prev } = nextLink(home.state);
    const sealed = seal({ from: acting.signer, to: recipient, seq, prev, ts: now.toISOString(), body, ...(message.hops === undefined ? {} : { hops: message.hops }), ...(acting.signer.cert === undefined ? {} : { agent: { signSec: acting.signer.signSec, cert: acting.signer.cert } }) });
    if (!sealed.ok) throw new Error(`could not seal message: ${sealed.error}`);

    // Persist before any network call: a crash after this point retries the
    // same bytes, so the seq is never reused and the chain never forks.
    const recorded = recordSealed(home.state, { to: recipient.pid, ts: now.toISOString(), body, wire: sealed.wire });
    await writeState(deps.dir, recorded);
    const flushed = await flush(deps, home, recorded);
    const delivered = !pendingDelivery(flushed.state).some((m) => m.seq === seq);
    let error = flushed.error;
    try {
      await writeState(deps.dir, flushed.state);
    } catch (writeError) {
      // The relay already has it. Saying so stops a retry that would send a
      // duplicate under a new seq; the next flush re-PUTs the same bytes (200).
      error = `delivered, but saving local state failed: ${(writeError as Error).message}`;
    }
    return { ref: body.ref, seq, toName: recipient.name, delivered, ...(error === undefined ? {} : { error }) };
  });
}

function signedGet(deps: ClientDeps, relay: string, path: string, signer: RequestSigner): Promise<Response> {
  const authorization = signRequest({ method: "GET", host: new URL(relay).host, path, ts: deps.now().toISOString() }, signer);
  return relayFetch(deps, `${relay}${path}`, { headers: { authorization } });
}

/** A relay's inbox listing, or null if it isn't one. Pids and seqs go into signed paths, so they're checked here. */
function readEntries(body: unknown): readonly InboxEntry[] | null {
  const entries = (body as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return null;
  const valid = entries.every(
    (e: unknown) => typeof (e as InboxEntry)?.from === "string" && PID_PATTERN.test((e as InboxEntry).from) && Number.isSafeInteger((e as InboxEntry).seq) && (e as InboxEntry).seq >= 0,
  );
  return valid ? (entries as InboxEntry[]) : null;
}

/** New entries on every distinct relay in my roster, above what I already hold from each sender. */
/** checked: verify each relay's identity first (sync does; the read-only hook count skips it to stay fast and lock-free). */
async function listWaiting(
  deps: ClientDeps,
  home: Home,
  signer: RequestSigner,
  state: MailboxState,
  checked: boolean,
): Promise<{ readonly relay: string; readonly entries: readonly InboxEntry[]; readonly error?: string }[]> {
  // Pids and seqs need no escaping, and the query must reach the relay exactly
  // as signed, so it is built by hand rather than through URLSearchParams.
  const after = Object.entries(knownHeads(state))
    .map(([pid, seq]) => `${pid}:${seq}`)
    .join(",");
  const path = `/inbox/${home.me.pid}${after ? `?after=${after}` : ""}`;
  const relays = [...new Set([...home.contacts.values()].map((c) => c.relay))];
  // Checked one at a time: each check may rewrite relays.json, and parallel rewrites would lose pins.
  const refused = new Map<string, string>();
  if (checked) {
    for (const relay of relays) {
      const identity = await checkRelay(deps, relay);
      if (!identity.ok) refused.set(relay, identity.error);
    }
  }
  return Promise.all(
    relays.map(async (relay) => {
      try {
        const refusal = refused.get(relay);
        if (refusal !== undefined) return { relay, entries: [], error: `${relay}: ${refusal}` };
        const res = await signedGet(deps, relay, path, signer);
        if (res.status !== 200) return { relay, entries: [], error: `${relay}: ${await describeFailure(res)}` };
        const entries = readEntries(await res.json().catch(() => null));
        return entries === null ? { relay, entries: [], error: `${relay}: malformed inbox listing` } : { relay, entries };
      } catch (error) {
        return { relay, entries: [], error: `${relay}: ${(error as Error).message}` };
      }
    }),
  );
}

export async function sync(deps: ClientDeps): Promise<SyncResult> {
  return withLock(deps.dir, async () => {
    const home = await readHome(deps.dir);
    const { state, received, errors } = await syncUnlocked(deps, home, await actingFor(deps, home));
    if (state !== home.state) await writeState(deps.dir, state);
    return { received, errors };
  });
}

/** Caller must hold the home lock and write the returned state. */
async function syncUnlocked(deps: ClientDeps, home: Home, acting: Acting): Promise<SyncResult & { readonly state: MailboxState }> {
  const errors: string[] = [];
  const flushed = await flush(deps, home, home.state);
  if (flushed.error !== undefined) errors.push(`outbox: ${flushed.error}`);
  let state = flushed.state;
  let received = 0;
  const stopped = new Set<string>();

  for (const { relay, entries, error } of await listWaiting(deps, home, acting.signer, state, true)) {
    if (error !== undefined) errors.push(error);
    for (const { from, seq } of entries) {
      const sender = home.contacts.get(from as Pid);
      if (sender === undefined) {
        // Record what was refused so the relay stops listing it; report each sender once per sync.
        state = ignoreThrough(state, from as Pid, seq);
        if (!stopped.has(from)) errors.push(`${from} sent you mail but is not in your roster; ignored`);
        stopped.add(from);
        continue;
      }
      if (stopped.has(from)) continue;
      try {
        const res = await signedGet(deps, relay, `/log/${from}/${seq}`, acting.signer);
        if (res.status !== 200) throw new Error(await describeFailure(res));
        const opened = open(new Uint8Array(await res.arrayBuffer()), { me: acting.box, roster: home.contacts, chains: chainsOf(state) });
        if (opened.ok) {
          const admitted = admit(state, opened, deps.now().toISOString());
          state = admitted.state;
          if (admitted.refused) errors.push(`${sender.name}: refused mail from revoked agent "${opened.via.kind === "agent" ? opened.via.name : "?"}" at seq ${seq}`);
          else received++;
        } else if (opened.error !== "duplicate") {
          // A gap or fork from one sender stops that sender only.
          stopped.add(from);
          errors.push(`${sender.name}: ${opened.error} at seq ${seq}`);
        }
      } catch (error) {
        stopped.add(from);
        errors.push(`${sender.name}: ${(error as Error).message}`);
      }
    }
  }
  return { state, received, errors };
}

export type Filter = { readonly from?: string; readonly tag?: string; readonly reply_to?: string };
export type Received = Inbound & { readonly fromName: string };

/**
 * Erlang-style selective receive: sync, then hand out matching unread mail
 * oldest first, marking it consumed. One lock covers both, so two callers
 * can never be handed the same message.
 */
export async function receive(deps: ClientDeps, filter: Filter): Promise<{ readonly messages: readonly Received[]; readonly errors: readonly string[] }> {
  return withLock(deps.dir, async () => {
    const home = await readHome(deps.dir);
    const from = filter.from === undefined ? undefined : resolveContact(home.contacts, filter.from).pid;
    const synced = await syncUnlocked(deps, home, await actingFor(deps, home));
    const pattern: Pattern = {
      ...(from === undefined ? {} : { from }),
      ...(filter.tag === undefined ? {} : { tag: filter.tag }),
      ...(filter.reply_to === undefined ? {} : { reply_to: filter.reply_to }),
    };
    const taken = take(synced.state, pattern);
    if (taken.state !== home.state) await writeState(deps.dir, taken.state);
    const named = taken.messages.map((m) => ({ ...m, fromName: home.contacts.get(m.from)?.name ?? m.from }));
    return { messages: named, errors: synced.errors };
  });
}

export async function contacts(deps: ClientDeps): Promise<{ readonly me: Contact; readonly contacts: readonly Contact[] }> {
  const home = await readHome(deps.dir);
  return { me: home.me, contacts: [...home.contacts.values()] };
}

/** Read-only view of one conversation, with names attached. Never consumes. */
export async function readThread(deps: ClientDeps, ref: string): Promise<readonly ((Inbound | Outbound) & { readonly fromName: string })[]> {
  const home = await readHome(deps.dir);
  return thread(home.state, ref).map((m) => ({ ...m, fromName: m.from === home.me.pid ? "you" : (home.contacts.get(m.from)?.name ?? m.from) }));
}

/**
 * Read-only: what's waiting on the relays plus what's unread locally. Takes
 * no lock and writes nothing, so the per-prompt hook can never race the MCP
 * server.
 */
export async function checkInbox(deps: ClientDeps): Promise<InboxCheck> {
  const home = await readHome(deps.dir);
  const acting = await actingFor(deps, home);
  const known = (await listWaiting(deps, home, acting.signer, home.state, false)).flatMap((r) => r.entries).filter((e) => home.contacts.has(e.from as Pid));
  const names = [...new Set(known.map((e) => home.contacts.get(e.from as Pid)?.name ?? e.from))];
  return { waiting: known.length, unread: unreadCount(home.state), from: names };
}

/**
 * Tells every contact that this agent cert is revoked, as the person's root
 * (so deps must not be in daemon mode). Each contact refuses anything the
 * cert signs after the first revoke's seq; mail it signed before still stands.
 */
export async function revokeAgent(deps: ClientDeps, cert: SignedCert): Promise<readonly SendResult[]> {
  const home = await readHome(deps.dir);
  const effective = nextLink(home.state).seq;
  const others = [...home.contacts.values()].filter((c) => c.pid !== home.me.pid);
  const results: SendResult[] = [];
  for (const contact of others) {
    results.push(
      await send(deps, { to: contact.pid, tag: "revoke", text: `${home.me.name} revoked their agent "${cert.c.name}".`, payload: { cert_hash: certHash(cert), effective_seq: effective } }),
    );
  }
  return results;
}

export type NamedCommitment = Commitment & { readonly name: string };

/** The promise ledger, with each counterparty's name, after fetching any new mail. Sends nothing. */
export async function promises(deps: ClientDeps): Promise<{ readonly made: readonly NamedCommitment[]; readonly owed: readonly NamedCommitment[] }> {
  await sync(deps).catch(() => undefined); // offline still shows what's known
  const home = await readHome(deps.dir);
  const named = (c: Commitment) => ({ ...c, name: home.contacts.get(c.counterparty)?.name ?? c.counterparty });
  const { made, owed } = ledger(home.state, home.me.pid, deps.now());
  return { made: made.map(named), owed: owed.map(named) };
}

export type MembershipResult = { readonly ok: true; readonly admitted: boolean } | { readonly ok: false; readonly error: string };

/**
 * Asks my relay to record a vouch for, withdrawal of, or (admins only)
 * removal of someone, signed with my root key. error is the relay's bare
 * error code, or a short reason when the relay couldn't be used.
 */
export async function membership(deps: ClientDeps, kind: "vouch" | "withdraw" | "remove", member: Contact): Promise<MembershipResult> {
  const home = await readHome(deps.dir);
  const root = await deps.keys.load(home.me.pid);
  if (root === null) return { ok: false, error: "no_root_key" };
  const relay = await checkRelay(deps, home.me.relay);
  if (!relay.ok) return { ok: false, error: relay.error };
  const event = { v: 1 as const, kind, relay: new URL(home.me.relay).host, member: rootEntry(member), by: home.me.pid, ts: deps.now().toISOString() };
  try {
    const res = await relayFetch(deps, `${home.me.relay}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signEvent(event, root.signSec)),
    });
    const body = (await res.json().catch(() => null)) as { admitted?: unknown; error?: unknown } | null;
    if (res.status === 200 || res.status === 201) return { ok: true, admitted: body?.admitted === true };
    return { ok: false, error: typeof body?.error === "string" && ERROR_CODE.test(body.error) ? body.error : `status_${res.status}` };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}
