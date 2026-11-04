import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { negotiate, PROTOCOL_VERSION, securityFloor, VERSION_HEADER } from "./protocol-version.ts";
import { verifyRelayDescription, WELL_KNOWN_PATH } from "./relay-identity.ts";
import sodium from "./sodium.ts";

// The client's side of relay identity: probe a relay, pin its key the first
// time, and refuse it if the key ever changes. Re-checked at most daily, so
// a relay swapped out from under a URL is refused within a day. The same
// check settles which protocol version to speak with it.

/** version is absent on pins written before versioning, or for a relay that predates it. */
export type RelayPin = { readonly key: string; readonly checkedAt: string; readonly version?: string };
type Pins = Readonly<Record<string, RelayPin>>;
type Deps = { readonly dir: string; readonly fetch: typeof fetch; readonly now: () => Date; readonly timeoutMs?: number };
/** version: what to speak with the relay. notice: a mismatch worth telling the person about. */
export type RelayCheck = { readonly ok: true; readonly relayKey: string; readonly version: string; readonly notice?: string } | { readonly ok: false; readonly error: string };
type Probed = { readonly ok: true; readonly relayKey: string; readonly version: string; readonly versioned: boolean } | { readonly ok: false; readonly error: string };

const FILE = "relays.json";
const RECHECK_MS = 86_400_000;
// No real pid: an honest relay refuses this read for lack of a signature, whoever it names.
const UNSIGNED_PROBE = "/inbox/aaaaaaaaaaaaaaaa";

/** The pinned relays. Missing is empty; unreadable throws, so a damaged file never means "trust whatever answers". */
export async function readPins(dir: string): Promise<Pins> {
  let text: string;
  try {
    text = await readFile(join(dir, FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(text) as Pins;
  } catch {
    throw new Error(`${join(dir, FILE)} is unreadable; fix it or delete it to pin your relays again`);
  }
}

async function writePin(dir: string, relay: string, pin: RelayPin): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 }); // setup checks the relay before the home exists
  const path = join(dir, FILE);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...(await readPins(dir)), [relay]: pin }, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

/** Does this relay speak the protocol and prove which relay it is? */
export async function probeRelay(deps: Pick<Deps, "fetch" | "timeoutMs">, relay: string): Promise<Probed> {
  const challenge = sodium.to_base64(sodium.randombytes_buf(24), sodium.base64_variants.URLSAFE_NO_PADDING);
  const signal = () => AbortSignal.timeout(deps.timeoutMs ?? 10_000);
  try {
    const res = await deps.fetch(`${relay}${WELL_KNOWN_PATH}?challenge=${challenge}`, { signal: signal() });
    if (res.status === 503) return { ok: false, error: "has no key of its own, so it can't prove which relay it is" };
    if (res.status !== 200) return { ok: false, error: `doesn't speak the agent-mailbox protocol (answered ${res.status})` };
    const verified = verifyRelayDescription(await res.json().catch(() => null), new URL(relay).host, challenge);
    if (!verified.ok) return { ok: false, error: `failed its identity check: ${verified.error}` };
    const unsigned = await deps.fetch(`${relay}${UNSIGNED_PROBE}`, { signal: signal(), headers: { [VERSION_HEADER]: PROTOCOL_VERSION } });
    if (unsigned.status !== 401) return { ok: false, error: `serves inbox reads without a signature (answered ${unsigned.status})` };
    return verified;
  } catch (error) {
    return { ok: false, error: `couldn't be reached (${(error as Error).message})` };
  }
}

/** The version to speak with a relay, or a refusal when it's below this build's security floor. */
function agreed(relayKey: string, theirs: string): RelayCheck {
  const n = negotiate({ mine: PROTOCOL_VERSION, theirs, floor: securityFloor(), side: "relay" });
  if (!n.ok) return { ok: false, error: n.error };
  return { ok: true, relayKey, version: n.version, ...(n.notice === undefined ? {} : { notice: n.notice }) };
}

/**
 * The relay's key, checked: pinned the first time, then refused if it ever
 * changes. claimed is the key an invite named for the relay; it must match too.
 */
export async function checkRelay(deps: Deps, relay: string, claimed?: string): Promise<RelayCheck> {
  let pins: Pins;
  try {
    pins = await readPins(deps.dir);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const pin = pins[relay];
  const fresh = pin !== undefined && deps.now().getTime() - Date.parse(pin.checkedAt) < RECHECK_MS;
  if (fresh && (claimed === undefined || claimed === pin.key)) return agreed(pin.key, pin.version ?? "1.0");
  const probed = await probeRelay(deps, relay);
  if (!probed.ok) return probed;
  if (pin !== undefined && pin.key !== probed.relayKey) return { ok: false, error: "its key changed since you first used it; refusing it" };
  if (claimed !== undefined && claimed !== probed.relayKey) return { ok: false, error: "doesn't have the key the invite named; refusing it" };
  // Dropping the version (and its signature) would make a relay look older than it is; once it has signed one, it must keep doing so.
  if (pin?.version !== undefined && !probed.versioned) return { ok: false, error: "answered without the version it signed before; refusing it" };
  const result = agreed(probed.relayKey, probed.version);
  if (!result.ok) return result;
  await writePin(deps.dir, relay, { key: probed.relayKey, checkedAt: deps.now().toISOString(), ...(probed.versioned ? { version: probed.version } : {}) });
  return result;
}
