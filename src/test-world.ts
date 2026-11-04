// Test support, not shipped behaviour: a small world of people sharing one
// in-memory relay, each with a real home dir and file key store, plus Friend,
// whose home is a second relay.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueCert, type SignedCert } from "./cert.ts";
import type { ClientDeps } from "./client.ts";
import { addContact, initHome } from "./home.ts";
import { agentIdentity, generateIdentity, toPeer, type Identity } from "./identity.ts";
import { fileKeyStore } from "./keystore.ts";
import { memoryStore } from "./memory-store.ts";
import { relayKeyFromSeed, type RelayKey } from "./relay-identity.ts";
import type { JoinRule } from "./membership.ts";
import { handle } from "./relay.ts";
import { contact, type Contact } from "./roster.ts";

export const TEST_RELAY = "https://relay.test";
/** Friend's home relay: its own store and key, Friend its only founder, any member may host. */
export const OTHER_RELAY = "https://other.test";
const OTHER_RELAY_KEY = relayKeyFromSeed("B".repeat(42) + "A");

export type Person = { readonly id: Identity; readonly me: Contact; readonly deps: ClientDeps };

/**
 * Alice and Bob trust each other. Mallory is on the relay's allowlist but in
 * nobody's roster except her own, where Bob is listed.
 */
export type WorldOptions = {
  readonly relayUp?: () => boolean;
  /** Return a Response to answer a request yourself (a hostile or broken relay), or undefined to pass it through. */
  readonly intercept?: (req: Request) => Response | undefined | Promise<Response | undefined>;
  /** The relay's key on each request; undefined is a relay with no key. Default: TEST_RELAY_KEY throughout. */
  readonly relayKey?: () => RelayKey | undefined;
  /** The relay's join rule. Default: none, so only the founders (Alice, Bob, Mallory) may use it. */
  readonly join?: JoinRule;
  /** Founders who are the relay's admins. */
  readonly admins?: readonly ("alice" | "bob" | "mallory")[];
};

/** The test relay's key. A fixed seed, so separate test homes see the same relay. */
export const TEST_RELAY_KEY = relayKeyFromSeed("A".repeat(43));

export async function world(options: WorldOptions = {}) {
  const store = memoryStore();
  const ids = { alice: generateIdentity(), bob: generateIdentity(), mallory: generateIdentity() };
  const roots = new Map(Object.values(ids).map((id) => [id.pid, toPeer(id)]));
  const friendId = generateIdentity();
  const other = { store: memoryStore(), roots: new Map([[friendId.pid, toPeer(friendId)]]), join: { kind: "any-member" } as const, identity: OTHER_RELAY_KEY };
  const relayFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (options.relayUp && !options.relayUp()) throw new TypeError("fetch failed");
    const req = new Request(input, init);
    const identity = options.relayKey === undefined ? TEST_RELAY_KEY : options.relayKey();
    const admins = new Set((options.admins ?? []).map((who) => ids[who].pid));
    const home = { store, roots, admins, now: () => new Date(), ...(identity === undefined ? {} : { identity }), ...(options.join === undefined ? {} : { join: options.join }) };
    const deps = new URL(req.url).origin === OTHER_RELAY ? { ...other, now: () => new Date() } : home;
    const answer = (async () => (await options.intercept?.(req.clone())) ?? handle(req, deps))();
    // Honour the abort signal the way real fetch does, so client timeouts are exercised.
    const signal = init?.signal;
    if (!signal) return answer;
    return Promise.race([answer, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
  }) as typeof fetch;

  const person = async (id: Identity, name: string, relay = TEST_RELAY): Promise<Person> => {
    const dir = await mkdtemp(join(tmpdir(), `mailbox-${name}-`));
    const keys = fileKeyStore(join(dir, "keys.json"));
    await keys.save(id);
    const me = contact(toPeer(id), name, relay);
    await initHome(dir, me);
    return { id, me, deps: { dir, keys, fetch: relayFetch, now: () => new Date() } };
  };
  const alice = await person(ids.alice, "Alice");
  const bob = await person(ids.bob, "Bob");
  const mallory = await person(ids.mallory, "Mallory");
  await addContact(alice.deps.dir, bob.me);
  await addContact(bob.deps.dir, alice.me);
  await addContact(mallory.deps.dir, bob.me);
  // On the same relay but not a founder: they can use it only once a member vouches for them.
  const stranger = await person(generateIdentity(), "Stranger");
  const friend = await person(friendId, "Friend", OTHER_RELAY);
  return { alice, bob, mallory, stranger, friend, store };
}

/** The person's daemon: same home dir, its own key store holding only the certified agent key and their box keys. */
export async function daemonOf(person: Person, name = "daemon"): Promise<ClientDeps & { readonly agentCert: SignedCert }> {
  const agent = agentIdentity(person.id);
  const keys = fileKeyStore(join(person.deps.dir, "agent-keys.json"));
  await keys.save(agent);
  return { ...person.deps, keys, agentCert: issueCert(person.id, { agentSignPub: agent.signPub, name, device: "test", now: new Date() }) };
}
