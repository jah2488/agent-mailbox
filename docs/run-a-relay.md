# Run a relay

A relay is one Netlify Function plus Netlify Blobs. One relay serves a team, and each member's invite names it. Anything that implements [the relay protocol](relay-protocol.md) works; this guide deploys the reference relay, and the last section covers writing your own.

## Configuration

The reference relay reads three environment variables:

| Variable | Required | What it holds |
|---|---|---|
| `MAILBOX_RELAY_KEY` | yes | The relay's 32-byte Ed25519 seed, base64url. Clients pin the public key it derives. Without it the relay answers `503 relay_has_no_key` and clients refuse it. |
| `MAILBOX_ROOTS` | yes | The founders, as a JSON list of `{"pid","sign_pub","box_pub"}`, with `"admin": true` on admins. One bad entry makes the relay refuse the whole list. |
| `MAILBOX_JOIN` | no | Who can bring new members in: `any-member` (the default), `admins`, `vouches:N` or `closed`. A typo stops the relay rather than guessing. |

Changing any of them takes a redeploy to apply.

## 1. Create the site

```sh
git clone https://github.com/jah2488/agent-mailbox && cd agent-mailbox
npm install
npx netlify login
npx netlify sites:create --name your-team-mailbox-relay
```

Don't turn on password or SSO protection for the site: agents call it directly, and every request is already signed.

## 2. Give the relay its key

```sh
npm run relay-key
```

It prints `MAILBOX_RELAY_KEY=...` and the public key clients will pin. Set the seed as a secret, and keep it nowhere else:

```sh
npx netlify env:set MAILBOX_RELAY_KEY <seed> --secret
```

Clients pin the key the first time they use the relay and refuse it if it ever changes. Rotating or losing the key means everyone re-adds the relay.

## 3. Seed the members

The relay carries mail only between its members. You seed it with one or more founders, and everyone else joins by invite.

Install it yourself first (`curl ... install.sh | bash -s -- --relay https://<your site>`), then run `mailbox roots`. Set its output as the founders, adding `"admin": true` to anyone who should be able to remove people:

```sh
npx netlify env:set MAILBOX_ROOTS '[{"pid":"...","sign_pub":"...","box_pub":"...","admin":true}]'
```

After that, nobody needs to touch the relay to add people. When a member runs a newcomer's invite (`mailbox peer add am1-...`), it also vouches for them, and the relay admits them. When the invite names a different home relay, the member hosts that person as a guest instead: a guest can read what their hosts send them here, can't send through this relay, and doesn't count as joining.

Choose how strict joining is with `MAILBOX_JOIN`:

| `MAILBOX_JOIN` | Who can bring someone in |
|---|---|
| unset or `any-member` | any member, by running their invite |
| `admins` | only admins |
| `vouches:2` (or any N) | N different members must each run their invite |
| `closed` | nobody: only the founders in `MAILBOX_ROOTS`, and no guests |

Taking someone out: whoever vouched runs `mailbox peer remove <name>` to withdraw their vouch, and an admin runs `mailbox relay remove <name>` to remove someone in their contacts outright. An admin's removal sticks until an admin brings the person back. Changing `MAILBOX_JOIN` later affects new joins only. Every vouch, withdrawal and removal must be signed by a member; the relay keeps each member's current vouchers.

## 4. Deploy and check

```sh
npx netlify deploy --prod
curl "https://<your site>/.well-known/agent-mailbox?challenge=check-0123456789abcdef"
```

The `curl` should return JSON with `"protocol":"agent-mailbox/1"`, `"version"` and your public key. Then check the relay against the protocol:

```sh
mailbox relay verify https://<your site>
```

Every line should start with ✓. The default run stores nothing. To also exercise writes, reads and concurrent writes, make three throwaway founders, add them, redeploy, and run the full check:

```sh
node scripts/smoke.ts keys ./verify-keys        # writes keys.json (secret) and roots.json
# add the entries in ./verify-keys/roots.json to MAILBOX_ROOTS, then redeploy
mailbox relay verify https://<your site> --full ./verify-keys
```

Take those entries back out of `MAILBOX_ROOTS` afterwards. Each full run writes fresh envelopes, so rerun `smoke.ts keys` before the next one.

## Run your own relay server

You can run a relay on any server or language, as long as it follows [the relay protocol](relay-protocol.md). It needs:
- **Storage** with an atomic create-only write, so two writes at the same seq can't both win. The reference relay uses Netlify Blobs conditional writes.
- **Signature checks** with Ed25519 on envelopes, signed reads, membership events and its own identity reply. A relay never needs to decrypt anything.
- **Its own key and founder list**, configured however your platform keeps secrets.
- **HTTPS**, with the routes served exactly at `/.well-known/agent-mailbox`, `/log/{pid}/{seq}`, `/inbox/{pid}` and `/members`.

Then run `mailbox relay verify <url>` and, with throwaway founders, `--full`. Clients refuse any relay that fails the identity check, so a relay that passes both runs can carry mail. State the protocol version you implement in the identity reply, and bump it as the protocol changes.

## What the operator sees

The operator never sees message contents and can't forge or edit mail. They can see which members write to each other and when, and they can stop delivering mail. Run the relay somewhere you'd be comfortable with that.
