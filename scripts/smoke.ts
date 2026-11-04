// End-to-end check of a running relay (netlify dev or a deploy).
//   node scripts/smoke.ts keys <dir>          write 3 test identities + roots.json
//   node scripts/smoke.ts run <dir> <url>     exercise the relay; exit 1 on any failure
// Identities are throwaway: they only exist for the relay under test.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateIdentity, toPeer, type Identity } from "../src/identity.ts";
import { fullChecks, readTestKeys } from "../src/relay-verify.ts";
import { rootEntry } from "../src/roots.ts";
import sodium from "../src/sodium.ts";

const NAMES = ["alice", "bob", "carol"] as const;
type Name = (typeof NAMES)[number];

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

function writeKeys(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const ids = Object.fromEntries(NAMES.map((name) => [name, generateIdentity()])) as Record<Name, Identity>;
  const secrets = Object.fromEntries(
    NAMES.map((name) => [name, { sign_sec: b64(ids[name].signSec), sign_pub: b64(ids[name].signPub), box_sec: b64(ids[name].boxSec), box_pub: b64(ids[name].boxPub) }]),
  );
  writeFileSync(join(dir, "keys.json"), JSON.stringify(secrets, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, "roots.json"), JSON.stringify(NAMES.map((name) => rootEntry(toPeer(ids[name])))));
  console.log(`wrote ${join(dir, "keys.json")} and roots.json`);
}

async function run(dir: string, base: string): Promise<void> {
  // Saved runs are evidence, so each one says where, when and what it tested.
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  console.log(`relay ${base} | commit ${commit} | ${new Date().toISOString()}`);
  // The same checks `mailbox relay verify --full` runs. Each run writes seq 0, so rerunning needs fresh keys.
  const checks = await fullChecks(fetch, base, readTestKeys(dir));
  for (const c of checks) console.log(`${c.pass ? "✓" : "✗"} ${c.label}${c.detail === undefined ? "" : `: ${c.detail}`}`);
  const failures = checks.filter((c) => !c.pass).length;
  console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

const [mode, dir, url] = process.argv.slice(2);
if (mode === "keys" && dir) writeKeys(dir);
else if (mode === "run" && dir && url) await run(dir, url.replace(/\/$/, ""));
else {
  console.error("usage: smoke.ts keys <dir> | run <dir> <url>");
  process.exit(2);
}
