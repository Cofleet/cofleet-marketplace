# Changelog

## 0.6.1 - 2026-08-17

- Removed cofleet-presence, now uses board activity instead of chat activity
- Added skills to interact with board to record local decisions; prompt, prototype, research, spec
- New skill to sync your design system with your Cofleet workspace

## 0.6.0 - 2026-08-11

- No change to the released workflows. This version carries preview-tier
  workflows only, which are not part of the published catalog.

## 0.5.0 - 2026-08-08

- `cofleet-presence` now works on Codex, not just Claude Code. Install it the
  same way, then run `$cofleet-presence` to sign in.
- Setup problems say what is wrong. Signing in could fail while printing
  nothing at all, leaving reporting off when everything looked fine.
- Your session title no longer flips back to the folder name partway through a
  long session.
- Running Cofleet in both Claude Code and Codex on one machine works. Sign in
  once in each.

## 0.4.0 - 2026-08-07

- Split the plugin in two. `cofleet` carries the Cofleet MCP connection and the
  `implement-spec` workflow; `cofleet-presence` carries team-presence session
  reporting. They install independently and neither requires the other.
- Installing `cofleet-presence` is the consent to report. Its README states what
  is sent, what is never sent, and that its hooks run in every Claude Code
  session on the machine. Nothing is reported until `cofleet login`.
- Added `cofleet logout`, which stops reporting without uninstalling. It removes
  local credentials and does not revoke the server-side grant.
- Reporting is recorded per install, so reinstalling stays silent until you run
  `cofleet login` again.
- `implement-spec` accepts a pinned Spec snapshot through `--spec-node` and
  `--snapshot`, alongside the existing board and Spec node lane.
- For Codex, only `cofleet` ships in this version.

## 0.3.0 - 2026-08-06

- Added a publication manifest naming exactly what the customer artifact
  contains. An asset absent from it is not published.
- Added a preview tier, so a workflow can be developed and used internally
  before it is released.
- Narrowed the released catalog to the `implement-spec` workflow.

## 0.2.0 - 2026-08-03

- Fixed private marketplace installs to development and public release exports
  to production, without a persisted per-install server redirect.
- Fixed session titles to use the current prompt contract. Presence reporting
  does not send tool responses or file contents.
- Added the `implement-spec` customer workflow.
- Added Codex packaging with the production Cofleet MCP descriptor alongside
  the Claude Code plugin.
- Added deterministic public export with version gates, secret and symlink
  checks, origin-isolated credentials, and stricter OAuth endpoint validation.
