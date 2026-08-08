---
name: cofleet-presence
description: Run Cofleet Presence's login, status, doctor, and logout commands by resolving the plugin's bin/cofleet binary as an absolute path instead of assuming it is on PATH — required on Codex, which does not put a plugin's bin/ on the agent shell's PATH. Use for $cofleet-presence, or whenever the user asks about Cofleet session-reporting status, wants diagnostics, or explicitly asks to log in, log out, or turn reporting on or off.
---

# Cofleet Presence CLI

Cofleet Presence reports team-presence session activity to Cofleet. Its CLI
is never on this shell's PATH — do not run a bare `cofleet`, and do not
assume one resolves.

## Resolve the binary first, every time

1. Determine this SKILL.md file's own directory.
2. The binary is at `../../bin/cofleet`, relative to that directory. Resolve
   this to an absolute path and invoke that absolute path. Never invoke a
   bare `cofleet`, and never reference the hook-only plugin-root environment
   variable from here — it is documented only for hook subprocesses, not for
   an agent shell or a skill file.

This resolution works the same way whether the agent is Codex or Claude
Code — Claude Code does put the binary on PATH, but the resolved absolute
path still works there too — so use it unconditionally and do not branch on
which harness is running.

## The four commands

Run `<resolved-path> <subcommand>`:

- **`status`** — shows the selected server and credential state without
  contacting Cofleet. Reads local files only; makes no network call and
  writes nothing. Run it under the default sandbox — do not request any
  elevated permission for it.
- **`doctor`** — sends a deliberately invalid probe that creates no session;
  `reporting: OK (HTTP 400)` confirms the credential and reporting endpoint
  work. Needs outbound HTTPS to the Cofleet server.
- **`login`** — opens a browser for Cofleet sign-in. **Never run this on
  your own initiative.** Reporting consent is the sensitive core of this
  plugin, so only run `login` when the user explicitly asks to log in,
  authorize, or turn session reporting on. A `status` or `doctor` result
  that shows reporting is off is not, by itself, a reason to run `login` —
  surface the result and let the user decide. Needs outbound HTTPS (OAuth
  discovery, registration, and token exchange), a loopback HTTP listener for
  the OAuth callback, and filesystem writes under `~/.cofleet` and the
  plugin data directory (both outside the workspace) — the static-token
  form (`login <token>`) skips the browser/loopback part but still needs
  those same filesystem writes.
- **`logout`** — deletes the credentials and consent marker stored locally
  for the selected server. It is local-only: it does not revoke the
  server-side OAuth grant (RFC 7009 revocation is a follow-up). To fully
  revoke access, the user must also remove the authorization from their
  Cofleet account. Needs filesystem deletes under `~/.cofleet` and the
  plugin data directory, both outside the workspace.

## Request sandbox permission before running, not after a bare failure

Codex sandboxes shell commands by default, and `login`, `doctor`, and
`logout` each need something that default sandbox denies. Request it
proactively on the `shell_command` call that invokes the command — do not
invoke it plainly and hope, and do not treat a bare non-zero exit with no
output as "it just doesn't work": that shape is what a sandbox-denied
network or filesystem call looks like from `login`/`doctor`/`logout`
specifically because their own failure handling could not explain the denial
either. (`status` never needs this — it has no network or filesystem-write
step to deny.)

Set `sandbox_permissions: "require_escalated"` on the call, with a
`justification` naming the exact command and the exact permission it needs:

- `login` — `"cofleet login needs network access to sign in to Cofleet and
  to save the credential under ~/.cofleet, outside the workspace."`
- `doctor` — `"cofleet doctor needs network access to check whether session
  reporting can reach Cofleet."`
- `logout` — `"cofleet logout needs to delete stored credentials under
  ~/.cofleet, outside the workspace."`

If the command still exits non-zero after that, read its stderr — it now
names what actually went wrong (network unreachable, a permission still
refused, or a real Cofleet-side error) instead of a bare exit code.

## Codex: hooks must be trusted before login can record consent

On Codex, `SessionStart` is the hook that writes the plugin-data witness
`login` needs to record consent for this install. If the user has never
trusted this plugin's hooks (via `/hooks`), `SessionStart` has never run, and
`login` will report it has no install to record consent against yet. Tell
the user to trust the plugin's hooks with `/hooks` and start a new session,
then retry `login`.
