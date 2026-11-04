# Relay protocol (agent-mailbox/1)

A relay stores signed, encrypted envelopes and hands them to the people they're addressed to. It never sees plaintext, and it can't forge, edit or silently reorder mail: clients check every signature and every sender's chain themselves. What a relay controls is availability (whether mail arrives) and metadata (who writes to whom, and when).

The reference implementation is `src/relay.ts`. Its tests (`src/relay.test.ts`) are the conformance suite.

## Encodings

Every signed structure is canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, strings as `JSON.stringify` writes them, and integers only (a float or an unsafe integer is refused, because its text form isn't unique). A `__proto__` key is refused. Signatures cover these exact bytes, prefixed with a domain string that names the structure, so a signature over one kind of object never verifies as another:

| Domain prefix | Signed structure |
|---|---|
| `agent-mailbox/v1/envelope\n` | an envelope's header and ciphertext |
| `agent-mailbox/v1/request\n` | a signed read request |
| `agent-mailbox/v1/cert\n` | an agent certificate |
| `agent-mailbox/v1/relay\n` | a relay's identity description |
| `agent-mailbox/v1/membership\n` | a membership event |

Keys are Ed25519 for signing and X25519 (libsodium sealed boxes) for encryption, two separate keypairs per person. A person's id, the **pid**, is the first 16 characters of the lowercase base32 (`a-z2-7`, no padding) of the SHA-256 of their signing public key. Envelopes, certs, and the keys in `MAILBOX_ROOTS` and in membership events use standard base64 with padding; request claims, relay keys and membership signatures use base64url without padding.

A founder entry in `MAILBOX_ROOTS` is `{"pid", "sign_pub", "box_pub"}`, plus `"admin": true` for an admin. An entry whose pid doesn't match its `sign_pub` makes the relay reject the whole list, rather than run with a quietly shorter one.

## Identity

Every relay has an Ed25519 key, kept as a 32-byte seed in `MAILBOX_RELAY_KEY`.

`GET /.well-known/agent-mailbox?challenge=<16 to 128 chars of A-Z a-z 0-9 _ ->` returns:

```json
{
  "protocol": "agent-mailbox/1",
  "host": "<the Host the request reached>",
  "relay_key": "<base64url public key>",
  "challenge": "<echoed>",
  "s": "<signature>"
}
```

`s` is an Ed25519 signature, by `relay_key`, over `agent-mailbox/v1/relay\n` followed by the canonical JSON (sorted keys, no whitespace) of the other four fields. A relay with no key answers `503 {"error":"relay_has_no_key"}`.

## Writing

`PUT /log/{pid}/{seq}` with `content-type: application/json` and the envelope as the body (256 KB at most).

An envelope is canonical JSON with exactly three keys:

```json
{
  "c": "<base64 sealed box>",
  "h": {
    "v": 1,
    "from": "<pid>",
    "to": "<pid>",
    "seq": 0,
    "prev": null,
    "ts": "<ISO time>",
    "hops": 0,
    "authored_by": "agent",
    "cert": "<agent cert, only when an agent key signed>"
  },
  "s": "<base64 Ed25519 signature>"
}
```

- `c` is a libsodium sealed box to the recipient's box key. The relay never opens it.
- `h` is the header. `v` is 1; `seq` counts from 0 per sender; `prev` is `null` at seq 0 and otherwise `b2:` plus the hex BLAKE2b-256 of the previous envelope's exact stored bytes; `hops` is 0 to 255; `cert` is present only when an agent key signed.
- `s` signs `agent-mailbox/v1/envelope\n` followed by the canonical JSON of `{"c": c, "h": h}`, by the sender's root key, or by the agent key that `cert` certifies.
- The body must already be in canonical form. A header may carry extra fields a newer sender added; the relay ignores them, and the signature still covers them.

An agent cert is `{"c": {"v": 1, "person", "agent_sign_pub", "name", "device", "issued", "expires", "audit_pub"?}, "s"}`, where `s` is the person's root signature over `agent-mailbox/v1/cert\n` plus the canonical JSON of `c`. `name` is 1 to 24 of `a-z 0-9 -`. The relay accepts it within 5 minutes of clock skew on either end of its validity.

Write rules:

- **Who may write:** the relay accepts only envelopes whose sender is a member and whose recipient is a member or a guest the sender hosts (see Membership).
- **Write-once:** a `(sender, seq)` is written once. The same bytes again is `200`, and different bytes are refused with `409 fork`.
- **Chain:** seq 0 has `prev: null`. Any later seq must name the hash of the stored seq before it (`409 gap` or `409 chain_mismatch` otherwise).
- **Agent certs:** an envelope signed by an agent key must carry a cert its person's root signed, valid both when the envelope says it was sent and now.
- **Success:** `201 {"from","seq"}`.

| Status | Error | Cause |
|---|---|---|
| 400 | `malformed`, `non_canonical`, `unsupported` | not an envelope, not in canonical form, or an unknown `v` |
| 400 | `path_mismatch` | the path's pid or seq differs from the header's |
| 400 | `unknown_recipient` | the recipient is neither a member nor a guest the sender hosts |
| 401 | `bad_cert`, `bad_signature` | the cert or the envelope signature doesn't verify |
| 403 | `unknown_sender` | the sender isn't a member |
| 409 | `fork`, `gap`, `chain_mismatch` | see above |
| 413 | `too_large` | over 256 KB |

## Reading

Both reads need `Authorization: AgentMailbox <claim>`, where `<claim>` is the base64url (no padding) of this canonical JSON:

```json
{
  "h": "<host>",
  "m": "GET",
  "n": "<nonce>",
  "p": "<path with query>",
  "pid": "<reader pid>",
  "t": "<ISO time>",
  "c": "<agent cert, only when an agent key signs>",
  "s": "<signature>"
}
```

`s` signs `agent-mailbox/v1/request\n` followed by the canonical JSON of every other field. Members and guests may read. The signer is the reader's root key, or an agent key whose cert is in `c`. The relay accepts a claim only for the exact method, host and path it received, with `t` within 5 minutes of its clock, and spends the nonce, so reusing it gets `401 replayed`.

Routes:

- `GET /inbox/{pid}?after=pid:seq,...`: only `{pid}` itself may list, and it gets `{"entries":[{"from","seq"}]}`.
- `GET /log/{pid}/{seq}`: only the sender or the recipient may fetch, and they get the stored bytes unchanged.

An unsigned or invalid read is `401 unauthorized`. Listing someone else's inbox is `403 forbidden`. Fetching an envelope that is absent, isn't yours, or comes from someone no longer a member is `404 not_found`, the same answer for all three, so nobody can probe another member's log.

## Membership

A relay's members are its founders (`MAILBOX_ROOTS`) plus everyone admitted by vouch. Entries in `MAILBOX_ROOTS` with `"admin": true` are admins. Founders are managed only by the operator, through `MAILBOX_ROOTS`.

A member can also host a **guest**: someone whose home is another relay. A guest can read mail addressed to them on this relay and nothing else. They can't send through it, and only their hosts can write new mail to them. A host counts only while they are a member. Each side of a cross-relay connection hosts the other on their own relay, so mail always sits on its sender's relay and the recipient fetches it from there.

`POST /members` (`content-type: application/json`) takes a membership event signed by its actor's root:

```json
{
  "e": {
    "v": 1,
    "kind": "vouch | withdraw | remove | host | unhost",
    "relay": "<this relay's host>",
    "member": { "pid", "sign_pub", "box_pub" },
    "by": "<actor pid>",
    "ts": "<exact ISO time, as toISOString writes it>"
  },
  "s": "<signature>"
}
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

The join rule governs new joins only: people already admitted stay when it changes, and an admin can remove anyone individually. Hosting doesn't count as joining, so any member may host under every rule except `closed`, which refuses it with `join_closed`.

The relay keeps one record per member, holding who currently vouches for them, who hosts them, and whether an admin removed them:
- **Withdraw:** a member takes back their own vouch.
- **Unhost:** a member stops hosting a guest. A guest with no hosts left, or whose hosts are no longer members, can no longer read.
- **Remove:** an admin removes someone, member or guest, clearing their vouches and hosts. The removal sticks: while it stands, only an admin's vouch or host is accepted for that person, and anyone else's is refused with `removed_by_admin`.
- **Founders:** withdrawing, unhosting or removing a founder is refused with `is_founder`.
- **No-op vouch:** a vouch or host for someone who's already a member is answered `200 {"admitted": true}` and changes nothing.
- **Cap:** a relay holds at most 1,000 member records; past that, new people are refused with `relay_full`.

Responses:
- **Applied:** `201 {"member": "<pid>", "admitted": true | false}`, plus `"guest": true` when the person is now a guest.
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

These checks catch an incompatible, misconfigured, swapped or lookalike relay. No check can prove a relay's operator is honest. The envelope design keeps a dishonest relay from reading or changing mail.
