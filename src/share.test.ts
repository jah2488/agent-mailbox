import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readShare, SHARE_LIMITS } from "./share.ts";

async function shareDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mailbox-share-"));
  const share = join(root, "share");
  await mkdir(share);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(share, path, ".."), { recursive: true });
    await writeFile(join(share, path), content);
  }
  return share;
}

test("the share folder is read as relative paths with their text, sorted", async () => {
  const share = await shareDir({ "status/today.md": "shipping v1", "notes/plan.md": "the plan" });
  const { files, skipped } = await readShare(share);
  assert.deepEqual(files, [
    { path: "notes/plan.md", content: "the plan" },
    { path: "status/today.md", content: "shipping v1" },
  ]);
  assert.deepEqual(skipped, []);
});

test("a symlink out of the share folder is never followed", async () => {
  const share = await shareDir({ "ok.md": "fine" });
  const outside = await mkdtemp(join(tmpdir(), "mailbox-outside-"));
  await writeFile(join(outside, "id_rsa"), "PRIVATE KEY");
  await symlink(join(outside, "id_rsa"), join(share, "sneaky.md"));
  await symlink(outside, join(share, "sneakydir"));
  const { files, skipped } = await readShare(share);
  assert.deepEqual(files.map((f) => f.path), ["ok.md"]);
  assert.ok(files.every((f) => !f.content.includes("PRIVATE")));
  assert.deepEqual(skipped.map((s) => s.path).sort(), ["sneaky.md", "sneakydir"]);
});

test("oversized and binary files are skipped with a reason, not read", async () => {
  const share = await shareDir({ "big.md": "x".repeat(SHARE_LIMITS.fileBytes + 1), "image.png": "\u0000\u0001binary" });
  const { files, skipped } = await readShare(share);
  assert.deepEqual(files, []);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]).sort(), [
    ["big.md", "too large"],
    ["image.png", "not text"],
  ]);
});

test("reading stops at the total budget, so one huge folder can't flood a prompt", async () => {
  const chunk = "y".repeat(SHARE_LIMITS.fileBytes - 1);
  const files: Record<string, string> = {};
  for (let i = 0; i < Math.ceil(SHARE_LIMITS.totalBytes / chunk.length) + 2; i++) files[`f${String(i).padStart(2, "0")}.md`] = chunk;
  const result = await readShare(await shareDir(files));
  const total = result.files.reduce((sum, f) => sum + f.content.length, 0);
  assert.ok(total <= SHARE_LIMITS.totalBytes);
  assert.ok(result.skipped.some((s) => s.reason === "over total budget"));
});

test("a missing share folder is empty, not an error", async () => {
  assert.deepEqual(await readShare(join(tmpdir(), "does-not-exist-mailbox-share")), { files: [], skipped: [] });
});
