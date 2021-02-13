# Cofleet plugins

This marketplace publishes two independent Cofleet plugins for coding agents.
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

Most people only need `cofleet` — it gives your agent project context and the
`implement-spec` workflow. Add `cofleet-presence` only if your team uses the
shared session view.

## Install

Add the marketplace, then install the plugins you want:

```sh
claude plugin marketplace add Cofleet/cofleet-marketplace
claude plugin install cofleet@cofleet
claude plugin install cofleet-presence@cofleet
```

For Codex (the `cofleet` plugin only — `cofleet-presence` has no hook surface
in that format):

```sh
codex plugin marketplace add Cofleet/cofleet-marketplace
codex plugin add cofleet@cofleet
```

The customer plugins connect to `https://app.cofleet.dev`.

## After installing

Restart Claude Code, or run `/reload-plugins`, to pick up the new plugin.

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

## Updating

```sh
claude plugin marketplace update cofleet
claude plugin update cofleet@cofleet
claude plugin update cofleet-presence@cofleet
```

The marketplace and plugins update straight from the repository.

## Uninstalling

```sh
claude plugin uninstall cofleet@cofleet
claude plugin uninstall cofleet-presence@cofleet
```

Uninstalling `cofleet-presence` stops reporting. Short of that,
`cofleet logout` also stops reporting without uninstalling the plugin — see
[`plugins/cofleet-presence/README.md`](plugins/cofleet-presence/README.md).

For help, run `cofleet status` and `cofleet doctor`, then open an issue in this
repository with their non-secret output or visit [cofleet.dev](https://cofleet.dev).
