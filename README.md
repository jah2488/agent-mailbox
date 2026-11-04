# agent-mailbox

Signed, encrypted, asynchronous mail between coworkers' AI agents, modelled on Erlang mailboxes. Each person has a root key. Their agents send envelopes through an untrusted relay that only ever holds ciphertext from its members. An optional daemon answers teammates' questions from a folder you choose, under a policy you sign, and records everything it does in a signed audit log.

Status: experiment. macOS and Claude Code only, Node 22.18 or newer.

Docs, install steps and the full relay spec: <https://agent-mailbox.netlify.app>

## You need a relay

Mail travels through a relay. Get your team's relay URL before installing; you can also connect with people whose home is a different relay. Your team doesn't have one yet? [Run a relay](docs/run-a-relay.md) takes about ten minutes on Netlify. The tool checks every relay before using it and refuses one that can't prove which relay it is or doesn't follow [the relay protocol](docs/relay-protocol.md).

## Install

One command:

```sh
curl -fsSL https://raw.githubusercontent.com/jah2488/agent-mailbox/main/install.sh | bash
```

It asks for your team's relay URL, then the name you want to be known by there. Pass `--relay` or `--name` to skip either question, for example when a teammate hands you a command with the relay filled in:

```sh
curl -fsSL https://raw.githubusercontent.com/jah2488/agent-mailbox/main/install.sh | bash -s -- --relay https://your-relay.example
```

It installs into `~/.local/share/agent-mailbox`, puts `mailbox` in `~/.local/bin`, registers the MCP server with Claude Code, adds an inbox hook to `~/.claude/settings.json` so new mail is mentioned at the start of your next prompt (your other settings stay, and the old file is kept as `settings.json.agent-mailbox.bak`), creates your identity (the secret key goes to the Keychain), and certifies a separate key for your daemon. Restart Claude Code afterwards. Run `mailbox update` to update.

Then, once per teammate:

1. Run `mailbox invite`. It copies the exact command your teammates run to add you (`mailbox peer add am1-...`). Paste it to them; it holds only public keys.
2. Run each teammate's invite command. That adds them, and sends them a hello.

`mailbox peers` shows each teammate as connected once their mail reaches you, or as waiting for them to add you. Only someone holding your real key can reach you, so a teammate stuck on waiting after they say they've added you means one of the invites was swapped. Compare the fingerprints `mailbox peers` shows with theirs. A teammate picks their own display name (up to 32 letters, digits and simple punctuation), and your agent sees it as a label, so add only people you know.

Running a teammate's invite also vouches for them on your relay, so they can send right away (unless your relay's operator has made joining stricter; see [Run a relay](docs/run-a-relay.md)). If their home is a different relay, running it hosts them as a guest on yours instead: they can read what you send them, and nothing else. Each of you runs the other's invite, and your mail travels both ways. `mailbox peer remove <name>` drops a contact and withdraws your vouch or stops hosting them.

In Claude Code your agent now has `mailbox_send`, `mailbox_receive`, `mailbox_peers` and `mailbox_thread`. The installer also adds an `ask` rule for `mailbox_send`, so Claude Code shows you every outgoing message for approval, in auto mode too. When mail arrives, your agent tells you what it is and what it needs from you: an ask gets a drafted reply for you to approve, and anything a teammate sends (a skill, a script, a config) is shown to you before anything is installed, run or changed.

## Promises

When you can't answer an ask yet, your agent can promise to: a `promise` names the ask and the item, with an optional condition and due date. Later it sends `fulfil` or `break` for the same item. Every one of these is a normal send, so it asks you first. `mailbox promises` (and the `mailbox_promises` tool) lists what you've promised and what you've been promised. Once a day, Claude Code mentions any promise you made that's overdue or has gone 30 days with no due date.

## The daemon

The daemon answers teammates' `ask` messages while you're busy:

- It reads only `~/.agent-mailbox/share/`. Files in `status/` are answered from; answers that use `notes/` are flagged for you; anything named `secret` or `private` is never used.
- The rules live in `~/.agent-mailbox/policy.cedar`. After editing them, run `mailbox policy sign`, which needs your root key.
- A tool-less `claude -p` drafts each answer from the allowed files only. To use another command, put `{"command": ["program", "arg"]}` in `~/.agent-mailbox/responder.json` and run `mailbox policy sign`.
- An ask it can't answer, a draft that looks like it holds a secret, or any failure becomes a short "waiting for you" reply. The reason stays with you.

```sh
mailbox daemon start    # on now, and at every login (a launchd agent)
mailbox daemon stop     # off, and removed from login
mailbox daemon once     # one pass in the foreground, to try it
mailbox review          # what the daemon deferred or flagged, and its answers to grade
mailbox grade <ref> right|wrong   # your verdict on one answer, kept in ~/.agent-mailbox/grades.json
mailbox audit verify    # check the audit log is intact and signed
mailbox daemon revoke   # tell every contact to refuse this daemon from now on
mailbox daemon setup    # renew the daemon's cert; certs last 30 days, and an expired one stops the daemon
mailbox policy show     # the policy in force, and its version
```

`daemon start` adds a launch agent, so macOS shows a background-item notice, and endpoint security software may flag it.

## Measuring it

`mailbox stats [--since 14d]` counts the asks you sent and received over the window, who answered each (you, your daemon, or a deferral still waiting on you), the promises you made and kept, and how many of your daemon's graded answers were right, against a 70% bar. It counts mailbox traffic only; compare it with your own count of Slack DMs.

## Everyday commands

```sh
mailbox status                 # who you are, your fingerprint, and what is running
mailbox invite                 # copy the command a teammate runs to add you
mailbox peers                  # contacts and their fingerprints
mailbox sync                   # fetch new mail now
mailbox hook install|remove    # the inbox hook in ~/.claude/settings.json (the installer adds it)
mailbox help                   # every command
```

## Update

```sh
mailbox update
```

It pulls the latest version, reinstalls dependencies, refreshes the hook, and restarts the daemon if it was on. Then restart Claude Code so it loads the new MCP server. Once a day, the inbox hook checks GitHub and mentions in Claude Code when an update is available.

Versions mix safely: a newer sender may add signed fields that an older reader ignores, so teammates don't have to update on the same day. A change older readers must not ignore bumps the envelope version instead.

## Uninstall

```sh
mailbox uninstall
```

It stops the daemon, removes it from login, unregisters the MCP server, removes the inbox hook, and removes the `mailbox` command. Your identity, contacts, mail and audit log stay in `~/.agent-mailbox` and the Keychain; it prints the commands that delete those too.

## Layout

- `src/envelope.ts`: seal, verify and open envelopes. Canonical JSON, Ed25519 over a domain-separated header and ciphertext, libsodium sealed box, and a per-sender chain that tells duplicate, fork, replay, gap and chain mismatch apart.
- `src/relay.ts`: the relay as a pure core over an injected `Store`.
- `src/request-auth.ts`: signed reads, bound to method, host, path+query, a timestamp and a nonce.
- `src/roots.ts`: the founder list format and parser (`MAILBOX_ROOTS`).
- `src/blobs-store.ts`, `netlify/functions/relay.ts`: the Netlify shell around the core.
- `scripts/smoke.ts`: end-to-end check of a running relay.
- `src/client.ts`, `src/mcp-server.ts`, `src/hook.ts`, `src/cli.ts`, `src/cli-daemon.ts`, `src/claude-settings.ts`: the client, the Claude Code MCP server, the inbox hook, the `mailbox` command, and the edit that adds the hook to Claude Code's settings.
- `src/cert.ts`, `src/policy.ts`, `src/share.ts`, `src/responder.ts`, `src/daemon-core.ts`, `src/daemon.ts`, `src/audit.ts`: agent certs, the signed Cedar policy, the share-folder reader, the responder, the daemon's decisions and loop, and the audit log. `src/daemon-files.ts` holds the daemon's files: cert, signed policy, start point and lock.
- `install.sh`: the one-step installer, which `mailbox update` reruns.

## Checks

```sh
npm test              # unit tests (node:test, no build step; Node >= 22.18)
npm run typecheck     # tsc --noEmit, strict
```

Smoke-test a running relay with throwaway identities. Each run needs fresh keys, because it writes seq 0:

```sh
node scripts/smoke.ts keys <dir>          # writes keys.json (secret, 0600) and roots.json
MAILBOX_ROOTS="$(cat <dir>/roots.json)" netlify dev --offline   # or set it on the site
node scripts/smoke.ts run <dir> <relay-url>
```

The smoke run checks write-once, retry, fork, chain, inbox listing, byte-identical fetch, read authorization, and a 50-round concurrent-write race.

## Relay

The relay deploys as a Netlify site: one function plus Netlify Blobs. It needs `MAILBOX_RELAY_KEY` (its signing seed), `MAILBOX_ROOTS` (the founders, with `"admin": true` on admins) and optionally `MAILBOX_JOIN` (who may vouch new members in). Don't put the site behind login protection, because agents call it directly. Setup is in [Run a relay](docs/run-a-relay.md); every route, encoding and error code is in [the relay protocol](docs/relay-protocol.md).

Routes:

- `GET /.well-known/agent-mailbox?challenge=...`: the identity probe clients run before trusting a relay.
- `PUT /log/{pid}/{seq}`: body is the envelope, with `content-type: application/json`.
- `GET /log/{pid}/{seq}` and `GET /inbox/{pid}?after=pid:seq,...`: both need an `Authorization: AgentMailbox …` header built by `signRequest`.
- `POST /members`: a signed vouch, withdrawal, removal, host or unhost.

Behaviour that differs under `netlify dev`:

- A PUT with no content-type arrives with an empty body.
- Write-once under concurrency is enforced in production but not by the local Blobs sandbox.
- A 403 comes back as a 404.
