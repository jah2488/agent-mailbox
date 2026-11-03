# agent-mailbox

Signed, encrypted, asynchronous mail between coworkers' AI agents, modelled on Erlang mailboxes. Each person has a root key. Their agents send envelopes through an untrusted relay that only ever holds ciphertext from allowlisted keys. An optional daemon answers teammates' questions from a folder you choose, under a policy you sign, and records everything it does in a signed audit log.

Status: experiment. macOS and Claude Code only, Node 22.18 or newer.

## Install

One command. Use your name and the relay URL your team runs:

```sh
curl -fsSL https://raw.githubusercontent.com/jah2488/agent-mailbox/main/install.sh | bash -s -- --name "Your Name" --relay https://your-relay.example
```

It installs into `~/.local/share/agent-mailbox`, puts `mailbox` in `~/.local/bin`, registers the MCP server with Claude Code, creates your identity (the secret key goes to the Keychain), and certifies a separate key for your daemon. Restart Claude Code afterwards. Re-run the same command to update.

Then, once per teammate:

1. Send them the line `mailbox whoami` prints, and get theirs.
2. On a call, read each other your fingerprints.
3. Run `mailbox peer add '<their line>' --fingerprint "<what they read you>"`. A key whose fingerprint doesn't match is refused.

Whoever runs the relay adds everyone's key to its allowlist with `mailbox roots`.

In Claude Code your agent now has `mailbox_send`, `mailbox_receive`, `mailbox_peers` and `mailbox_thread`. To approve every send by hand, add `"ask": ["mcp__agent-mailbox__mailbox_send"]` to the `permissions` in `~/.claude/settings.json`.

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
mailbox review          # what the daemon deferred or flagged for you
mailbox audit verify    # check the audit log is intact and signed
mailbox daemon revoke   # tell every contact to refuse this daemon from now on
```

## Uninstall

```sh
mailbox uninstall
```

It stops the daemon, removes it from login, unregisters the MCP server, and removes the `mailbox` command. Your identity, contacts, mail and audit log stay in `~/.agent-mailbox` and the Keychain; it prints the commands that delete those too.

## Layout

- `src/envelope.ts`: seal, verify and open envelopes. Canonical JSON, Ed25519 over a domain-separated header and ciphertext, libsodium sealed box, and a per-sender chain that tells duplicate, fork, replay, gap and chain mismatch apart.
- `src/relay.ts`: the relay as a pure core over an injected `Store`.
- `src/request-auth.ts`: signed reads, bound to method, host, path+query, a timestamp and a nonce.
- `src/roots.ts`: the allowlist format and parser (`MAILBOX_ROOTS`).
- `src/blobs-store.ts`, `netlify/functions/relay.ts`: the Netlify shell around the core.
- `scripts/smoke.ts`: end-to-end check of a running relay.
- `src/client.ts`, `src/mcp-server.ts`, `src/hook.ts`, `src/cli.ts`: the client, the Claude Code MCP server, the inbox hook and the `mailbox` command.
- `src/cert.ts`, `src/policy.ts`, `src/share.ts`, `src/responder.ts`, `src/daemon-core.ts`, `src/daemon.ts`, `src/audit.ts`: agent certs, the signed Cedar policy, the share-folder reader, the responder, the daemon's decisions and loop, and the audit log.

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

The relay deploys as a Netlify site: one function plus Netlify Blobs. Set `MAILBOX_ROOTS` to the allowlist JSON and deploy. Don't put the site behind login protection, because agents call it directly. Each person's roster entry names their relay URL. What it accepts:

- `PUT /log/{pid}/{seq}`: body is the envelope, with `content-type: application/json`.
- `GET /log/{pid}/{seq}` and `GET /inbox/{pid}?after=pid:seq,...`: both need an `Authorization: AgentMailbox …` header built by `signRequest`.

Behaviour that differs under `netlify dev`:

- A PUT with no content-type arrives with an empty body.
- Write-once under concurrency is enforced in production but not by the local Blobs sandbox.
- A 403 comes back as a 404.
