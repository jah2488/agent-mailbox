import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml, stringifyToml } from "./toml.ts";

const ok = (text: string) => {
  const r = parseToml(text);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
};
const err = (text: string) => {
  const r = parseToml(text);
  assert.ok(!r.ok, "expected a parse error");
  return r.error;
};

test("tables, nested tables, strings, booleans, integers and arrays parse", () => {
  assert.deepEqual(
    ok(`# a comment
top = "level"

[daemon]
answer = true   # trailing comment
poll_seconds = 30
contacts = ["Robin", "Sam",]

[share.folders]
status = '~/.agent-mailbox/share/status'
notes = "C:\\\\notes \\"quoted\\" \\u00e9"
`),
    { top: "level", daemon: { answer: true, poll_seconds: 30, contacts: ["Robin", "Sam"] }, share: { folders: { status: "~/.agent-mailbox/share/status", notes: 'C:\\notes "quoted" é' } } },
  );
  assert.deepEqual(ok(""), {});
  assert.deepEqual(ok("n = -5\nempty = []"), { n: -5, empty: [] });
});

test("a # inside a string is text, not a comment", () => {
  assert.deepEqual(ok(`path = "~/a#b" # real comment`), { path: "~/a#b" });
});

test("anything outside the subset, or ambiguous, is refused with its line number", () => {
  assert.equal(err(`a = 1\na = 2`), "line 2: duplicate key a");
  assert.equal(err(`[x]\n[x]`), "line 2: duplicate table [x]");
  assert.equal(err(`[x]\ny = 1\n[x.y]`), "line 3: [x.y] redefines key y");
  assert.equal(err(`a = 1.5`), "line 1: unsupported value 1.5 (strings, true/false, integers and arrays only)");
  assert.equal(err(`a = 2026-11-04`), "line 1: unsupported value 2026-11-04 (strings, true/false, integers and arrays only)");
  assert.equal(err(`a = """multi"""`), "line 1: multi-line strings aren't supported");
  assert.equal(err(`a = { b = 1 }`), "line 1: inline tables aren't supported; use a [table]");
  assert.equal(err(`[[folder]]`), "line 1: arrays of tables aren't supported");
  assert.equal(err(`"quoted key" = 1`), "line 1: keys must be bare (letters, digits, _ and -)");
  assert.equal(err(`a = "unterminated`), "line 1: unterminated string");
  assert.equal(err(`a = "bad \\q escape"`), "line 1: bad escape \\q");
  assert.equal(err(`a = [1, "mixed"]`), "line 1: arrays must hold one type");
  assert.equal(err(`a = 1 b = 2`), "line 1: unexpected text after the value");
  assert.equal(err(`just words`), "line 1: expected key = value or [table]");
  assert.equal(err(`a = 99999999999999999999`), "line 1: integer out of range");
});

test("stringify writes what parse reads back, tables after plain keys", () => {
  const value = { top: "x", daemon: { answer: false, poll_seconds: 45, contacts: ["Robin"] }, share: { folders: { status: 'a "b" \\ c' } } };
  const text = stringifyToml(value);
  assert.equal(
    text,
    `top = "x"

[daemon]
answer = false
poll_seconds = 45
contacts = ["Robin"]

[share.folders]
status = "a \\"b\\" \\\\ c"
`,
  );
  assert.deepEqual(ok(text), value);
});
