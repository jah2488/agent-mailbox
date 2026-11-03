import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatus, type Fact } from "./banner.ts";

const facts: readonly Fact[] = [
  { key: "Name", value: "Anil", strong: true },
  { key: "Relay", value: "relay.example" },
  { key: "Fingerprint", value: "hql2 6l63 p7t5 2svn y7vv 3dvp", strong: true },
];
const ESC = "\x1b";
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("plain output has no escape codes, and the logo keeps one width on every line", () => {
  const lines = renderStatus("anil@agent-mailbox", facts, false);
  assert.ok(!lines.join("\n").includes(ESC));
  const logo = lines.map((l) => [...l].slice(0, 42).join(""));
  assert.ok(logo.every((l) => [...l].length === 42), logo.join("\n"));
});

test("the facts sit beside the logo, each key with its value", () => {
  const text = renderStatus("anil@agent-mailbox", facts, false).join("\n");
  assert.match(text, /anil@agent-mailbox/);
  assert.match(text, /Name\s+Anil/);
  assert.match(text, /Fingerprint\s+hql2 6l63 p7t5 2svn y7vv 3dvp/);
  assert.match(text, /╭──────────────────╮/);
});

test("color output is the same text with 256-color codes, and strong values are bold", () => {
  const colored = renderStatus("anil@agent-mailbox", facts, true);
  assert.deepEqual(colored.map(strip), renderStatus("anil@agent-mailbox", facts, false));
  const joined = colored.join("\n");
  assert.match(joined, /\x1b\[38;5;\d+m/);
  assert.match(joined, /\x1b\[1m[^\x1b]*Anil/);
});

test("the art is the same every time, so it can be checked and never flickers between runs", () => {
  assert.deepEqual(renderStatus("x", facts, true), renderStatus("x", facts, true));
});
