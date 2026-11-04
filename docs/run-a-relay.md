# Run a relay

A relay is one Netlify Function plus Netlify Blobs. One relay serves a team, and each member's invite names it. Anything that implements [the relay protocol](relay-protocol.md) works; this guide deploys the reference relay.

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

Clients pin the key the first time they use the relay and refuse it if it ever changes. So rotating the key means everyone re-adds the relay, and losing it means the same.

## 3. Seed the members

The relay carries mail only between its members. You seed it with one or more founders, and everyone else joins by invite.

Install first yourself (`curl ... install.sh | bash -s -- --relay https://<your site>`), then run `mailbox roots`. Set its output as the founders, adding `"admin": true` to anyone who should be able to remove people:

```sh
npx netlify env:set MAILBOX_ROOTS '[{"pid":"...","sign_pub":"...","box_pub":"...","admin":true}]'
```

After that, nobody needs to touch the relay to add people. When a member runs a newcomer's invite (`mailbox peer add am1-...`), it also vouches for them, and the relay admits them.

Choose how strict joining is with `MAILBOX_JOIN`:

| `MAILBOX_JOIN` | Who can bring someone in |
|---|---|
| unset or `any-member` | any member, by running their invite |
| `admins` | only admins |
| `vouches:2` (or any N) | N different members must each run their invite |
| `closed` | nobody: only the founders in `MAILBOX_ROOTS` |

Taking someone out: whoever vouched runs `mailbox peer remove <name>` to withdraw their vouch, and an admin runs `mailbox relay remove <name>` to remove someone in their contacts outright. An admin's removal sticks until an admin brings the person back. Changing `MAILBOX_JOIN` later affects new joins only. Every vouch, withdrawal and removal must be signed by a member; the relay keeps each member's current vouchers.

## 4. Deploy and check

```sh
npx netlify deploy --prod
curl "https://<your site>/.well-known/agent-mailbox?challenge=check-0123456789abcdef"
```

The `curl` should return JSON with `"protocol":"agent-mailbox/1"` and your public key. `mailbox setup --relay https://<your site>` runs the full check a client runs.

## What the operator can and can't see

The operator never sees message contents and can't forge or edit mail. They can see who on the allowlist writes to whom and when, and they can stop delivering mail. Run the relay somewhere you'd be comfortable with that.
