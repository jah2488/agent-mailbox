import { setTimeout as sleep } from "node:timers/promises";
import type { AuditEvent } from "./audit.ts";
import { send, sync, type ClientDeps } from "./client.ts";
import { planAnswer, settleAnswer, unanswered, type Plan } from "./daemon-core.ts";
import type { LoadedPolicy } from "./daemon-files.ts";
import { readHome } from "./home.ts";
import type { Inbound } from "./mailbox.ts";
import type { ResponderConfig, ResponderResult } from "./responder.ts";
import type { ShareFile } from "./share.ts";

// The daemon's imperative shell: one tick syncs, works out which asks it
// owes, and answers, defers or ignores each. The decision is audited before
// anything is sent (policy, files the model will see), and each send after.
// What it sends, and why, is decided in daemon-core.

export type DaemonDeps = {
  /** Daemon-mode client: certified agent key, no root key. */
  readonly client: ClientDeps;
  /** The verified policy, or why it could not be loaded. Read every tick so a re-signed policy applies without a restart. */
  readonly policy: () => Promise<LoadedPolicy>;
  readonly share: () => Promise<readonly ShareFile[]>;
  /** Runs the responder the signed policy names. */
  readonly respond: (prompt: string, responder: ResponderConfig) => Promise<ResponderResult>;
  readonly audit: (event: AuditEvent) => Promise<void>;
  /** Asks received before this were the owner's to see; the daemon leaves them alone. */
  readonly since: string;
};

/**
 * What this run remembers between ticks, keyed by sender and seq: asks it
 * ignored (audited once, not every tick), and settled drafts whose send
 * failed (resent without paying for the model again).
 */
export type Handled = { readonly done: ReadonlySet<string>; readonly drafts: ReadonlyMap<string, ResponderResult> };
export const fresh: Handled = { done: new Set(), drafts: new Map() };

const keyOf = (ask: Inbound) => `${ask.from}/${ask.seq}`;

// Where the ask actually arrived, not the relay the sender's invite named. Mail with no record of it matches no relay rule.
const hostOf = (relay: string | undefined) => (relay === undefined ? "" : new URL(relay).host);

export async function tick(deps: DaemonDeps, handled: Handled): Promise<Handled> {
  await sync(deps.client);
  const home = await readHome(deps.client.dir);
  const owed = unanswered(home.state, { me: home.me.pid, since: deps.since }).filter((ask) => !handled.done.has(keyOf(ask)));
  if (owed.length === 0) return handled;

  const [policy, files] = await Promise.all([deps.policy(), deps.share()]);
  const contacts = new Set(home.contacts.keys());
  const done = new Set(handled.done);
  const drafts = new Map(handled.drafts);
  for (const ask of owed) {
    const key = keyOf(ask);
    const askerName = home.contacts.get(ask.from)?.name ?? ask.from;
    const plan: Plan = policy.ok
      ? planAnswer(ask, { policy: policy.cedar, contacts, files, owner: home.me.name, askerName, responder: policy.responder, askerRelay: hostOf(ask.relay) })
      : { kind: "defer", reason: `policy unavailable: ${policy.error}` };
    const about = { ref: ask.body.ref, from: ask.from };
    try {
      await deps.audit({
        kind: "decision",
        data: {
          ...about,
          policy: policy.ok ? { version: policy.version, hash: policy.hash } : null,
          outcome: plan.kind,
          ...(plan.kind === "ask-model" ? { files: plan.files.map((f) => f.path), flagged: plan.flagged } : {}),
          ...(plan.kind === "defer" ? { reason: plan.reason } : {}),
        },
      });
      if (plan.kind === "ignore") {
        done.add(key);
        continue;
      }
      const result = plan.kind === "defer" ? plan : (drafts.get(key) ?? settleAnswer(await deps.respond(plan.prompt, plan.responder)));
      drafts.set(key, result);
      const sent =
        result.kind === "answer"
          ? await send(deps.client, { to: ask.from, tag: "reply", reply_to: ask.body.ref, text: result.text, hops: 1 })
          : // The asker learns only that the owner will pick it up; the reason is for the owner's review.
            await send(deps.client, { to: ask.from, tag: "reply", reply_to: ask.body.ref, text: `${home.me.name}'s agent can't answer this on its own. It's waiting for ${home.me.name}.`, payload: { status: "deferred" }, hops: 1 });
      drafts.delete(key);
      const status = result.kind === "answer" ? { status: "answered", ...(plan.kind === "ask-model" && plan.flagged ? { flagged: true } : {}) } : { status: "deferred", reason: result.reason };
      await deps.audit({ kind: "reply_sent", data: { ...about, ...status, reply: sent.ref, delivered: sent.delivered } });
    } catch (error) {
      // Left out of `done`: the next tick tries again, reusing any draft.
      await deps.audit({ kind: "error", data: { ...about, error: (error as Error).message } });
    }
  }
  return { done, drafts };
}

/** Ticks every intervalMs until aborted. A failed tick is logged and the next one tries again. */
export async function runDaemon(deps: DaemonDeps, options: { readonly intervalMs: number; readonly signal: AbortSignal; readonly log: (line: string) => void }): Promise<void> {
  let handled = fresh;
  while (!options.signal.aborted) {
    try {
      handled = await tick(deps, handled);
    } catch (error) {
      options.log(`tick failed: ${(error as Error).message}`);
    }
    await sleep(options.intervalMs, undefined, { signal: options.signal }).catch(() => undefined);
  }
}
