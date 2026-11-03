import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientDeps } from "./client.ts";
import { fileKeyStore, keychainKeyStore, type KeyStore } from "./keystore.ts";

export const KEYCHAIN_SERVICE = "agent-mailbox";
/** The daemon's key lives apart from the root key, so the two never share an item. */
export const AGENT_KEYCHAIN_SERVICE = "agent-mailbox-agent";

/**
 * Client wiring from the environment, shared by the CLI, MCP server and hook:
 *   MAILBOX_HOME      state directory (default ~/.agent-mailbox)
 *   MAILBOX_KEYSTORE  "file" keeps keys in $MAILBOX_HOME/keys.json and
 *                     agent-keys.json (0600); anything else uses the macOS Keychain
 */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): ClientDeps {
  const dir = homeFromEnv(env);
  const keys = env["MAILBOX_KEYSTORE"] === "file" ? fileKeyStore(join(dir, "keys.json")) : keychainKeyStore(KEYCHAIN_SERVICE);
  return { dir, keys, fetch: globalThis.fetch, now: () => new Date() };
}

export function agentKeysFromEnv(env: NodeJS.ProcessEnv = process.env): KeyStore {
  return env["MAILBOX_KEYSTORE"] === "file" ? fileKeyStore(join(homeFromEnv(env), "agent-keys.json")) : keychainKeyStore(AGENT_KEYCHAIN_SERVICE);
}

const homeFromEnv = (env: NodeJS.ProcessEnv) => env["MAILBOX_HOME"] ?? join(homedir(), ".agent-mailbox");

/**
 * A checkout with dev dependencies installed belongs to someone working on
 * agent-mailbox: update leaves it to git, and the hook doesn't nag it.
 */
export const isDevCheckout = (root: string): Promise<boolean> => access(join(root, "node_modules", "typescript")).then(() => true, () => false);
