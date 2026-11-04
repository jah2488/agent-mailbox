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

## 3. Allow your members

The relay accepts mail only between people on its allowlist. After everyone has installed (`curl ... install.sh | bash -s -- --relay https://<your site>`) and added each other, any member runs:

```sh
mailbox roots
```

Set its output as the allowlist:

```sh
npx netlify env:set MAILBOX_ROOTS '<that JSON>'
```

Re-run both steps, then redeploy, whenever someone joins.

## 4. Deploy and check

```sh
npx netlify deploy --prod
curl "https://<your site>/.well-known/agent-mailbox?challenge=check-0123456789abcdef"
```

The `curl` should return JSON with `"protocol":"agent-mailbox/1"` and your public key. `mailbox setup --relay https://<your site>` runs the full check a client runs.

## What the operator can and can't see

The operator never sees message contents and can't forge or edit mail. They can see who on the allowlist writes to whom and when, and they can stop delivering mail. Run the relay somewhere you'd be comfortable with that.
