import type { AuditEvent } from "./audit.ts";
import { send, sync, type ClientDeps } from "./client.ts";
import { planAnswer, settleAnswer, unanswered, type Plan } from "./daemon-core.ts";
import { readHome } from "./home.ts";
import type { Inbound } from "./mailbox.ts";
import type { ResponderResult } from "./responder.ts";
import type { ShareFile } from "./share.ts";

// The daemon's imperative shell: one tick syncs, works out which asks it
// owes, and answers, defers or ignores each. Every outcome is audited after
// it happens. What it sends, and why, is decided in daemon-core.

export type DaemonDeps = {
  /** Daemon-mode client: certified agent key, no root key. */
  readonly client: ClientDeps;
  /** The verified Cedar policy text, or why it could not be loaded. Read every tick so a re-signed policy applies without a restart. */
  readonly policy: () => Promise<{ readonly ok: true; readonly cedar: string } | { readonly ok: false; readonly error: string }>;
  readonly share: () => Promise<readonly ShareFile[]>;
  readonly respond: (prompt: string) => Promise<ResponderResult>;
  readonly audit: (event: AuditEvent) => Promise<void>;
  /** Asks received before this were the owner's to see; the daemon leaves them alone. */
  readonly since: string;
};

/** Asks already ignored or failed this run, by sender and seq, so they're audited once rather than every tick. */
export type Handled = ReadonlySet<string>;

const keyOf = (ask: Inbound) => `${ask.from}/${ask.seq}`;

export async function tick(deps: DaemonDeps, handled: Handled): Promise<Handled> {
  await sync(deps.client);
  const home = await readHome(deps.client.dir);
  const owed = unanswered(home.state, { me: home.me.pid, since: deps.since }).filter((ask) => !handled.has(keyOf(ask)));
  if (owed.length === 0) return handled;

  const [policy, files] = await Promise.all([deps.policy(), deps.share()]);
  const contacts = new Set(home.contacts.keys());
  const done = new Set(handled);
  for (const ask of owed) {
    const askerName = home.contacts.get(ask.from)?.name ?? ask.from;
    const plan: Plan = policy.ok
      ? planAnswer(ask, { policy: policy.cedar, contacts, files, owner: home.me.name, askerName })
      : { kind: "defer", reason: `policy unavailable: ${policy.error}` };
    const about = { ref: ask.body.ref, from: ask.from };
    try {
      if (plan.kind === "ignore") {
        await deps.audit({ kind: "ignored", data: about });
        done.add(keyOf(ask));
        continue;
      }
      const result = plan.kind === "defer" ? plan : settleAnswer(await deps.respond(plan.prompt));
      if (result.kind === "answer") {
        const sent = await send(deps.client, { to: ask.from, tag: "reply", reply_to: ask.body.ref, text: result.text, hops: 1 });
        const used = plan.kind === "ask-model" ? { files: plan.files.map((f) => f.path), flagged: plan.flagged } : {};
        await deps.audit({ kind: "answered", data: { ...about, ...used, reply: sent.ref, delivered: sent.delivered } });
      } else {
        // The asker learns only that the owner will pick it up; the reason is for the owner's review.
        const text = `${home.me.name}'s agent can't answer this on its own. It's waiting for ${home.me.name}.`;
        const sent = await send(deps.client, { to: ask.from, tag: "reply", reply_to: ask.body.ref, text, payload: { status: "deferred" }, hops: 1 });
        await deps.audit({ kind: "deferred", data: { ...about, reason: result.reason, reply: sent.ref, delivered: sent.delivered } });
      }
    } catch (error) {
      // Left out of `done`: a reply that never got sealed is retried next tick.
      await deps.audit({ kind: "error", data: { ...about, error: (error as Error).message } });
    }
  }
  return done;
}
