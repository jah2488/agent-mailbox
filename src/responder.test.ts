import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, parseResponderOutput, runResponder, DEFAULT_RESPONDER } from "./responder.ts";

test("the prompt carries the question and files as marked data, with the rules first", () => {
  const prompt = buildPrompt({ owner: "Justin", asker: "Ada", question: "What are you on?", files: [{ path: "status/today.md", content: "Shipping v1." }] });
  assert.ok(prompt.indexOf("Rules") < prompt.indexOf("What are you on?"));
  const nonce = /<<question-([0-9a-f]{12})>>/.exec(prompt)?.[1];
  assert.ok(nonce, prompt);
  assert.match(prompt, new RegExp(`<<question-${nonce}>>[\\s\\S]*What are you on\\?[\\s\\S]*<<end-question-${nonce}>>`));
  assert.match(prompt, new RegExp(`<<file-${nonce} status/today.md>>[\\s\\S]*Shipping v1\\.[\\s\\S]*<<end-file-${nonce}>>`));
});

test("structured output from claude -p is understood, as is a bare JSON object from another CLI", () => {
  assert.deepEqual(parseResponderOutput('{"structured_output":{"answer":"Shipping v1."},"is_error":false}'), { kind: "answer", text: "Shipping v1." });
  assert.deepEqual(parseResponderOutput('{"defer":"not in what Justin shares"}'), { kind: "defer", reason: "not in what Justin shares" });
});

test("anything else from the responder becomes a defer with a reason, never a reply", () => {
  assert.equal(parseResponderOutput("Sure! Here is my answer").kind, "defer");
  assert.equal(parseResponderOutput('{"is_error":true,"result":"rate limited"}').kind, "defer");
  assert.equal(parseResponderOutput('{"structured_output":{"answer":""}}').kind, "defer");
  assert.equal(parseResponderOutput('{"structured_output":{"answer":"a","defer":"b"}}').kind, "defer");
});

const fake = (script: string) => ({ command: ["node", "-e", script] });

test("the runner sends the prompt on stdin and parses what comes back", async () => {
  const echo = fake(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({structured_output:{answer:"got "+s.length}})))`);
  assert.deepEqual(await runResponder(echo, "12345"), { kind: "answer", text: "got 5" });
});

test("a responder that hangs or fails is a defer, not a crash", async () => {
  assert.equal((await runResponder(fake("setTimeout(()=>{}, 60000)"), "q", { timeoutMs: 200 })).kind, "defer");
  assert.equal((await runResponder(fake("process.exit(3)"), "q")).kind, "defer");
  assert.equal((await runResponder({ command: ["definitely-not-a-command-xyz"] }, "q")).kind, "defer");
});

test("the default responder is claude -p with no tools and none of the owner's setup", () => {
  const argv = DEFAULT_RESPONDER.command;
  assert.equal(argv[0], "claude");
  for (const flag of ["-p", "--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"]) assert.ok(argv.includes(flag), flag);
  assert.equal(argv[argv.indexOf("--tools") + 1], "");
  assert.equal(argv[argv.indexOf("--permission-prompts") + 1], "none");
});
