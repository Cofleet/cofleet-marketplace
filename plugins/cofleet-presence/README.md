# Cofleet Presence plugin

Cofleet Presence reports team-presence session activity to Cofleet so your
team can see what everyone is working on. It installs and runs independently
of the `cofleet` plugin.

## Install from the public marketplace

Add the marketplace and install the plugin:

```sh
claude plugin marketplace add Cofleet/cofleet-marketplace
claude plugin install cofleet-presence@cofleet
```

Restart Claude Code or run `/reload-plugins`, then use Claude Code's Bash tool
to authorize and check the installation:

```sh
cofleet login
cofleet status
cofleet doctor
```

`login` opens a browser for Cofleet sign-in. `status` shows the selected
server and credential state without contacting Cofleet. `doctor` sends a
deliberately invalid probe that creates no session; `reporting: OK (HTTP 400)`
confirms the credential and reporting endpoint work.

**On a genuinely fresh install** — no Claude Code session has run even once
with this plugin installed, so no hook has ever fired — a `cofleet login` run
from a plain terminal still saves the credential, but prints "Reporting
consent is recorded per install, and this shell has no CLAUDE_PLUGIN_DATA and
no install to record it against yet." and exits non-zero. Start a Claude Code
session (which runs the hooks), then run `cofleet login` again to record
consent. In the ordinary case above — restarting Claude Code before logging
in — the `SessionStart` hook has already run by the time you type the
command, so one `login` is enough.

## Reporting consent

Installing this plugin adds three hooks to Claude Code. They run in every Claude Code session on the machine, personal repositories included, regardless of the repository or plugin marketplace a session started from.

**What is sent.** Only:

| Hook | Data sent |
| --- | --- |
| `SessionStart` | Directory name as the initial title, hostname, and Git branch |
| `UserPromptSubmit` | Latest prompt, normalized and truncated to 200 characters, as the session title |
| `PostToolUse` | Repository-relative path of an edited or read file, for area grouping |

Your prompts leave your machine. The latest prompt becomes the session title,
shown according to your Cofleet workspace's session-visibility setting.
Titles and areas remain visible; machine and worktree can be hidden by that
setting.

**What is never sent.** The reporter does not send `tool_response`, command
text (or command output), or file contents — only the hostname, branch, and
repository-relative path described above. It does not forward the rest of a
hook payload. Paths outside the session working directory are discarded.

**Nothing is reported until `cofleet login`.** The hooks are installed and run
from the moment the plugin is installed, but every post first checks for a
credential; with none, the hook exits silently and sends nothing. Reporting
starts only after you run `cofleet login` in some session on the machine.

## logout

```sh
cofleet logout
```

`logout` deletes the credentials and consent marker stored locally for the
selected server. It is local-only: it does not revoke the server-side OAuth
grant (RFC 7009 revocation is a follow-up). To fully revoke access, remove the
authorization from your Cofleet account as well.

## status's four states

`cofleet status` reports one of four reporting states:

- `not logged in` — no credential stored for this server.
- `logged in but not consented this install` — a credential exists, but this
  install has not run `cofleet login` since it started (see reinstall below).
  Run `cofleet login` to resume.
- `logged in — cannot verify consent from this shell` — a credential exists,
  but this shell has neither `CLAUDE_PLUGIN_DATA` nor a witness of it yet, so
  status cannot tell whether this install has consented. This is not the same
  as "not consented" — it means unknown, not no. Start a Claude Code session
  here, then run `cofleet login` again.
- `reporting` — a credential exists and this install has consented; hooks post.

`cofleet doctor` reports the same distinction as a line in its output:
`reporting: UNKNOWN — cannot verify consent from this shell (no
CLAUDE_PLUGIN_DATA yet).`, separate from the `FAIL` it reports when consent is
actually missing.

## Headless or CI login

`cofleet login <token>` (an operator-minted `vk_` token) is the escape hatch
for a server or CI box that has no browser and will never run a Claude Code
session — there is no install here for the per-install consent marker above
to ever attach to. It saves the token, then prints:

```
Reporting consent is recorded per install, and this shell has no
CLAUDE_PLUGIN_DATA and no install to record it against yet — normal on
a headless box, where no Claude Code session will ever run here to
establish one.
The token still saved. To report from this shell anyway, export:
  export COFLEET_TOKEN='<token>'
  export COFLEET_TOKEN_ORIGIN='<server>'
The hook gate exempts $COFLEET_TOKEN — no per-install consent needed.
```

Export both variables as shown and reporting resumes from that shell:
`$COFLEET_TOKEN` is exempt from the marker gate entirely, since it is an
operator-supplied process override, not an interactive login tied to any
particular install.

## Reinstall behavior

Uninstalling this plugin deletes its local data directory, including the
install-generation marker written by `login`. A reinstall requires a fresh login
before reporting resumes — by design: hooks stay silent until you run
`cofleet login` again in the reinstalled plugin. Any long-lived credential
stored outside the plugin data directory can outlive an uninstall; `status`
reports the `logged in but not consented this install` state in that case
instead of resuming reporting silently.

## Stop reporting

```sh
cofleet logout
```

or uninstall the plugin entirely:

```sh
claude plugin uninstall cofleet-presence@cofleet
```

## Updates

Update the marketplace and plugin directly, then restart Claude Code or run
`/reload-plugins`:

```sh
claude plugin marketplace update cofleet
claude plugin update cofleet-presence@cofleet
```

For help, run `cofleet status` and `cofleet doctor` and share only their
non-secret output with Cofleet support.
