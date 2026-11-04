import { blobsStore } from "../../src/blobs-store.ts";
import { handle } from "../../src/relay.ts";
import { relayKeyFromSeed, type RelayKey } from "../../src/relay-identity.ts";
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

export default async (req: Request): Promise<Response> => {
  if (!roots.ok) {
    console.error(`MAILBOX_ROOTS rejected: ${roots.error}`);
    return new Response(JSON.stringify({ error: "relay_misconfigured" }), { status: 500 });
  }
  return handle(req, { store: blobsStore(), roots: roots.roots, now: () => new Date(), ...(identity === undefined ? {} : { identity }) });
};

export const config = { path: ["/log/*", "/inbox/*", "/.well-known/agent-mailbox"] };
