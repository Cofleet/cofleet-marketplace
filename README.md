# Cofleet plugins

This marketplace installs two independent Cofleet plugins for coding agents.
Install either one on its own — neither requires the other.

- **`cofleet`** — the `implement-spec` workflow and the Cofleet MCP
  connection: project context and code intelligence. Available for Claude
  Code and Codex.
- **`cofleet-presence`** — team-presence session reporting: after
  `cofleet login`, sends your prompt as a truncated session title, hostname,
  git branch, and repo-relative file paths to your team. Claude Code only.
  See [`plugins/cofleet-presence/README.md`](plugins/cofleet-presence/README.md)
  for the full disclosure of what is sent, what is never sent, and how
  `logout`, `status`, and reinstall behave.

## Install

Clone this public repository, then add that checkout as a marketplace:

```sh
claude plugin marketplace add "$PWD"
claude plugin install cofleet@cofleet
claude plugin install cofleet-presence@cofleet
```

For Codex (the `cofleet` plugin only):

```sh
codex plugin marketplace add "$PWD"
codex plugin add cofleet@cofleet
```

The customer plugins connect to `https://app.cofleet.dev`.

## Authorize and check reporting

`cofleet-presence` reports nothing until you authorize it. Inside Claude Code,
run:

```sh
cofleet login
cofleet status
cofleet doctor
```

`login` opens a browser so you can sign in. `status` shows the selected server
and credential state without contacting Cofleet. `doctor` sends an invalid
probe that writes no session; `reporting: OK (HTTP 400)` confirms the
credential and endpoint work.

## Upgrading from 0.3.0

Before this release, presence reporting lived inside the `cofleet` plugin —
`cofleet-presence` did not exist as its own plugin yet. Updating `cofleet` to
this release removes those hooks and its `bin/cofleet` binary, so there is no
`cofleet login` left inside `cofleet` to fall back to. If you used presence
reporting from `cofleet` at 0.3.0 or earlier, install `cofleet-presence@cofleet`
(see above), then run `cofleet login` once. See
[`plugins/cofleet-presence/README.md`](plugins/cofleet-presence/README.md) for
what `cofleet status` reports in the meantime and its full disclosure.

## Updates and support

This installation registered a local checkout, so plugin managers do not fetch
the repository for you. Fast-forward that checkout before asking either client
to refresh the marketplace or plugin:

```sh
git -C /path/to/cofleet-public-marketplace pull --ff-only
claude plugin marketplace update cofleet
claude plugin update cofleet@cofleet
claude plugin update cofleet-presence@cofleet
```

Use the same `git pull --ff-only` step before refreshing through Codex's plugin
manager.

For help, run `cofleet status` and `cofleet doctor`, then open an issue in this
repository with their non-secret output or visit [cofleet.dev](https://cofleet.dev).
