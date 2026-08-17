# Set up Cofleet in your coding agent

Cofleet gives your coding agent project context and shared workflows.

This procedure is safe to resume. Inspect what is already installed before
changing anything, and skip steps that are already complete. Only continue when
the person explicitly asked you to follow this document. Their request gives
you permission to install Cofleet and to begin browser sign-in, but it does not
bypass normal approval dialogs. Stop for the person at every approval, reload,
restart, or browser boundary.

Do not ask for credentials in chat, print stored token material, or silently
replace a marketplace. If the marketplace named `cofleet` already points at a
different source, report the conflict and ask the person which source to keep.

Use the section for the coding agent you are running in.

## Claude Code

1. Inspect the current state with:

   ```text
   claude plugin marketplace list
   claude plugin list
   ```

2. If inspection permits it, add the Cofleet marketplace and install the
   plugin:

   ```text
   claude plugin marketplace add Cofleet/cofleet-marketplace
   claude plugin install cofleet@cofleet
   ```

3. Ask the person to run `/reload-plugins` inside Claude Code. That is an
   in-client command, not a shell command. If reload is unavailable, ask them
   to restart Claude Code instead. Before stopping, give them this exact resume
   prompt to paste after the reload or restart, replacing the placeholder with
   the exact URL of this document:

   ```text
   Read <INSTALL.md URL>. Cofleet is installed, and the plugins have been reloaded or Claude Code has been restarted. Skip Claude Code steps 1–3 and continue from step 4.
   ```

4. Connecting to Cofleet opens a browser for sign-in the first time. Ask the
   person to complete it and wait for them. Do not retry the connection while
   they are signing in.

5. Apply the completion check below.

## Codex

1. Inspect the current state with:

   ```text
   codex plugin marketplace list
   codex plugin list
   ```

2. If inspection permits it, add the Cofleet marketplace and install the
   plugin:

   ```text
   codex plugin marketplace add Cofleet/cofleet-marketplace
   codex plugin add cofleet@cofleet
   ```

3. Ask the person to start a new Codex session, which is what picks up the
   Cofleet MCP server. Before stopping, give them this exact resume prompt to
   paste into that new session, replacing the placeholder with the exact URL of
   this document:

   ```text
   Read <INSTALL.md URL>. Cofleet is installed and this is the required new Codex session. Skip Codex steps 1–3 and continue from step 4.
   ```

4. Connecting to Cofleet opens a browser for sign-in the first time. Ask the
   person to complete it and wait for them. Do not retry the connection while
   they are signing in.

5. Apply the completion check below.

## Completion check

Installation exiting successfully is not enough. A plugin can be installed and
listed while the connection is not signed in, and browser sign-in exiting
successfully is not proof either.

Call the Cofleet tool `get_my_context`. It takes no arguments and it is the
only check that exercises the whole path at once: marketplace, plugin,
connection, and sign-in.

Report success only when that call returns both:

- a project name; and
- the person's own display name.

Show them those two values.

Anything else means setup is incomplete. Read the failure and give the person
exactly one next action:

- The tool is not available at all — the plugin is not installed, or the
  session has not picked it up. Return to step 3.
- The call fails with an authorization or sign-in error — the browser sign-in
  did not complete. Return to step 4.

Stop at any required boundary rather than retrying past it.
