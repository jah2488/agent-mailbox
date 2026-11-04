# Relay protocol (agent-mailbox/1)

A relay stores signed, encrypted envelopes and hands them to the people they're addressed to. It never sees plaintext, and it can't forge, edit or silently reorder mail: clients check every signature and every sender's chain themselves. What a relay controls is availability (whether mail arrives) and metadata (who writes to whom, and when).

The reference implementation is `src/relay.ts`. Its tests (`src/relay.test.ts`) are the conformance suite.

## Identity

Every relay has an Ed25519 key, kept as a 32-byte seed in `MAILBOX_RELAY_KEY`.

`GET /.well-known/agent-mailbox?challenge=<16 to 128 chars of A-Z a-z 0-9 _ ->` returns:

```json
{ "protocol": "agent-mailbox/1", "host": "<the Host the request reached>", "relay_key": "<base64url public key>", "challenge": "<echoed>", "s": "<signature>" }
```

`s` is an Ed25519 signature, by `relay_key`, over `agent-mailbox/v1/relay\n` followed by the canonical JSON (sorted keys, no whitespace) of the other four fields. A relay with no key answers `503 {"error":"relay_has_no_key"}`.

## Writing

`PUT /log/{pid}/{seq}` with `content-type: application/json` and the envelope as the body (256 KB at most).

- **Who may write:** the relay accepts only envelopes whose sender and recipient are both members (see Membership).
- **Write-once:** a `(sender, seq)` is written once. The same bytes again is `200`, and different bytes are refused with `409 fork`.
- **Chain:** seq 0 has `prev: null`. Any later seq must name the hash of the stored seq before it (`409 gap` or `409 chain_mismatch` otherwise).
- **Agent certs:** an envelope signed by an agent key must carry a cert its person's root signed, valid both when the envelope says it was sent and now.
- **Success:** `201 {"from","seq"}`.

## Reading

Both reads need `Authorization: AgentMailbox <base64url claim>`, a signature by the reader's root key (or a certified agent key) over the method, host, path with query, a timestamp within 5 minutes, and a one-time nonce. See `src/request-auth.ts`.

- `GET /inbox/{pid}?after=pid:seq,...`: only `{pid}` itself may list, and it gets `{"entries":[{"from","seq"}]}`.
- `GET /log/{pid}/{seq}`: only the sender or the recipient may fetch, and they get the stored bytes unchanged.

An unsigned read is `401`.

## Membership

A relay's members are its founders (`MAILBOX_ROOTS`) plus everyone admitted by vouch. Entries in `MAILBOX_ROOTS` with `"admin": true` are admins. Founders are managed only by the operator, through `MAILBOX_ROOTS`.

`POST /members` (`content-type: application/json`) takes a membership event signed by its actor's root:

```json
{ "e": { "v": 1, "kind": "vouch | withdraw | remove", "relay": "<this relay's host>", "member": { "pid", "sign_pub", "box_pub" }, "by": "<actor pid>", "ts": "<exact ISO time, as toISOString writes it>" }, "s": "<signature>" }
```

`s` signs `agent-mailbox/v1/membership\n` followed by the canonical JSON of `e`. The relay refuses an event unless:
- the actor is a current member and the signature verifies against their key;
- `relay` is this relay's host;
- `ts` is an exact ISO time within 5 minutes of the relay's clock.

`MAILBOX_JOIN` sets who may vouch:

| `MAILBOX_JOIN` | Who may vouch | Admitted after |
|---|---|---|
| `any-member` (default) | any member | one vouch |
| `admins` | admins only | one admin vouch |
| `vouches:N` | any member | N different members |
| `closed` | nobody | only founders are members |

The join rule governs new joins only: people already admitted stay when it changes, and an admin can remove anyone individually.

The relay keeps one record per member, holding who currently vouches for them and whether an admin removed them:
- **Withdraw:** a member takes back their own vouch.
- **Remove:** an admin removes someone. The removal sticks: while it stands, only an admin's vouch is accepted for that person, and anyone else's is refused with `removed_by_admin`.
- **Founders:** withdrawing or removing a founder is refused with `is_founder`.
- **No-op vouch:** a vouch for someone who's already a member is answered `200 {"admitted": true}` and changes nothing.
- **Cap:** a relay holds at most 1,000 member records; past that, new people are refused with `relay_full`.

Responses:
- **Applied:** `201 {"member": "<pid>", "admitted": true | false}`.
- **Refused:**
  - `403`: `not_a_member`, `admins_only`, `join_closed` or `removed_by_admin`;
  - `401`: `bad_signature`;
  - `400`: `wrong_relay`, `stale`, `malformed`, `bad_member` or `is_founder`;
  - `409`: `relay_full`.

## Errors on every route

`405 method_not_allowed` for a method a route doesn't take, and `415 content_type_must_be_application_json` for a PUT or POST without that content type.

## What clients enforce

`mailbox setup` and `mailbox peer add` check a relay before using it, and sync and send check again at most once a day.

Refused when the relay:

- doesn't answer the identity request with a valid description for its own host and the client's fresh challenge;
- speaks a protocol other than `agent-mailbox/1`;
- serves an inbox read that carries no signature;
- answers with a different key than the one the client pinned the first time it used that relay, or than the key an invite named for it.

These checks catch an incompatible, misconfigured, swapped or lookalike relay. No check can prove a relay's operator is honest; the envelope design is what keeps a dishonest relay from reading or changing mail.
