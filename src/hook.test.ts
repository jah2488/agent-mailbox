import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxNotice, shouldCheck, updateDue, updateNotice, HOOK_INTERVAL_MS, UPDATE_INTERVAL_MS } from "./hook-core.ts";

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

// ---- Update notice ----

type Exec = (program: string, args: readonly string[]) => Promise<{ readonly code: number; readonly output: string }>;
const git = (local: string, remote: string, codes: { readonly local?: number; readonly remote?: number } = {}): Exec => async (_program, args) =>
  args.includes("ls-remote") ? { code: codes.remote ?? 0, output: remote === "" ? "" : `${remote}\trefs/heads/main` } : { code: codes.local ?? 0, output: local };

test("the update check runs at most once a day", () => {
  assert.equal(updateDue(null, now), true);
  assert.equal(updateDue(new Date(now.getTime() - UPDATE_INTERVAL_MS + 1000), now), false);
  assert.equal(updateDue(new Date(now.getTime() - UPDATE_INTERVAL_MS - 1), now), true);
});

test("an install behind main gets one line telling the user to run mailbox update", async () => {
  const notice = await updateNotice(git("aaa111", "bbb222"), "/opt/agent-mailbox");
  assert.match(notice ?? "", /mailbox update/);
});

test("an install at main, or a check that fails or times out, says nothing", async () => {
  assert.equal(await updateNotice(git("aaa111", "aaa111"), "/opt/agent-mailbox"), null);
  assert.equal(await updateNotice(git("aaa111", "", { remote: 128 }), "/opt/agent-mailbox"), null);
  assert.equal(await updateNotice(git("", "bbb222", { local: 128 }), "/opt/agent-mailbox"), null);
});
