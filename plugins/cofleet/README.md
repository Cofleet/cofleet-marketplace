# Cofleet plugin

The Cofleet plugin adds the `implement-spec` workflow and the Cofleet MCP
connection to your coding agent: project context and code intelligence.

Team-presence reporting is a separate, independently installed plugin: see
[`cofleet-presence`](../cofleet-presence/README.md).

## Install from the public marketplace

Clone Cofleet's public, release-only plugin marketplace, then add that checkout
as the marketplace source. The product repository is not a plugin marketplace.

```sh
cd /path/to/cofleet-public-marketplace
claude plugin marketplace add "$PWD"
claude plugin install cofleet@cofleet
```

The customer plugin connects to `https://app.cofleet.dev`. Restart Claude Code
or run `/reload-plugins` to pick it up.

To also install team-presence reporting, add `cofleet-presence` from the same
marketplace — see its README for the install command and its full data-sent
disclosure.

## Upgrading from 0.3.0

Before this release, presence reporting lived inside this plugin —
`cofleet-presence` did not exist as its own plugin yet. Updating `cofleet` to
this release removes those hooks and its `bin/cofleet` binary, so there is no
`cofleet login` left inside `cofleet` to fall back to. If you used presence
reporting from `cofleet` at 0.3.0 or earlier, install `cofleet-presence@cofleet`
(see above), then run `cofleet login` once. See
[`cofleet-presence`](../cofleet-presence/README.md) for what `cofleet status`
reports in the meantime and its full disclosure.

## Updates

Update the marketplace and plugin, then restart Claude Code or run
`/reload-plugins`:

```sh
git -C /path/to/cofleet-public-marketplace pull --ff-only
claude plugin marketplace update cofleet
claude plugin update cofleet@cofleet
```

To remove the plugin:

```sh
claude plugin uninstall cofleet@cofleet
```

For help, open an issue in this repository or visit
[cofleet.dev](https://cofleet.dev).
