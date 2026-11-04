import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyRelayDescription, WELL_KNOWN_PATH } from "./relay-identity.ts";
import sodium from "./sodium.ts";

// The client's side of relay identity: probe a relay, pin its key the first
// time, and refuse it if the key ever changes. Re-checked at most daily, so
// a relay swapped out from under a URL is refused within a day.

export type RelayPin = { readonly key: string; readonly checkedAt: string };
type Pins = Readonly<Record<string, RelayPin>>;
type Deps = { readonly dir: string; readonly fetch: typeof fetch; readonly now: () => Date; readonly timeoutMs?: number };
export type RelayCheck = { readonly ok: true; readonly relayKey: string } | { readonly ok: false; readonly error: string };

const FILE = "relays.json";
const RECHECK_MS = 86_400_000;
// No real pid: an honest relay refuses this read for lack of a signature, whoever it names.
const UNSIGNED_PROBE = "/inbox/aaaaaaaaaaaaaaaa";

export async function readPins(dir: string): Promise<Pins> {
  try {
    return JSON.parse(await readFile(join(dir, FILE), "utf8")) as Pins;
  } catch {
    return {};
  }
}

async function writePin(dir: string, relay: string, pin: RelayPin): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 }); // setup checks the relay before the home exists
  const path = join(dir, FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...(await readPins(dir)), [relay]: pin }, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

/** Does this relay speak the protocol and prove which relay it is? */
export async function probeRelay(deps: Pick<Deps, "fetch" | "timeoutMs">, relay: string): Promise<RelayCheck> {
  const challenge = sodium.to_base64(sodium.randombytes_buf(24), sodium.base64_variants.URLSAFE_NO_PADDING);
  const signal = () => AbortSignal.timeout(deps.timeoutMs ?? 10_000);
  try {
    const res = await deps.fetch(`${relay}${WELL_KNOWN_PATH}?challenge=${challenge}`, { signal: signal() });
    if (res.status === 503) return { ok: false, error: "has no key of its own, so it can't prove which relay it is" };
    if (res.status !== 200) return { ok: false, error: `doesn't speak the agent-mailbox protocol (answered ${res.status})` };
    const verified = verifyRelayDescription(await res.json().catch(() => null), new URL(relay).host, challenge);
    if (!verified.ok) return { ok: false, error: `failed its identity check: ${verified.error}` };
    const unsigned = await deps.fetch(`${relay}${UNSIGNED_PROBE}`, { signal: signal() });
    if (unsigned.status !== 401) return { ok: false, error: `serves inbox reads without a signature (answered ${unsigned.status})` };
    return verified;
  } catch (error) {
    return { ok: false, error: `couldn't be reached (${(error as Error).message})` };
  }
}

/**
 * The relay's key, checked: pinned the first time, then refused if it ever
 * changes. claimed is the key an invite named for the relay; it must match too.
 */
export async function checkRelay(deps: Deps, relay: string, claimed?: string): Promise<RelayCheck> {
  const pin = (await readPins(deps.dir))[relay];
  const fresh = pin !== undefined && deps.now().getTime() - Date.parse(pin.checkedAt) < RECHECK_MS;
  if (fresh && (claimed === undefined || claimed === pin.key)) return { ok: true, relayKey: pin.key };
  const probed = await probeRelay(deps, relay);
  if (!probed.ok) return probed;
  if (pin !== undefined && pin.key !== probed.relayKey) return { ok: false, error: "its key changed since you first used it; refusing it" };
  if (claimed !== undefined && claimed !== probed.relayKey) return { ok: false, error: "doesn't have the key the invite named; refusing it" };
  await writePin(deps.dir, relay, { key: probed.relayKey, checkedAt: deps.now().toISOString() });
  return probed;
}
