# Cofleet plugins

This marketplace publishes two independent Cofleet plugins for coding agents.
Install either one on its own — neither requires the other.

- **`cofleet`** — the `implement-spec` workflow and the Cofleet MCP
  connection: project context and code intelligence. Available for Claude
  Code and Codex.
- **`cofleet-presence`** — puts your coding sessions on the team view in
  Cofleet: the branch you started on, plus the task you're on and the files
  you're in, updated as you work. Turn it on with `cofleet login` and off with
  `cofleet logout`.
  [`plugins/cofleet-presence/README.md`](plugins/cofleet-presence/README.md)
  lists exactly what is sent and what never leaves your machine.

Start with `cofleet`. Add `cofleet-presence` if your team wants to see what
everyone is working on.

## Install

Add the marketplace, then install the plugins you want:

```sh
claude plugin marketplace add Cofleet/cofleet-marketplace
claude plugin install cofleet@cofleet
claude plugin install cofleet-presence@cofleet
```

For Codex (`cofleet` only — a Codex build of `cofleet-presence` is coming):

```sh
codex plugin marketplace add Cofleet/cofleet-marketplace
codex plugin add cofleet@cofleet
```

The customer plugins connect to `https://app.cofleet.dev`.

## After installing

Restart your agent, or run `/reload-plugins` in Claude Code, to pick up the new
plugin.

`cofleet-presence` reports nothing until you authorize it. From an agent
session, run:

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

For Codex:

```sh
codex plugin marketplace upgrade cofleet
codex plugin add cofleet@cofleet
```

The marketplace and plugins update straight from the repository.

## Uninstalling

```sh
claude plugin uninstall cofleet@cofleet
claude plugin uninstall cofleet-presence@cofleet
```

For Codex:

```sh
codex plugin remove cofleet@cofleet
```

Uninstalling `cofleet-presence` stops reporting. Short of that,
`cofleet logout` also stops reporting without uninstalling the plugin — see
[`plugins/cofleet-presence/README.md`](plugins/cofleet-presence/README.md).

For help, run `cofleet status` and `cofleet doctor`, then open an issue in this
repository with their non-secret output or visit [cofleet.dev](https://cofleet.dev).
