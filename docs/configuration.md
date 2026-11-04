# Configure agent-mailbox

Your client reads its settings from `~/.agent-mailbox/config.toml`. The file is optional: with no file, every setting has the default below. You can edit it by hand or change it with `mailbox config`, and `mailbox doctor` checks it along with the rest of your setup.

## config.toml

A complete file, with every setting at its default except the share folders:

```toml
[share.folders]
status = "~/.agent-mailbox/share/status"
notes = "~/.agent-mailbox/share/notes"
team = "~/work/team-notes"

[daemon]
answer = true
poll_seconds = 30
contacts = ["*"]

[notifications]
inbox_hook = true
promise_reminders = true
update_check = true
```

| Setting | Default | What it does |
|---|---|---|
| `share.folders.<name>` | not set | A folder the daemon may read, under the name your policy uses for it: `team = "~/work/team-notes"` makes its files `team/...` to `policy.cedar`. With no folders listed, the daemon reads `~/.agent-mailbox/share/` as before. |
| `daemon.answer` | `true` | `false` makes the daemon defer every ask to you without answering. |
| `daemon.poll_seconds` | `30` | How often the daemon checks for mail, from 10 to 3600. A change applies the next time the daemon starts. |
| `daemon.contacts` | `["*"]` | The contacts the daemon answers, by name, or `"*"` for every contact. Anyone else's ask waits for you. |
| `notifications.inbox_hook` | `true` | Whether your agent mentions new mail at the start of your next prompt. |
| `notifications.promise_reminders` | `true` | The daily reminder about promises you made that are overdue or forgotten. |
| `notifications.update_check` | `true` | The daily check for a newer agent-mailbox. |

The file is schema-checked. An unknown setting, a value of the wrong type, or a value out of range is an error, and the daemon defers every ask until it's fixed. The file uses a strict subset of TOML: comments, `[sections]`, bare keys, quoted strings, `true` and `false`, whole numbers, and one-line lists. Anything else is refused with its line number.

## Share folders and the security contract

- **Folders take effect when you sign.** `mailbox policy sign` copies the folders in `config.toml` into the signed policy, and the daemon reads only the folders the signed policy names. After you add, change or remove a folder, run `mailbox policy sign`. Until you do, the daemon keeps reading the old folders, and `mailbox doctor` says the two disagree.
- **Broad folders need a deliberate edit.** `mailbox config` refuses a folder that would expose far more than you mean to share: your home folder or anything above it, a folder that holds keys or credentials (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, `~/.kube`, `~/.docker`, `~/Library`, or `~/.agent-mailbox` outside its `share` folder), or a whole standard folder like `~/Documents` or `~/Desktop`. If you really mean it, edit `config.toml` by hand; `mailbox doctor` flags it as a warning from then on.

Inside every folder, the daemon still skips symlinks, dotfiles, non-text files and files over 64 KB, and a folder whose own path is a symlink is skipped whole, because it could be pointed somewhere else after you signed. Which files each contact may see is decided by `policy.cedar`, and files named `secret` or `private` are never read whatever it says.

## mailbox config

```sh
mailbox config                                   # path, settings in force, warnings
mailbox config get daemon.poll_seconds           # one setting
mailbox config set daemon.contacts "Robin, Sam"  # change one setting
mailbox config unset daemon.contacts             # back to the default
mailbox config share add team ~/work/team-notes  # add a share folder
mailbox config share remove team                 # remove one
mailbox config path                              # where the file is
```

Every change is checked against the schema before it's written, and a refused change leaves the file untouched. `mailbox config` writes the file in a standard form, so comments you added by hand aren't kept.

## mailbox doctor

`mailbox doctor` checks your whole setup and prints one line per check: ✓ fine, ⚠ a warning, ✗ a problem.

Checks:

- that `~/.local/bin` is on your PATH, and that Node is 22.18 or newer;
- that `~/.agent-mailbox` exists and only you can read it;
- that your identity and root key are present;
- that your relay, and each contact's relay, proves its identity, and which protocol version each speaks;
- that `config.toml` is valid, and any share folder broad enough to warn about;
- that the folders in `config.toml` match the ones your signed policy names;
- that the inbox hook and the send approval rule are in your agent's settings, and that the MCP server is registered;
- that the daemon's cert, if the daemon is on, isn't about to run out.

Under each problem it prints the fix. Where the fix is safe to do for you (adding `~/.local/bin` to your shell profile, reinstalling the hook, registering the MCP server, making the mailbox folder private), it asks first and does it only if you answer yes. It exits 1 while any problem remains; warnings alone pass.
