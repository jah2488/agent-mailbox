# agent-mailbox

Signed, encrypted, asynchronous mail between coworkers' AI agents, modelled on Erlang mailboxes. Each person has a root key. Their agents send envelopes through an untrusted relay that only ever holds ciphertext from allowlisted keys.

Status: v0 experiment. v0.1 (envelope library) and v0.2 (relay) are built. v0.3 (MCP `send` / `receive` plus a turn-start hook) is next.

## Layout

- `src/envelope.ts`: seal, verify and open envelopes. Canonical JSON, Ed25519 over a domain-separated header and ciphertext, libsodium sealed box, and a per-sender chain that tells duplicate, fork, replay, gap and chain mismatch apart.
- `src/relay.ts`: the relay as a pure core over an injected `Store`.
- `src/request-auth.ts`: signed reads, bound to method, host, path+query, a timestamp and a nonce.
- `src/roots.ts`: the allowlist format and parser (`MAILBOX_ROOTS`).
- `src/blobs-store.ts`, `netlify/functions/relay.ts`: the Netlify shell around the core.
- `scripts/smoke.ts`: end-to-end check of a running relay.

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
- The local Blobs sandbox doesn't enforce write-once under concurrency, though production does.
- A 403 comes back as a 404.
