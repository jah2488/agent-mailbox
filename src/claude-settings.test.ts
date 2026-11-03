import { test } from "node:test";
import assert from "node:assert/strict";
import { withHook, withoutHook } from "./claude-settings.ts";

const OURS = "node /opt/agent-mailbox/src/hook.ts";
const theirs = { type: "command", command: "~/bin/other-hook.sh" };

test("the inbox hook is added beside existing hooks and settings, which stay as they were", () => {
  const before = { model: "opus", hooks: { UserPromptSubmit: [{ hooks: [theirs] }], Stop: [{ hooks: [theirs] }] } };
  assert.deepEqual(withHook(before, OURS), {
    model: "opus",
    hooks: { UserPromptSubmit: [{ hooks: [theirs] }, { hooks: [{ type: "command", command: OURS, timeout: 5 }] }], Stop: [{ hooks: [theirs] }] },
  });
});

test("adding twice, or after an install from another path, leaves exactly one inbox hook", () => {
  const old = withHook({}, "node /Users/someone/old-checkout/agent-mailbox/src/hook.ts");
  const twice = withHook(withHook(old, OURS), OURS);
  assert.deepEqual(twice, { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: OURS, timeout: 5 }] }] } });
});

test("an empty or missing settings file gets just the hook", () => {
  assert.deepEqual(withHook({}, OURS), { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: OURS, timeout: 5 }] }] } });
});

test("removing takes out only the inbox hook, and drops groups and keys it leaves empty", () => {
  const mixed = { hooks: { UserPromptSubmit: [{ hooks: [theirs, { type: "command", command: OURS }] }] } };
  assert.deepEqual(withoutHook(mixed), { hooks: { UserPromptSubmit: [{ hooks: [theirs] }] } });
  assert.deepEqual(withoutHook(withHook({ model: "opus" }, OURS)), { model: "opus" });
});

test("settings whose hooks aren't the documented shape are refused, never rewritten", () => {
  assert.throws(() => withHook({ hooks: "nope" }, OURS), /hooks/);
  assert.throws(() => withHook({ hooks: { UserPromptSubmit: {} } }, OURS), /UserPromptSubmit/);
  assert.throws(() => withHook([], OURS), /object/);
});
