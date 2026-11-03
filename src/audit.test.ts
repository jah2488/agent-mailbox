import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, nextEntry, verifyAudit } from "./audit.ts";
import { generateIdentity } from "./identity.ts";

const agent = generateIdentity();
const other = generateIdentity();

function chain(n: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) lines.push(nextEntry(lines.at(-1) ?? null, agent.signSec, { kind: "decision", data: { i }, ts: `2026-11-02T12:00:0${i}Z` }));
  return lines;
}

test("a chain of entries verifies, in order, from the agent's public key", () => {
  const result = verifyAudit(chain(3).join("\n") + "\n", agent.signPub);
  assert.ok(result.ok);
  assert.deepEqual(result.entries.map((e) => [e.seq, e.kind]), [[0, "decision"], [1, "decision"], [2, "decision"]]);
});

test("an edited entry fails verification at that entry", () => {
  const lines = chain(3);
  lines[1] = lines[1]!.replace('"i":1', '"i":9');
  assert.deepEqual(verifyAudit(lines.join("\n"), agent.signPub), { ok: false, seq: 1, reason: "bad signature" });
});

test("a deleted entry breaks the chain at the next one", () => {
  const lines = chain(3);
  assert.deepEqual(verifyAudit([lines[0], lines[2]].join("\n"), agent.signPub), { ok: false, seq: 1, reason: "out of sequence" });
});

test("entries signed by any other key are refused", () => {
  assert.deepEqual(verifyAudit(chain(1).join("\n"), other.signPub), { ok: false, seq: 0, reason: "bad signature" });
});

test("appending to a file extends a verifiable chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-audit-"));
  await appendAudit(dir, agent.signSec, { kind: "ask", data: { ref: "q1" } });
  await appendAudit(dir, agent.signSec, { kind: "reply_sent", data: { ref: "q1" } });
  const result = verifyAudit(await readFile(join(dir, "audit.jsonl"), "utf8"), agent.signPub);
  assert.ok(result.ok);
  assert.deepEqual(result.entries.map((e) => e.kind), ["ask", "reply_sent"]);
});

test("a truncated tail is detected only against an anchor; the file alone still verifies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mailbox-audit-"));
  for (const kind of ["a", "b", "c"]) await appendAudit(dir, agent.signSec, { kind, data: {} });
  const lines = (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n");
  await writeFile(join(dir, "audit.jsonl"), lines.slice(0, 2).join("\n") + "\n");
  const result = verifyAudit(await readFile(join(dir, "audit.jsonl"), "utf8"), agent.signPub);
  assert.ok(result.ok, "a cut tail still verifies on its own: checkpoints are what catch it");
  assert.equal(result.entries.length, 2);
});
