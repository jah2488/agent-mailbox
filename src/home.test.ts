import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, toPeer } from "./identity.ts";
import { addContact, initHome, readHome, withLock, writeState } from "./home.ts";
import { emptyState } from "./mailbox.ts";
import { contact } from "./roster.ts";

const alice = contact(toPeer(generateIdentity()), "Alice", "https://relay.example");
const bob = contact(toPeer(generateIdentity()), "Bob", "https://relay.example");
const fresh = () => mkdtemp(join(tmpdir(), "mailbox-home-"));

test("a new home knows only its owner and has an empty mailbox", async () => {
  const dir = await fresh();
  await initHome(dir, alice);
  const home = await readHome(dir);
  assert.deepEqual(home.me, alice);
  assert.deepEqual([...home.contacts.keys()], [alice.pid]);
  assert.deepEqual(home.state, emptyState);
});

test("initialising over an existing home is refused, so keys are never orphaned", async () => {
  const dir = await fresh();
  await initHome(dir, alice);
  await assert.rejects(initHome(dir, bob), /already initialised/);
});

test("contacts persist, and a clashing name is refused without changing the roster", async () => {
  const dir = await fresh();
  await initHome(dir, alice);
  await addContact(dir, bob);
  assert.deepEqual([...(await readHome(dir)).contacts.keys()].sort(), [alice.pid, bob.pid].sort());
  const impostor = contact(toPeer(generateIdentity()), "bob", "https://relay.example");
  await assert.rejects(addContact(dir, impostor), /already used/);
  assert.equal((await readHome(dir)).contacts.size, 2);
});

test("re-adding the same key replaces that contact rather than duplicating it", async () => {
  const dir = await fresh();
  await initHome(dir, alice);
  await addContact(dir, bob);
  await addContact(dir, { ...bob, name: "Bobby" });
  const home = await readHome(dir);
  assert.equal(home.contacts.size, 2);
  assert.equal(home.contacts.get(bob.pid)?.name, "Bobby");
});

test("state written is state read", async () => {
  const dir = await fresh();
  await initHome(dir, alice);
  const state = { ...emptyState, chains: { [bob.pid]: { recent: [] } } };
  await writeState(dir, state);
  assert.deepEqual((await readHome(dir)).state, state);
});

test("the lock serialises writers", async () => {
  const dir = await fresh();
  await initHome(dir, alice);
  const order: string[] = [];
  const slow = withLock(dir, async () => {
    order.push("a:start");
    await new Promise((r) => setTimeout(r, 50));
    order.push("a:end");
  });
  const quick = withLock(dir, async () => {
    order.push("b");
  });
  await Promise.all([slow, quick]);
  // Which of two simultaneous starters wins is undefined; that they never interleave is the property.
  assert.ok(
    [JSON.stringify(["a:start", "a:end", "b"]), JSON.stringify(["b", "a:start", "a:end"])].includes(JSON.stringify(order)),
    `critical sections interleaved: ${order.join(", ")}`,
  );
});

test("a live holder is never taken over, however long it holds the lock", async () => {
  const dir = await fresh();
  await initHome(dir, alice);
  const timing = { staleMs: 100, heartbeatMs: 20 };
  const order: string[] = [];
  const slow = withLock(
    dir,
    async () => {
      order.push("slow:start");
      await new Promise((r) => setTimeout(r, 400));
      order.push("slow:end");
    },
    timing,
  );
  await new Promise((r) => setTimeout(r, 30));
  const waiter = withLock(dir, async () => order.push("waiter"), timing);
  await Promise.all([slow, waiter]);
  assert.deepEqual(order, ["slow:start", "slow:end", "waiter"]);
});

test("a lock left by a dead writer is taken over once stale", async () => {
  const dir = await fresh();
  await initHome(dir, alice);
  const lock = join(dir, "lock.0");
  await writeFile(lock, "99999");
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal(await withLock(dir, async () => "ran"), "ran");
});
