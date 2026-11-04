import { blobsStore } from "../../src/blobs-store.ts";
import { handle } from "../../src/relay.ts";
import { relayKeyFromSeed, type RelayKey } from "../../src/relay-identity.ts";
import { parseJoinRule } from "../../src/membership.ts";
import { parseRoots } from "../../src/roots.ts";

// Parsed once per cold start. A bad list fails every request loudly instead
// of running with a partial allowlist.
const raw = process.env["MAILBOX_ROOTS"];
const roots = raw === undefined ? ({ ok: false, error: "MAILBOX_ROOTS is not set" } as const) : parseRoots(raw);
// Without a key the relay still runs, but clients refuse it: it answers the identity check with 503.
const identity: RelayKey | undefined = (() => {
  const seed = process.env["MAILBOX_RELAY_KEY"];
  if (seed === undefined) return undefined;
  try {
    return relayKeyFromSeed(seed);
  } catch (error) {
    console.error((error as Error).message);
    return undefined;
  }
})();

// MAILBOX_JOIN: any-member (the default), admins, vouches:N, or closed. A typo fails loudly like a bad allowlist.
const join = parseJoinRule(process.env["MAILBOX_JOIN"]);

export default async (req: Request): Promise<Response> => {
  if (!roots.ok || join === null) {
    console.error(roots.ok ? "MAILBOX_JOIN must be any-member, admins, vouches:N or closed" : `MAILBOX_ROOTS rejected: ${roots.error}`);
    return new Response(JSON.stringify({ error: "relay_misconfigured" }), { status: 500 });
  }
  return handle(req, { store: blobsStore(), roots: roots.roots, admins: roots.admins, join, now: () => new Date(), ...(identity === undefined ? {} : { identity }) });
};

export const config = { path: ["/log/*", "/inbox/*", "/members", "/.well-known/agent-mailbox"] };
