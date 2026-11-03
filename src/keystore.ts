import { execFile } from "node:child_process";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { pidOf, type Identity, type Pid } from "./identity.ts";
import sodium from "./sodium.ts";

/** Where a person's secret keys live. Everything else in ~/.agent-mailbox is public or replaceable. */
export type KeyStore = {
  readonly load: (pid: Pid) => Promise<Identity | null>;
  readonly save: (identity: Identity) => Promise<void>;
  readonly remove: (pid: Pid) => Promise<void>;
};

/** Runs /usr/bin/security. Injected so tests can see exactly what reaches argv. */
export type SecurityRunner = (args: readonly string[], stdin?: string) => Promise<string>;

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);

// One base64 blob per identity. Base64 has no quote characters, so the blob
// can sit inside single quotes in a `security -i` command line.
function encodeIdentity(id: Identity): string {
  const json = JSON.stringify({ sign_pub: b64(id.signPub), sign_sec: b64(id.signSec), box_pub: b64(id.boxPub), box_sec: b64(id.boxSec) });
  return b64(new TextEncoder().encode(json));
}

function decodeIdentity(blob: string, expected: Pid): Identity | null {
  try {
    const k = JSON.parse(new TextDecoder().decode(unb64(blob.trim()))) as Record<string, string>;
    const signPub = unb64(k["sign_pub"] ?? "");
    const identity = { pid: pidOf(signPub), signPub, signSec: unb64(k["sign_sec"] ?? ""), boxPub: unb64(k["box_pub"] ?? ""), boxSec: unb64(k["box_sec"] ?? "") };
    // A blob filed under the wrong pid is treated as missing, never trusted.
    return identity.pid === expected ? identity : null;
  } catch {
    return null;
  }
}

const runSecurity: SecurityRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile("/usr/bin/security", [...args], (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.end(stdin ?? "");
  });

/**
 * macOS Keychain, through /usr/bin/security. Writes go through `security -i`
 * on stdin, so the secret never appears in a process's argv. Items written
 * by /usr/bin/security are readable by it without a prompt, which the MCP
 * server and hook rely on.
 */
export function keychainKeyStore(service: string, run: SecurityRunner = runSecurity): KeyStore {
  return {
    load: async (pid) => {
      try {
        return decodeIdentity(await run(["find-generic-password", "-s", service, "-a", pid, "-w"]), pid);
      } catch {
        return null;
      }
    },
    save: async (identity) => {
      await run(["-i"], `add-generic-password -U -s '${service}' -a '${identity.pid}' -w '${encodeIdentity(identity)}'\n`);
    },
    remove: async (pid) => {
      try {
        await run(["delete-generic-password", "-s", service, "-a", pid]);
      } catch {
        // Already absent.
      }
    },
  };
}

/** A 0600 JSON file of identity blobs keyed by pid. For tests and for a second identity on one machine. */
export function fileKeyStore(path: string): KeyStore {
  const readAll = async (): Promise<Record<string, string>> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const writeAll = async (all: Record<string, string>) => {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  };
  return {
    load: async (pid) => {
      const blob = (await readAll())[pid];
      return blob === undefined ? null : decodeIdentity(blob, pid);
    },
    save: async (identity) => writeAll({ ...(await readAll()), [identity.pid]: encodeIdentity(identity) }),
    remove: async (pid) => {
      const { [pid]: _gone, ...rest } = await readAll();
      await writeAll(rest);
    },
  };
}
