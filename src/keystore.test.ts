import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity } from "./identity.ts";
import { fileKeyStore, keychainKeyStore, type SecurityRunner } from "./keystore.ts";

const alice = generateIdentity();

test("the file key store round-trips an identity and keeps the file private", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "mailbox-keys-")), "keys.json");
  const store = fileKeyStore(path);
  assert.equal(await store.load(alice.pid), null);
  await store.save(alice);
  assert.deepEqual(await store.load(alice.pid), alice);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("the keychain store never puts a secret in argv, where ps can read it", async () => {
  const calls: { args: readonly string[]; stdin: string }[] = [];
  let stored = "";
  const run: SecurityRunner = async (args, stdin = "") => {
    calls.push({ args, stdin });
    if (stdin.includes("add-generic-password")) stored = /-w '([^']+)'/.exec(stdin)?.[1] ?? "";
    return args.includes("find-generic-password") ? stored : "";
  };
  const store = keychainKeyStore("agent-mailbox-test", run);
  await store.save(alice);
  // `stored` is exactly what the keychain received, so it must appear only on stdin.
  assert.ok(stored.length > 0, "nothing reached the keychain via stdin");
  assert.ok(calls.every((c) => !c.args.some((arg) => arg.includes(stored))), "secret leaked into argv");
  assert.deepEqual(await store.load(alice.pid), alice);
});

test(
  "the real macOS keychain round-trips an identity",
  { skip: process.platform !== "darwin" || process.env["MAILBOX_SKIP_KEYCHAIN"] === "1" },
  async () => {
    const store = keychainKeyStore("agent-mailbox-test");
    try {
      await store.save(alice);
      assert.deepEqual(await store.load(alice.pid), alice);
    } finally {
      await store.remove(alice.pid);
    }
    assert.equal(await store.load(alice.pid), null);
  },
);
