import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { canonicalize } from "./canonical.ts";
import type { Identity, Peer, Pid } from "./identity.ts";
import sodium from "./sodium.ts";

// What the daemon may share, and with whom, as Cedar. Cedar's answer is only
// Allow or Deny; the deciding policies and their @tier annotations recover
// four tiers:
//   Allow by @tier("allow")         -> allow: answered from it
//   Allow by anything else           -> flag: answered, and shown to the owner
//   Deny with a forbid deciding      -> deny: never used
//   Deny with nothing deciding       -> defer: no rule covers it; the owner decides
// An unannotated permit is flag, never a silent allow.

export type Tier = "allow" | "flag" | "deny" | "defer";
/**
 * Everything the daemon's behaviour rests on, signed together by the root:
 * the sharing rules and the responder command that sees what they allow.
 * No responder means the built-in `claude -p`.
 */
export type SignedPolicy = { readonly p: { readonly v: 1; readonly version: number; readonly cedar: string; readonly responder?: readonly string[] }; readonly s: string };

const POLICY_DOMAIN = "agent-mailbox/v1/policy\n";

export const DEFAULT_POLICY = `// agent-mailbox sharing policy. Paths are relative to ~/.agent-mailbox/share/.
// Edit, then run: mailbox policy sign

// Anyone in your roster may be answered from status/ files.
@tier("allow")
permit(principal in Group::"contacts", action == Action::"read", resource)
when { resource.path like "status/*" };

// notes/ can be used too, but every answer that draws on them is flagged for you.
@tier("flag")
permit(principal in Group::"contacts", action == Action::"read", resource)
when { resource.path like "notes/*" };

// Never, whatever any permit says.
forbid(principal, action, resource)
when { resource.path like "*secret*" || resource.path like "*private*" };
`;

type Parsed = { readonly policies: Readonly<Record<string, string>>; readonly tiers: Readonly<Record<string, string | undefined>> };

/** Splits the text into policies with ids we control, and reads each one's @tier. Null if it doesn't parse. */
function parse(text: string): Parsed | null {
  const parts = cedar.policySetTextToParts(text);
  if (parts.type !== "success" || parts.policy_templates.length > 0) return null;
  const policies: Record<string, string> = {};
  const tiers: Record<string, string | undefined> = {};
  for (const [index, policy] of parts.policies.entries()) {
    const id = `p${index}`;
    const json = cedar.policyToJson(policy);
    if (json.type !== "success") return null;
    policies[id] = policy;
    tiers[id] = json.json.annotations?.["tier"] ?? undefined;
  }
  return { policies, tiers };
}

/** For `policy sign`: refuse to sign text the daemon would treat as deny-everything. */
export const policyParses = (text: string): boolean => parse(text) !== null;

export function decide(
  text: string,
  request: {
    readonly principal: Pid;
    readonly path: string;
    readonly contacts: ReadonlySet<Pid>;
    /** The host of the relay the asker came through, as principal.relay: per-relay rules are policy, not prompt. */
    readonly relay?: string;
  },
): { readonly tier: Tier; readonly policies: readonly string[] } {
  const parsed = parse(text);
  if (parsed === null) return { tier: "deny", policies: [] };
  const inContacts = request.contacts.has(request.principal);
  const answer = cedar.isAuthorized({
    principal: { type: "Person", id: request.principal },
    action: { type: "Action", id: "read" },
    resource: { type: "File", id: request.path },
    context: {},
    policies: { staticPolicies: parsed.policies },
    entities: [
      { uid: { type: "Person", id: request.principal }, attrs: { relay: request.relay ?? "" }, parents: inContacts ? [{ type: "Group", id: "contacts" }] : [] },
      { uid: { type: "Group", id: "contacts" }, attrs: {}, parents: [] },
      { uid: { type: "File", id: request.path }, attrs: { path: request.path }, parents: [] },
    ],
  });
  // Any evaluation error fails closed.
  if (answer.type !== "success" || answer.response.diagnostics.errors.length > 0) return { tier: "deny", policies: [] };
  const { decision, diagnostics } = answer.response;
  const policies = diagnostics.reason;
  if (decision === "deny") return { tier: policies.length > 0 ? "deny" : "defer", policies };
  return { tier: policies.every((id) => parsed.tiers[id] === "allow") ? "allow" : "flag", policies };
}

const b64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);
const unb64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
const signedBytes = (p: SignedPolicy["p"]) => new TextEncoder().encode(POLICY_DOMAIN + canonicalize(p));

/** Only the root signs policy, so a compromised daemon can never widen its own access. */
export function signPolicy(root: Identity, version: number, text: string, responder?: readonly string[]): SignedPolicy {
  const p = { v: 1 as const, version, cedar: text, ...(responder === undefined ? {} : { responder }) };
  return { p, s: b64(sodium.crypto_sign_detached(signedBytes(p), root.signSec)) };
}

/**
 * Accepts a policy only if the root signed it, its version is at least
 * minVersion (so an older, looser policy can't be put back), and it parses.
 */
export function verifyPolicy(
  signed: SignedPolicy,
  root: Peer,
  minVersion: number,
): { readonly ok: true; readonly cedar: string; readonly version: number; readonly responder: readonly string[] | null } | { readonly ok: false; readonly error: string } {
  try {
    if (!sodium.crypto_sign_verify_detached(unb64(signed.s), signedBytes(signed.p), root.signPub)) return { ok: false, error: "bad policy signature" };
  } catch {
    return { ok: false, error: "bad policy signature" };
  }
  if (!Number.isSafeInteger(signed.p.version) || signed.p.version < minVersion) return { ok: false, error: `policy version ${signed.p.version} is older than ${minVersion}` };
  if (parse(signed.p.cedar) === null) return { ok: false, error: "policy does not parse" };
  const responder = signed.p.responder ?? null;
  if (responder !== null && !isCommand(responder)) return { ok: false, error: "policy responder is not a command" };
  return { ok: true, cedar: signed.p.cedar, version: signed.p.version, responder };
}

/** A program and its arguments, as spawn takes them: never a shell string. */
export const isCommand = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.length > 0);
