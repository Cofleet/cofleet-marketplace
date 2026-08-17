# Cofleet plugin

The Cofleet plugin adds the `cofleet-design-sync` and `cofleet-implement-spec`
workflows and the Cofleet MCP connection to your coding agent: project context
and code intelligence.

## Install from the public marketplace

Add Cofleet's public, release-only plugin marketplace and install the plugin:

```sh
claude plugin marketplace add Cofleet/cofleet-marketplace
claude plugin install cofleet@cofleet
```

The customer plugin connects to `https://app.cofleet.dev`. Restart Claude Code
or run `/reload-plugins` to pick it up.

## Updates

Update the marketplace and plugin directly, then restart Claude Code or run
`/reload-plugins`:

```sh
claude plugin marketplace update cofleet
claude plugin update cofleet@cofleet
```

To remove the plugin:

```sh
claude plugin uninstall cofleet@cofleet
```

For help, open an issue in this repository or visit
[cofleet.dev](https://cofleet.dev).
