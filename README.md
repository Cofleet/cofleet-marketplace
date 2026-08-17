# Cofleet plugins

This marketplace publishes the Cofleet plugin for coding agents.

- **`cofleet`** — the `cofleet-implement-spec` workflow and the Cofleet MCP
  connection: project context and code intelligence. Available for Claude
  Code and Codex.

## Install

Add the marketplace, then install the plugin:

```sh
claude plugin marketplace add Cofleet/cofleet-marketplace
claude plugin install cofleet@cofleet
```

For Codex:

```sh
codex plugin marketplace add Cofleet/cofleet-marketplace
codex plugin add cofleet@cofleet
```

The customer plugin connects to `https://app.cofleet.dev`.

## After installing

Restart your agent, or run `/reload-plugins` in Claude Code, to pick up the new
plugin.

There is nothing to sign in to by hand. The plugin declares an HTTP MCP server,
so your agent runs the sign-in itself the first time it connects and stores the
result in its own credential store. In Claude Code, `/mcp` lists the connection
and the tools it can reach.

## Updating

```sh
claude plugin marketplace update cofleet
claude plugin update cofleet@cofleet
```

For Codex:

```sh
codex plugin marketplace upgrade cofleet
codex plugin add cofleet@cofleet
```

The marketplace and plugin update straight from the repository.

## Uninstalling

```sh
claude plugin uninstall cofleet@cofleet
```

For Codex:

```sh
codex plugin remove cofleet@cofleet
```

## If you used `cofleet-presence`

`cofleet-presence` has been retired and is no longer published. Session
reporting has stopped, and nothing about your local sessions is sent any more.

An installed copy does nothing and can be removed with `claude plugin uninstall
cofleet-presence@cofleet` or `codex plugin remove cofleet-presence@cofleet`.
Its credentials were stored outside the plugin, in `~/.cofleet`, so they
outlive the uninstall — delete that directory to clear them.

For help, open an issue in this repository or visit
[cofleet.dev](https://cofleet.dev).
