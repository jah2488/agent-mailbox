import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientDeps } from "./client.ts";
import { fileKeyStore, keychainKeyStore } from "./keystore.ts";

export const KEYCHAIN_SERVICE = "agent-mailbox";

/**
 * Client wiring from the environment, shared by the CLI, MCP server and hook:
 *   MAILBOX_HOME      state directory (default ~/.agent-mailbox)
 *   MAILBOX_KEYSTORE  "file" keeps keys in $MAILBOX_HOME/keys.json (0600);
 *                     anything else uses the macOS Keychain
 */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): ClientDeps {
  const dir = env["MAILBOX_HOME"] ?? join(homedir(), ".agent-mailbox");
  const keys = env["MAILBOX_KEYSTORE"] === "file" ? fileKeyStore(join(dir, "keys.json")) : keychainKeyStore(KEYCHAIN_SERVICE);
  return { dir, keys, fetch: globalThis.fetch, now: () => new Date() };
}
