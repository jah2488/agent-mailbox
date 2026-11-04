import { test } from "node:test";
import assert from "node:assert/strict";
import { broadFolder, DEFAULT_SETTINGS, parseSettings, setSetting } from "./settings.ts";

const HOME = "/Users/robin";

test("an empty or missing config means the defaults", () => {
  assert.deepEqual(parseSettings("", HOME), { ok: true, settings: DEFAULT_SETTINGS, warnings: [] });
  assert.equal(DEFAULT_SETTINGS.share.folders, null, "no folders listed: the daemon reads ~/.agent-mailbox/share as before");
  assert.deepEqual(DEFAULT_SETTINGS.daemon, { answer: true, poll_seconds: 30, contacts: ["*"] });
  assert.deepEqual(DEFAULT_SETTINGS.notifications, { inbox_hook: true, promise_reminders: true, update_check: true });
});

test("every setting is read, and what's left out keeps its default", () => {
  const parsed = parseSettings(
    `[share.folders]
status = "~/.agent-mailbox/share/status"
team = "~/work/team-notes"

[daemon]
poll_seconds = 120
contacts = ["Sam"]

[notifications]
update_check = false
`,
    HOME,
  );
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.settings.share.folders, { status: "~/.agent-mailbox/share/status", team: "~/work/team-notes" });
  assert.deepEqual(parsed.settings.daemon, { answer: true, poll_seconds: 120, contacts: ["Sam"] });
  assert.deepEqual(parsed.settings.notifications, { inbox_hook: true, promise_reminders: true, update_check: false });
});

test("the schema refuses unknown keys, wrong types and out-of-range values, naming each", () => {
  const parsed = parseSettings(
    `colour = "blue"
[daemon]
answer = "yes"
poll_seconds = 2
contacts = []
[share.folders]
"x" = 1
`,
    HOME,
  );
  assert.ok(!parsed.ok);
  assert.match(parsed.errors[0]!, /^line 7: keys must be bare/, "TOML syntax errors come first, alone");
  const typed = parseSettings(`colour = "blue"\n[daemon]\nanswer = "yes"\npoll_seconds = 2\ncontacts = []\n[share.folders]\nBad_Name = "~/x"\nrel = "notes"\n[extra]\n`, HOME);
  assert.ok(!typed.ok);
  assert.deepEqual(typed.errors, [
    "colour: unknown setting",
    "extra: unknown section",
    "daemon.answer: must be true or false",
    "daemon.poll_seconds: must be a whole number from 10 to 3600",
    'daemon.contacts: must list at least one contact name, or "*" for everyone',
    "share.folders.Bad_Name: folder names are lowercase letters, digits, _ and -",
    "share.folders.rel: must be an absolute path or start with ~/",
  ]);
});

test("folders that would break the security contract are flagged as warnings", () => {
  const parsed = parseSettings(`[share.folders]\nall = "~/"\nkeys = "~/.ssh"\nok = "~/work/notes"\n`, HOME);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.warnings, ["share.folders.all (~/) covers your whole home folder", "share.folders.keys (~/.ssh) holds keys or credentials (~/.ssh)"]);
});

test("broad folders: home and above, credential folders and their parents, whole standard folders, the mailbox's own files", () => {
  const cases: [string, string | null][] = [
    ["/", "covers your whole home folder"],
    ["/Users", "covers your whole home folder"],
    ["~", "covers your whole home folder"],
    ["~/.ssh/keys", "holds keys or credentials (~/.ssh)"],
    ["~/.aws", "holds keys or credentials (~/.aws)"],
    ["~/Library", "holds keys or credentials (~/Library)"],
    ["~/.config/gh", "holds keys or credentials (~/.config)"],
    ["~/Documents", "is a whole standard folder (~/Documents)"],
    ["~/Desktop/", "is a whole standard folder (~/Desktop)"],
    ["~/.agent-mailbox", "holds keys or credentials (~/.agent-mailbox)"],
    ["~/.agent-mailbox/share/notes", null],
    ["~/Documents/team-notes", null],
    ["/Users/robin/work/../.ssh", "holds keys or credentials (~/.ssh)"],
  ];
  for (const [path, want] of cases) assert.equal(broadFolder(path, HOME), want, path);
});

test("set changes one setting, checks it against the schema, and refuses broad folders for hand-editing", () => {
  const base = `[daemon]\npoll_seconds = 30\n`;
  const poll = setSetting(base, "daemon.poll_seconds", "90", HOME);
  assert.ok(poll.ok);
  assert.match(poll.text, /poll_seconds = 90/);
  const contacts = setSetting(base, "daemon.contacts", "Sam, Robin", HOME);
  assert.ok(contacts.ok);
  assert.match(contacts.text, /contacts = \["Sam", "Robin"\]/);
  assert.deepEqual(setSetting(base, "daemon.poll_seconds", "1", HOME), { ok: false, error: "daemon.poll_seconds: must be a whole number from 10 to 3600" });
  assert.deepEqual(setSetting(base, "daemon.colour", "x", HOME), { ok: false, error: "daemon.colour: unknown setting" });
  const added = setSetting(base, "share.folders.team", "~/work/team", HOME);
  assert.ok(added.ok);
  assert.match(added.text, /\[share\.folders\]\nteam = "~\/work\/team"/);
  assert.deepEqual(setSetting(base, "share.folders.all", "~/", HOME), {
    ok: false,
    error: "share.folders.all (~/) covers your whole home folder. That would let your daemon read far more than you mean to share, so the CLI won't add it. If you really mean it, edit config.toml by hand.",
  });
  const removed = setSetting(added.text, "share.folders.team", null, HOME);
  assert.ok(removed.ok);
  assert.doesNotMatch(removed.text, /team/);
});

test("an unknown key inside a known section is an error too", () => {
  assert.deepEqual(parseSettings(`[daemon]\ncolour = "blue"\n[notifications]\nemail = true\n`, HOME), { ok: false, errors: ["daemon.colour: unknown setting", "notifications.email: unknown setting"] });
});
