import { blobsStore } from "../../src/blobs-store.ts";
import { handle } from "../../src/relay.ts";
import { parseRoots } from "../../src/roots.ts";

// Parsed once per cold start. A bad list fails every request loudly instead
// of running with a partial allowlist.
const roots = parseRoots(process.env["MAILBOX_ROOTS"] ?? "");

export default async (req: Request): Promise<Response> => {
  if (!roots.ok) {
    console.error(`MAILBOX_ROOTS rejected: ${roots.error}`);
    return new Response(JSON.stringify({ error: "relay_misconfigured" }), { status: 500 });
  }
  return handle(req, { store: blobsStore(), roots: roots.roots, now: () => new Date() });
};

export const config = { path: ["/log/*", "/inbox/*"] };
