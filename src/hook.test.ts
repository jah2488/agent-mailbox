import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxNotice, shouldCheck, HOOK_INTERVAL_MS } from "./hook-core.ts";

const now = new Date("2026-11-02T12:00:00Z");

test("the hook checks at most once per interval", () => {
  assert.equal(shouldCheck(null, now), true);
  assert.equal(shouldCheck(new Date(now.getTime() - HOOK_INTERVAL_MS + 1000), now), false);
  assert.equal(shouldCheck(new Date(now.getTime() - HOOK_INTERVAL_MS - 1), now), true);
});

test("an unreadable last-check time means check now, not never again", () => {
  assert.equal(shouldCheck(new Date("not a date"), now), true);
});

test("nothing new means no notice at all, so quiet prompts stay quiet", () => {
  assert.equal(inboxNotice({ waiting: 0, unread: 0, from: [] }), null);
});

test("the notice names senders and the tool, and never includes message text", () => {
  assert.equal(
    inboxNotice({ waiting: 2, unread: 1, from: ["Ada", "Grace"] }),
    "agent-mailbox: 3 unread messages (new from Ada, Grace). Read them with the mailbox_receive tool.",
  );
  assert.equal(inboxNotice({ waiting: 0, unread: 1, from: [] }), "agent-mailbox: 1 unread message. Read it with the mailbox_receive tool.");
});
