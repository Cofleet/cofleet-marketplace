#!/usr/bin/env node
// Cofleet work-session reporter.
//
// THE CONTRACT, in order of importance:
//
//   1. This process can never disrupt a session. `UserPromptSubmit` is a
//      blocking hook whose exit code 2 blocks the prompt AND ERASES IT, so
//      every path here ends in exit 0 with nothing on stderr. There is no error
//      this program is allowed to report; failing to record presence is always
//      preferable to interfering with someone's work.
//   2. It never forwards its stdin. The `PostToolUse` payload carries
//      `tool_response` — file contents and command output — and `tool_input`
//      carries whole commands. Only a file path is ever read out —
//      `tool_input.file_path` directly, or (Codex's `apply_patch`, which
//      carries no `file_path`) the path named on the patch envelope's own
//      `*** Add/Delete/Update File:`/`*** Move to:` header line, see
//      `applyPatchFilePaths`. The rest is dropped on the floor and never
//      leaves the machine; a Bash `tool_input.command` is never parsed.
//   3. It coalesces. A post per tool call would be a request every few seconds
//      per developer; instead paths accumulate locally and flush at most once a
//      minute, plus immediately on the two events that change the title.
//
// Subcommands: `hook` (from hooks.json), `login`, `logout`, `status`, `doctor`.
//
// THE INSTALL-GENERATION MARKER:
//
//   Credentials in ~/.cofleet outlive an uninstall — that is the ecosystem
//   norm (Codex keeps ~/.codex; Claude Code keeps its own MCP OAuth grants).
//   A surviving credential is inert on its own, but it would re-arm PASSIVE
//   reporting the instant hooks reappeared on a reinstall, with no consent
//   given for the new install. There is no uninstall hook to clean up after.
//   What the platform DOES guarantee: CLAUDE_PLUGIN_DATA is wiped on
//   uninstall (user-prompted). So a marker file written there on successful
//   `login`, and required alongside the credential before a hook ever posts,
//   makes that wipe the install-generation signal: reinstall finds the
//   credential but not the marker, and stays silent until a fresh `login`.
//
//   CLAUDE_PLUGIN_DATA is only guaranteed present for plugin-executed hooks —
//   a terminal running `cofleet login` may not have it. There used to be a
//   *pending* marker written to the stable root for that case, promoted by
//   the first hook run; it made every non-hook reader (status/doctor/logout,
//   which never see CLAUDE_PLUGIN_DATA) blind to consent the instant it was
//   promoted, since promotion deletes the file they knew how to find. It also
//   let a stale pending file from a pre-uninstall terminal login survive the
//   wipe and get promoted after reinstall, re-arming reporting with no fresh
//   consent — the opposite of the guarantee above.
//
//   The fix: a *witness*. Every hook run (which always has CLAUDE_PLUGIN_DATA)
//   records that install's plugin-data origin directory into its own small
//   file under the stable root — `~/.cofleet/origins/<key>/witnesses/<hash of
//   the plugin-data dir>` — one entry per install, not one file per origin.
//   That plurality matters the moment this plugin is installed in more than
//   one harness on the same machine (Claude Code and Codex, say): each has
//   its own CLAUDE_PLUGIN_DATA root, so a single shared witness file could
//   only ever remember whichever install's hook happened to run last,
//   silently losing track of every other one — the exact bug this scheme
//   replaces. A build before this fix wrote one unkeyed file at
//   `~/.cofleet/origins/<key>/plugin-data-dir`; still read (never written
//   again) so an install that already logged in keeps working.
//
//   `login` and `logout`, run from a shell with no CLAUDE_PLUGIN_DATA, act on
//   every install this origin has a trustworthy witness for — recording or
//   clearing consent on all of them, never guessing at just one. `status`/
//   `doctor` do the same when they cannot identify which install this shell
//   is sitting in: `reporting` only when every witnessed install has
//   consented, a distinct `mixed` state when some have and some have not
//   (status must not call that "reporting" — it would be true for some
//   installs and false for the one the person is actually looking at), and
//   `unknown` when there is no witness at all yet. Every witnessed directory,
//   in both layouts, is still only ever trusted *if it still exists* (never
//   created — that would fabricate consent for an install that is not there)
//   and passes the same validation as before; extending to many entries does
//   not loosen that check for any one of them. With neither CLAUDE_PLUGIN_DATA
//   nor a witnessed install, the state is unknown, not "not consented":
//   `login` records no marker and asks for a hook to run first; `status`/
//   `doctor` say plainly that they cannot see it from this shell instead of
//   asserting a negative.
//
//   The gate does not apply to $COFLEET_TOKEN: that is an operator-supplied
//   process override (CI, a server with OAuth off), not an interactive login
//   tied to any particular install.
//
// CLAUDE_PLUGIN_DATA IS NOT TRUSTWORTHY OUTSIDE A HOOK:
//
//   The platform guarantees CLAUDE_PLUGIN_DATA names the running plugin's own
//   data directory only for the process it launches to run a hook. Any other
//   process that merely has it in its environment — a terminal a plugin's
//   hook set it in and left behind, another plugin's subprocess that leaked
//   it into a shared shell — has no such guarantee. Observed for real: an
//   unrelated plugin's hook left CLAUDE_PLUGIN_DATA pointing at *that*
//   plugin's data directory in an interactive shell; `cofleet login` run
//   there wrote the consent marker into the wrong plugin's directory
//   entirely, while this plugin's own hooks (which get the correct value
//   fresh from the platform every time) kept looking in the right one, found
//   nothing, and stayed silent forever — success was reported, and nothing
//   was ever sent.
//
//   The fix: `login`/`status`/`doctor`/`logout` (never a hook — see
//   `verifyPluginDataIdentity`) first check whether CLAUDE_PLUGIN_DATA
//   plausibly names *this* install before trusting it, by comparing it
//   against this plugin's own identity, derived from where this very file
//   is running from (`ownPluginDataName`) — a real install's cache layout is
//   `.../plugins/cache/<marketplace>/<plugin>/<version>/bin/cofleet.mjs`,
//   and the harness names that install's data directory `<plugin>-<marketplace>`
//   to match (observed directly: `cofleet-presence-cofleet` for this plugin
//   from the `cofleet` marketplace, `codex-openai-codex` for the unrelated
//   plugin above). A mismatch is silently ignored nowhere: it falls through
//   to the existing witness resolution exactly as if CLAUDE_PLUGIN_DATA were
//   never set, AND is reported in one line on every command a person reads
//   (never on `hook`, which must stay silent) — the original bug was a
//   silent wrong answer, so a silent correction here would just be a
//   quieter version of the same bug.
//
//   Derivation legitimately fails outside a real install: this repo's own
//   tests run the checkout copy of this file (no `cache/<marketplace>/<plugin>/
//   <version>` ancestry above it), and so would a copied binary or a plain
//   `node bin/cofleet.mjs` from a clone. A failed derivation means "cannot
//   prove this install's identity from its own path," not "reject" — it
//   falls back to trusting CLAUDE_PLUGIN_DATA exactly as every build before
//   this fix did. Rejecting only fires when this file's own path proves an
//   identity AND the environment variable names something else; it never
//   locks a legitimate session out over an inconclusive check.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  login as oauthLogin,
  normalizeOrigin,
  refresh as oauthRefresh,
} from './oauth.mjs';
import { COFLEET_BASE_URL } from '../environment.mjs';

const PRODUCTION_BASE_URL = 'https://app.cofleet.dev';
/** Floor between two posts for the same session. Title changes bypass it. */
const COALESCE_MS = 60_000;
/** Hard ceiling on the network call. The hook's own timeout is 5s; this keeps
 *  the common case far under it even on a bad connection. Overridable so tests
 *  are not racing a real deadline on a loaded machine — never raise it in a
 *  real install, since this budget is spent on the teammate's prompt path. */
const REQUEST_TIMEOUT_MS = Number(process.env.COFLEET_TIMEOUT_MS) || 800;
/** `doctor` is user-invoked, so it is not held to the hook's budget. */
const DOCTOR_TIMEOUT_MS = 10_000;
const TITLE_MAX = 200;
const MAX_PENDING_PATHS = 200;

function stableDataRoot() {
  return join(homedir(), '.cofleet');
}

function envSelection(env, key) {
  const value = env?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function configuredBaseUrl({ env = process.env } = {}) {
  const selected = envSelection(env, 'COFLEET_URL') ?? COFLEET_BASE_URL;
  return normalizeOrigin(selected);
}

function baseUrl() {
  return configuredBaseUrl();
}

function ensurePrivateDirectory(directory) {
  const root = resolve(stableDataRoot());
  const target = resolve(directory);
  const targetRelative = relative(root, target);
  if (
    targetRelative === '..' ||
    targetRelative.startsWith(`..${sep}`) ||
    isAbsolute(targetRelative)
  ) {
    throw new Error('Credential path escapes the private Cofleet data root');
  }

  const segments = [basename(root)];
  if (targetRelative) segments.push(...targetRelative.split(sep));
  let current = dirname(root);
  for (const segment of segments) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirErr) {
        // A concurrent writer may have created the directory. Re-check it
        // below instead of following whatever appeared at this path.
        if (!mkdirErr || mkdirErr.code !== 'EEXIST') throw mkdirErr;
      }
      stat = lstatSync(current);
    }
    if (!isRealDirectory(stat)) {
      throw new Error('Credential directories must not be symlinks');
    }
    chmodSync(current, 0o700);
  }
}

/** Atomically replace a private Cofleet credential without following either a
 * file or directory symlink. */
function writePrivateFile(path, contents) {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);

  try {
    const target = lstatSync(path);
    if (target.isSymbolicLink()) throw new Error('Credential targets must not be symlinks');
    if (!target.isFile()) throw new Error('Credential targets must be regular files');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }

  const temp = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
  );
  let tempExists = false;
  try {
    writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    tempExists = true;
    chmodSync(temp, 0o600);

    // Re-check immediately before the atomic replacement. If a symlink
    // appeared concurrently, refuse it; rename never writes through a link.
    try {
      const target = lstatSync(path);
      if (target.isSymbolicLink()) throw new Error('Credential targets must not be symlinks');
      if (!target.isFile()) throw new Error('Credential targets must be regular files');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }

    renameSync(temp, path);
    tempExists = false;
    chmodSync(path, 0o600);
  } finally {
    if (tempExists) {
      try {
        unlinkSync(temp);
      } catch {
        // Best-effort cleanup; the target was never replaced.
      }
    }
  }
}

export function originKey(url) {
  return createHash('sha256').update(normalizeOrigin(url)).digest('hex');
}

/** This install's own plugin-data directory *name*, derived from where this
 *  file is actually running from — never from anything an environment
 *  variable claims. A real install's cache layout is exactly
 *  `.../plugins/cache/<marketplace>/<plugin>/<version>/bin/cofleet.mjs`
 *  (confirmed against a real `~/.claude/plugins/cache` tree), and the
 *  harness names that install's CLAUDE_PLUGIN_DATA directory
 *  `<plugin>-<marketplace>` to match — confirmed the same way:
 *  `cofleet-presence-cofleet` on disk for this plugin from the `cofleet`
 *  marketplace, `codex-openai-codex` for an unrelated plugin on the same
 *  machine. Requiring the `cache` ancestor is what makes this fail closed
 *  (return `null`) rather than derive nonsense for every shape that is not a
 *  real install: this repo's own tests run the checkout copy of this file,
 *  four directories short of that ancestry; so would a copied binary or a
 *  bare `node bin/cofleet.mjs` from a clone. `null` here is the caller's
 *  signal to fall back to trusting CLAUDE_PLUGIN_DATA as-is — see
 *  `verifyPluginDataIdentity` — never to reject it. */
export function ownPluginDataName(scriptPath = fileURLToPath(import.meta.url)) {
  const binDir = dirname(scriptPath);
  const versionDir = dirname(binDir);
  const pluginDir = dirname(versionDir);
  const marketplaceDir = dirname(pluginDir);
  const cacheDir = dirname(marketplaceDir);
  if (basename(cacheDir) !== 'cache') return null;
  const plugin = basename(pluginDir);
  const marketplace = basename(marketplaceDir);
  if (!plugin || !marketplace) return null;
  return `${plugin}-${marketplace}`;
}

/** Whether CLAUDE_PLUGIN_DATA should be trusted by a non-hook caller —
 *  `login`, `status`, `doctor`, `logout`. A hook subprocess never calls this:
 *  it always has the platform's own correct value for the install whose hook
 *  is running (see `writeWitness`/`hasConsentMarker`, which read the raw
 *  environment variable directly), and re-deriving an identity to check it
 *  against would be pure overhead on a path that must stay fast and silent.
 *
 *  Three outcomes:
 *    - unset: `{ trusted: false, rejected: false }` — nothing to trust or
 *      reject; every caller already handles a missing value the same way it
 *      always has.
 *    - set, and either this install's identity cannot be derived (see
 *      `ownPluginDataName`) or it matches: `{ trusted: true, rejected: false }`
 *      — trust it exactly as every build before this fix did. An
 *      undeterminable identity is not evidence of anything wrong; treating it
 *      as a rejection would turn every test, dev checkout, and copied binary
 *      into a false positive.
 *    - set, this install's identity CAN be derived, and it does not match:
 *      `{ trusted: false, rejected: true }` — the one case this fix changes.
 *      Callers must fall through to witness resolution exactly as if the
 *      variable were unset, and report it — see `foreignPluginDataLine`. */
function verifyPluginDataIdentity() {
  const raw = envSelection(process.env, 'CLAUDE_PLUGIN_DATA');
  if (!raw) return { raw: undefined, trusted: false, rejected: false, ownName: null };
  const ownName = ownPluginDataName();
  if (ownName === null || basename(raw) === ownName) {
    return { raw, trusted: true, rejected: false, ownName };
  }
  return { raw, trusted: false, rejected: true, ownName };
}

/** CLAUDE_PLUGIN_DATA, but only when `verifyPluginDataIdentity` trusts it —
 *  the single value every non-hook reader of the environment variable should
 *  use from here on. `undefined` covers both "unset" and "rejected": the
 *  callers below (`originDataDirs`, `legacyDataRoots`, `resolveMarkerDir`)
 *  already treat an undefined plugin-data value as "fall back to the stable
 *  root / the witness," which is exactly the desired behavior for a
 *  rejection too. */
function trustedPluginData() {
  const { raw, trusted } = verifyPluginDataIdentity();
  return trusted ? raw : undefined;
}

/** `dirs[0]` is the plugin-data-scoped candidate, present only when
 *  `pluginData` is given — callers on the hook path (always trustworthy, see
 *  `verifyPluginDataIdentity`) pass the raw environment value explicitly;
 *  every other caller relies on the default, which is already filtered
 *  through identity verification. */
export function originDataDirs(url = configuredBaseUrl(), pluginData = trustedPluginData()) {
  const key = originKey(url);
  const dirs = [];
  if (pluginData) dirs.push(join(pluginData, 'origins', key));
  const stable = join(stableDataRoot(), 'origins', key);
  if (!dirs.includes(stable)) dirs.push(stable);
  return dirs;
}

function stableOriginDataDir(url = configuredBaseUrl()) {
  return join(stableDataRoot(), 'origins', originKey(url));
}

function legacyDataRoots(pluginData = trustedPluginData()) {
  const roots = [];
  if (pluginData) roots.push(pluginData);
  const stable = stableDataRoot();
  if (!roots.includes(stable)) roots.push(stable);
  return roots;
}

function isProduction(url = configuredBaseUrl()) {
  return url === PRODUCTION_BASE_URL;
}

const MARKER_FILENAME = 'consented';
/** The build before this fix wrote a single unkeyed witness file here — no
 *  install identity in the name, so a second install silently overwrote the
 *  first one's entry (the bug this file now fixes). Still read (never
 *  written again) so an install that already logged in under that build
 *  keeps working; `logout` still sweeps it up. */
const WITNESS_FILENAME = 'plugin-data-dir';
/** Per-install witnesses live here instead — one file per install, see
 *  `witnessEntryPath`. */
const WITNESS_DIRNAME = 'witnesses';
/** Bound on how many entries `witnessEntryFiles` will ever read on one call.
 *  Not a trust boundary — every entry is still validated by
 *  `isTrustedWitnessTarget` before its content is used for anything — just a
 *  resource limit, so a directory stuffed with junk (an attacker able to
 *  write under the stable root, or a runaway process) cannot make every
 *  `login`/`status`/`logout` do unbounded work. Real machines run a small,
 *  fixed number of coding-agent harnesses. */
const MAX_WITNESS_ENTRIES = 64;
/** Written by a build that predates the witness. No longer read for
 *  anything — `logout` sweeps it up as garbage; nothing else looks at it. */
const LEGACY_PENDING_MARKER_FILENAME = 'consent-pending';

function witnessPath(url = configuredBaseUrl()) {
  return join(stableOriginDataDir(url), WITNESS_FILENAME);
}

function witnessesDir(url = configuredBaseUrl()) {
  return join(stableOriginDataDir(url), WITNESS_DIRNAME);
}

/** Stable filename for one install's witness entry: a hash of the install's
 *  own plugin-data marker directory, never the raw path — a path is not a
 *  safe filename, and would also spell out install-local directory names
 *  into a directory listing for no reason. */
function witnessEntryPath(url, dir) {
  return join(witnessesDir(url), createHash('sha256').update(dir).digest('hex'));
}

function legacyPendingMarkerPath(url = configuredBaseUrl()) {
  return join(stableOriginDataDir(url), LEGACY_PENDING_MARKER_FILENAME);
}

/** Record which plugin-data origin directory the current install uses, so a
 *  later non-hook process (a terminal `login`/`status`/`doctor`/`logout`)
 *  can find it without CLAUDE_PLUGIN_DATA. Called on every hook run — the
 *  only path guaranteed to have the env var. Writes only this install's own
 *  entry (see `witnessEntryPath`) — a hook must never touch another
 *  install's witness — and only when the content differs. Never lets a
 *  failure escape: a hook must never disrupt a session over a diagnostic
 *  file. Reads CLAUDE_PLUGIN_DATA raw, never through `trustedPluginData` — a
 *  hook always has the platform's own correct value for the install whose
 *  hook is running; see the identity check's own doc comment for why it
 *  exists only for `login`/`status`/`doctor`/`logout`. */
function writeWitness(url = configuredBaseUrl()) {
  const pluginData = envSelection(process.env, 'CLAUDE_PLUGIN_DATA');
  if (!pluginData) return;
  const dir = originDataDirs(url, pluginData)[0];
  try {
    // The directory itself is what `login`'s fallback checks for existence
    // (see `witnessedDataDirs`). Creating it here is not fabricating consent
    // — CLAUDE_PLUGIN_DATA being set is the platform's own proof this install
    // is really present, and this hook run is real evidence of that, not a
    // guess. `login` still never creates it on its own — see there.
    mkdirSync(dir, { recursive: true });
    const path = witnessEntryPath(url, dir);
    let existing = null;
    try {
      existing = readFileSync(path, 'utf8').trim();
    } catch {
      existing = null;
    }
    if (existing === dir) return;
    writePrivateFile(path, `${dir}\n`);
  } catch {
    // Silent on purpose — see the contract at the top of this file.
  }
}

/** True when an lstat result is a real directory — not a symlink and not
 *  some other file type standing in for one. The one place both the private
 *  credential-root walk and the untrusted-witness-path validator spell out
 *  "refuse a symlink here": same concept, one implementation. */
function isRealDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

/** Validate a witness file's claimed marker directory before ever trusting
 *  it. A witness is written by a hook run into `~/.cofleet`, which is not as
 *  privileged as the marker directory itself, so its *contents* — a path —
 *  must never be trusted at face value: a corrupt, hand-edited, or
 *  attacker-written witness must not be able to aim the marker write (or
 *  `logout`'s unlink) anywhere but this origin's own directory. Requires an
 *  absolute path whose last two segments are exactly `origins/<key>` for
 *  this URL, and refuses a symlink at either of those two components (the
 *  ones actually inside Cofleet's control) — the same refusal
 *  `ensurePrivateDirectory` applies to its own writes, and scoped the same
 *  way: checking every ancestor up to the filesystem root would also trip
 *  on ordinary OS symlinks outside anyone's control (`/var` -> `/private/var`
 *  on macOS, for one), which is not the threat here. */
function isTrustedWitnessTarget(dir, url) {
  if (!isAbsolute(dir)) return false;
  const originsDir = dirname(dir);
  if (basename(originsDir) !== 'origins' || basename(dir) !== originKey(url)) return false;

  let originsStat;
  let dirStat;
  try {
    originsStat = lstatSync(originsDir);
    dirStat = lstatSync(dir);
  } catch {
    return false;
  }
  return isRealDirectory(originsStat) && isRealDirectory(dirStat);
}

/** Every existing witness-entry file under this origin's `witnesses/`
 *  directory, up to `MAX_WITNESS_ENTRIES` — one per install that has ever run
 *  a hook here, in whatever order `readdirSync` returns. An entry that is not
 *  a real regular file (a symlink someone planted in the directory, in
 *  particular) is skipped by `lstat`-ing it before ever reading through it —
 *  the same "refuse a symlink" rule applied everywhere else in this file,
 *  here applied to the directory itself rather than only its content. */
function witnessEntryFiles(url = configuredBaseUrl()) {
  let names;
  try {
    names = readdirSync(witnessesDir(url));
  } catch {
    return [];
  }
  const files = [];
  for (const name of names.slice(0, MAX_WITNESS_ENTRIES)) {
    const path = join(witnessesDir(url), name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push(path);
  }
  return files;
}

/** Every install this origin has a trustworthy witness for — the current
 *  per-install layout plus the single legacy file a build before this fix
 *  wrote (see `WITNESS_FILENAME`) — deduplicated. A directory a witness
 *  names but that is gone (or was never there, or fails
 *  `isTrustedWitnessTarget`) never appears here: that would fabricate
 *  consent for an install that is not present, or write through content an
 *  attacker supplied. Order is not meaningful; callers that treat "this
 *  shell's own install" specially do so through `resolveMarkerDir`
 *  (CLAUDE_PLUGIN_DATA) instead, never by picking an element of this list. */
function witnessedDataDirs(url = configuredBaseUrl()) {
  const dirs = [];
  const addIfTrusted = (raw) => {
    const dir = typeof raw === 'string' ? raw.trim() : '';
    if (dir && isTrustedWitnessTarget(dir, url) && !dirs.includes(dir)) dirs.push(dir);
  };
  for (const path of witnessEntryFiles(url)) {
    try {
      addIfTrusted(readFileSync(path, 'utf8'));
    } catch {
      // Gone or unreadable between the listing and the read — skip it.
    }
  }
  try {
    addIfTrusted(readFileSync(witnessPath(url), 'utf8'));
  } catch {
    // No legacy witness — normal for an install created after this fix.
  }
  return dirs;
}

/** Where the install-generation marker lives when CLAUDE_PLUGIN_DATA
 *  identifies exactly one install — always true under a hook, and also true
 *  for `login`/`status`/`doctor`/`logout` run from inside an agent session
 *  whose CLAUDE_PLUGIN_DATA verifies as this install's own (see
 *  `verifyPluginDataIdentity`; a rejected value is treated exactly like an
 *  unset one here, never like a valid one pointed somewhere wrong). Null
 *  when the env var is unset or rejected (the no-env-var callers each fall
 *  back to `witnessedDataDirs`, which may name several installs — a single
 *  `dir` cannot represent that) or when its root is not really there, which
 *  matters because `mkdirSync` downstream would otherwise resurrect a wiped
 *  install directory just to write a marker into it. */
function resolveMarkerDir(url = configuredBaseUrl()) {
  const pluginData = trustedPluginData();
  if (!pluginData) return null;
  let stat;
  try {
    stat = lstatSync(pluginData);
  } catch {
    return null;
  }
  if (!isRealDirectory(stat)) return null;
  return originDataDirs(url, pluginData)[0];
}

/** Whether `path` is a real (non-symlink) directory, without throwing on a
 *  missing path. */
function existsRealDirectory(path) {
  try {
    return isRealDirectory(lstatSync(path));
  } catch {
    return false;
  }
}

/** The plugin-data root two segments above a marker directory
 *  (`<root>/origins/<key>`) — the CLAUDE_PLUGIN_DATA value in the env
 *  branch, or the witnessed plugin-data directory in the witness branch.
 *  This is exactly the directory an uninstall wipes. */
export function markerRootFor(dir) {
  return dirname(dirname(dir));
}

/** True when `root` is the same real directory it was when `before` was
 *  captured — same device and inode, not merely "a directory exists at this
 *  path again". A wipe-then-recreate (whether by an uninstall racing us, or
 *  by our own `mkdirSync` resurrecting a vanished root) changes the inode;
 *  a directory that was never touched keeps it. */
export function markerRootSurvived(root, before) {
  let after;
  try {
    after = lstatSync(root);
  } catch {
    return false;
  }
  return isRealDirectory(after) && after.dev === before.dev && after.ino === before.ino;
}

/** Undo a marker write whose root did not survive: remove the marker file,
 *  then any of `origins`/`<key>` this call created (deepest first) — never
 *  the root itself, which this call never created and must not touch. */
export function cleanupResurrectedMarker(dir, path, originsExisted, dirExisted) {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort: it may already be gone if the root vanished again.
  }
  if (!dirExisted) {
    try {
      rmdirSync(dir);
    } catch {
      // Not empty, already gone, or otherwise unremovable — nothing more to
      // do without risking someone else's data.
    }
  }
  if (!originsExisted) {
    try {
      rmdirSync(dirname(dir));
    } catch {
      // Same as above.
    }
  }
}

/** The `dir`-taking core of `prepareConsentMarker`: captures the plugin-data
 *  root's identity while it is still trusted to exist, for a marker
 *  directory the caller has already resolved (directly from
 *  CLAUDE_PLUGIN_DATA, or one of several from `witnessedDataDirs`). Returns
 *  `null` when the root is confirmed gone the instant before we would touch
 *  the filesystem — the tightest form of the race, caught before any write
 *  is attempted. */
function prepareConsentMarkerForDir(dir) {
  const root = markerRootFor(dir);
  let rootBefore;
  try {
    rootBefore = lstatSync(root);
  } catch {
    return null;
  }

  const originsExisted = existsRealDirectory(dirname(dir));
  const dirExisted = originsExisted && existsRealDirectory(dir);
  return { dir, root, rootBefore, originsExisted, dirExisted };
}

/** The half of `writeConsentMarker` that runs *before* the racy `mkdirSync`,
 *  for the single install CLAUDE_PLUGIN_DATA identifies. Returns `null` when
 *  the location cannot be resolved. Split out from `commitConsentMarker` so a
 *  test can deterministically land an uninstall in between the two, the same
 *  window an unlucky real one could land in. */
export function prepareConsentMarker(url = configuredBaseUrl()) {
  const dir = resolveMarkerDir(url);
  if (!dir) return null;
  return prepareConsentMarkerForDir(dir);
}

/** The half of `writeConsentMarker` that performs the write and its
 *  post-write verification, given what `prepareConsentMarker` captured.
 *
 *  Returns `'ok'` when the marker file was written and the root survived
 *  untouched throughout.
 *
 *  Returns `'refused'` when the marker path itself had to be refused — a
 *  symlink there (lstat first, refuse anything that is not
 *  ENOENT-or-regular-file) — or when the plugin-data root did not survive:
 *  an uninstall wiped it after `prepareConsentMarker` ran, and the
 *  `recursive: true` below silently recreated it just to plant a marker in
 *  it. Dropping `recursive` would break the ordinary first login instead
 *  (`dir` itself is created if missing — at most the `origins` and `<key>`
 *  segments, never the root, which `prepareConsentMarker` already confirmed
 *  exists — this is what makes the very first login of an install work with
 *  no hook having created `origins/<key>` yet). So instead this compares the
 *  root's identity (device + inode) before and after: if `mkdirSync` had to
 *  resurrect it, the inode changed, and the write is undone — marker
 *  removed, any directory this call created removed — and reported as a
 *  refusal rather than a lying success. */
export function commitConsentMarker({ dir, root, rootBefore, originsExisted, dirExisted }) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return 'refused';
  }

  const path = join(dir, MARKER_FILENAME);
  try {
    const existing = lstatSync(path);
    if (!existing.isFile()) return 'refused';
  } catch (err) {
    if (!err || err.code !== 'ENOENT') return 'refused';
  }

  try {
    writeFileSync(path, `${MARKER_FILENAME}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    return 'refused';
  }

  if (!markerRootSurvived(root, rootBefore)) {
    cleanupResurrectedMarker(dir, path, originsExisted, dirExisted);
    return 'refused';
  }

  return 'ok';
}

/** Record consent for a successful login. With CLAUDE_PLUGIN_DATA set, this
 *  is exactly the pre-fix behavior — see `prepareConsentMarker` and
 *  `commitConsentMarker` for what each half does and why: that one install,
 *  and only that install. Without it, this is what makes a terminal `login`
 *  correct on a machine running this plugin in more than one harness: every
 *  install this shell has a trustworthy witness for (`witnessedDataDirs`)
 *  gets marked, not just whichever one a single shared witness used to
 *  remember. `count` is how many installs actually got marked, for the
 *  success message.
 *
 *  `result: 'unresolved'` (no CLAUDE_PLUGIN_DATA and no witnessed install at
 *  all yet) is not the same problem as `'refused'` (at least one location
 *  resolved but every write to it was refused) — `'unresolved'` is the
 *  permanent state of a headless box that will never run a hook here, and
 *  `runLogin`'s static-token form has an operator-supplied way around it.
 *  `'refused'` with `count > 0` (some installs marked, others refused) still
 *  reads as an overall success — see `runLogin`. */
function writeConsentMarker(url = configuredBaseUrl()) {
  const prepared = prepareConsentMarker(url);
  if (prepared) {
    const result = commitConsentMarker(prepared);
    return { result, count: result === 'ok' ? 1 : 0 };
  }

  const dirs = witnessedDataDirs(url);
  if (dirs.length === 0) return { result: 'unresolved', count: 0 };

  let okCount = 0;
  for (const dir of dirs) {
    const forDir = prepareConsentMarkerForDir(dir);
    if (forDir && commitConsentMarker(forDir) === 'ok') okCount += 1;
  }
  return { result: okCount > 0 ? 'ok' : 'refused', count: okCount };
}

/** The hook gate: true only when CLAUDE_PLUGIN_DATA is set AND the marker
 *  exists in that exact directory. Hooks never consult the witness for this
 *  — they are the ones that write it, and always have the env var. Reads it
 *  raw, like `writeWitness` — a hook's CLAUDE_PLUGIN_DATA needs no identity
 *  check, see `verifyPluginDataIdentity`. */
function hasConsentMarker(url = configuredBaseUrl()) {
  const pluginData = envSelection(process.env, 'CLAUDE_PLUGIN_DATA');
  if (!pluginData) return false;
  try {
    return lstatSync(join(originDataDirs(url, pluginData)[0], MARKER_FILENAME)).isFile();
  } catch {
    return false;
  }
}

/** For `status`/`doctor`, resolved the same two ways as `writeConsentMarker`:
 *  directly through CLAUDE_PLUGIN_DATA when it identifies exactly one
 *  install, else aggregated across every install `witnessedDataDirs` names.
 *
 *  `'consented'` and `'none'` are resolved answers in both cases (the marker
 *  location(s) are known, present or not everywhere). `'unknown'` means this
 *  shell cannot see any install at all — no env var and no witness.
 *  `'mixed'` (aggregate path only) means some witnessed installs have
 *  consented and some have not: this shell cannot tell which install it is
 *  actually sitting in, so it must not report `'consented'` — that would be
 *  true for some installs and false for the one someone is looking at. */
function consentState(url = configuredBaseUrl()) {
  const direct = resolveMarkerDir(url);
  if (direct) {
    try {
      return lstatSync(join(direct, MARKER_FILENAME)).isFile() ? 'consented' : 'none';
    } catch {
      return 'none';
    }
  }

  const dirs = witnessedDataDirs(url);
  if (dirs.length === 0) return 'unknown';
  let consentedCount = 0;
  for (const dir of dirs) {
    try {
      if (lstatSync(join(dir, MARKER_FILENAME)).isFile()) consentedCount += 1;
    } catch {
      // Not consented in this one.
    }
  }
  if (consentedCount === 0) return 'none';
  if (consentedCount === dirs.length) return 'consented';
  return 'mixed';
}

/** Where every successful static-token write lands. */
function tokenPath(url = configuredBaseUrl()) {
  return join(stableOriginDataDir(url), 'token');
}

/** Every static-token read location, in priority order. The plugin-data origin
 *  comes first for hooks, then the stable shell-written origin. Historical
 *  root tokens have no origin metadata, so accepting one could send it to the
 *  wrong environment; users must write it again with `cofleet login <token>`. */
function tokenCandidates(url = configuredBaseUrl()) {
  return originDataDirs(url).map((dir) => join(dir, 'token'));
}

/** Where every successful OAuth credential write lands. */
function credentialsPath(url = configuredBaseUrl()) {
  return join(stableOriginDataDir(url), 'credentials.json');
}

function credentialsCandidates(url = configuredBaseUrl()) {
  const candidates = originDataDirs(url).map((dir) => join(dir, 'credentials.json'));
  if (isProduction(url)) {
    for (const root of legacyDataRoots()) {
      const legacy = join(root, 'credentials.json');
      if (!candidates.includes(legacy)) candidates.push(legacy);
    }
  }
  return candidates;
}

function readCredentials(url = configuredBaseUrl()) {
  const selectedOrigin = normalizeOrigin(url);
  for (const path of credentialsCandidates(url)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      const credentialOrigin = normalizeOrigin(raw?.baseUrl);
      if (
        credentialOrigin === selectedOrigin &&
        typeof raw.accessToken === 'string' &&
        raw.accessToken.length > 0
      ) {
        return { ...raw, path, writePath: credentialsPath(url) };
      }
    } catch {
      // Try the next location.
    }
  }
  return null;
}

function writeCredentials(credentials, path = credentialsPath()) {
  const { path: _dropPath, writePath: _dropWritePath, ...body } = credentials;
  writePrivateFile(path, `${JSON.stringify(body, null, 2)}\n`);
}

/** The credential plus WHERE it came from and WHAT it is. `doctor` reports all
 *  three: most diagnoses are "you have a stale one here and a fresh one there".
 *
 *  Order: an explicitly origin-bound env var wins, then the OAuth pair, then a
 *  static `vk_` token. An unbound process-wide token could otherwise leak from
 *  one configured Cofleet environment to another. */
function resolveToken(url = configuredBaseUrl()) {
  const environmentToken = process.env.COFLEET_TOKEN?.trim();
  const environmentOrigin = envSelection(process.env, 'COFLEET_TOKEN_ORIGIN');
  if (environmentToken && environmentOrigin) {
    try {
      if (normalizeOrigin(environmentOrigin) === normalizeOrigin(url)) {
        return { token: environmentToken, source: '$COFLEET_TOKEN', kind: 'static' };
      }
    } catch {
      // Ignore an untrusted or malformed binding and continue to stored state.
    }
  }
  const credentials = readCredentials(url);
  if (credentials) {
    return {
      token: credentials.accessToken,
      source: credentials.path,
      kind: 'oauth',
      credentials,
    };
  }
  for (const candidate of tokenCandidates(url)) {
    try {
      const t = readFileSync(candidate, 'utf8').trim();
      if (t.length > 0) return { token: t, source: candidate, kind: 'static' };
    } catch {
      // Try the next candidate.
    }
  }
  return { token: null, source: null, kind: null };
}

/** Refresh a few minutes early so a post never races the expiry. Access tokens
 *  last 12h, so this runs about twice a day, not on the hot path. */
const REFRESH_SKEW_MS = 5 * 60_000;

/** Resolve a token, rotating an expiring OAuth pair first.
 *
 *  A failed refresh leaves the stored credentials ALONE and returns null: a
 *  concurrent hook may have rotated them a moment ago, in which case the next
 *  run re-reads the fresh pair and heals itself. Clearing them here would turn
 *  one lost race into a permanent logout. */
async function currentToken() {
  const resolved = resolveToken();
  if (resolved.kind !== 'oauth') return resolved.token;

  const credentials = resolved.credentials;
  if (typeof credentials.expiresAt !== 'number' || Date.now() < credentials.expiresAt - REFRESH_SKEW_MS) {
    return credentials.accessToken;
  }
  const rotated = await oauthRefresh(credentials, `${baseUrl()}/oauth/token`).catch(() => ({
    ok: false,
  }));
  if (!rotated.ok) return null;
  writeCredentials(rotated.credentials, credentials.writePath);
  return rotated.credentials.accessToken;
}

// ---------- session state (local, per session id) ----------

function statePath(sessionId) {
  // The session id comes from the harness, but it still reaches the filesystem
  // as a filename — constrain it rather than trusting its shape.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  // Hook-owned transient state follows the selected origin and prefers the
  // harness-provided data root. Credentials are still written to ~/.cofleet.
  // Only ever called from the hook path (see readState/writeState below), so
  // this reads CLAUDE_PLUGIN_DATA raw — same reasoning as `writeWitness`.
  const pluginData = envSelection(process.env, 'CLAUDE_PLUGIN_DATA');
  return join(originDataDirs(undefined, pluginData)[0], 'sessions', `${safe}.json`);
}

function readState(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(statePath(sessionId), 'utf8'));
    return {
      lastPostAt: typeof raw.lastPostAt === 'number' ? raw.lastPostAt : 0,
      pending: Array.isArray(raw.pending) ? raw.pending.filter((p) => typeof p === 'string') : [],
    };
  } catch {
    return { lastPostAt: 0, pending: [] };
  }
}

function writeState(sessionId, state) {
  try {
    const p = statePath(sessionId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(state), 'utf8');
  } catch {
    // A read-only or full disk costs us coalescing, not correctness: the worst
    // case is posting more often than intended.
  }
}

// ---------- local facts ----------

function cleanTitle(text) {
  if (typeof text !== 'string') return undefined;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed.slice(0, TITLE_MAX) : undefined;
}

function machineName() {
  try {
    return `${userInfo().username}@${hostname()}`.slice(0, 120);
  } catch {
    return null;
  }
}

/** Current branch, read straight off `.git` rather than shelling out to git —
 *  no subprocess on a hook path, and it works the same in a worktree (where
 *  `.git` is a file pointing at the real gitdir). */
function branchName(cwd) {
  try {
    let gitDir = join(cwd, '.git');
    const meta = readFileSync(gitDir, 'utf8');
    // A directory read throws EISDIR; reaching here means `.git` is a file.
    const pointer = meta.match(/^gitdir:\s*(.+)$/m);
    if (!pointer) return null;
    gitDir = resolve(cwd, pointer[1].trim());
    return headRef(gitDir);
  } catch (err) {
    if (err && err.code === 'EISDIR') return headRef(join(cwd, '.git'));
    return null;
  }
}

function headRef(gitDir) {
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    // Detached HEAD reports no branch rather than a bare sha, which would read
    // as a nonsense worktree label on the wall.
    return ref ? ref[1].slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** Repo-relative path, or null when the file sits outside the session's cwd
 *  (a path we have no business reporting as this project's work). */
function repoRelative(cwd, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const root = resolve(cwd);
  const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, absolute);
  if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Codex's own file-edit tool (`apply_patch`) carries no `tool_input.file_path`
 *  at all — verified against a real captured payload from a live Codex
 *  session: `tool_input` is `{ command: "*** Begin Patch\n*** Update File:
 *  README.md\n@@\n+test line\n*** End Patch" }`. What it does carry is a
 *  fixed patch envelope: every file the patch touches is named on its own
 *  `*** Add File: <path>` / `*** Delete File: <path>` / `*** Update File:
 *  <path>` header line, with a rename's destination on a following `*** Move
 *  to: <path>` line. That header is a structured, stable sentinel format —
 *  not arbitrary shell text — so extracting it is the one Codex
 *  `PostToolUse` case worth parsing; a Bash `tool_input.command` is never
 *  attempted here (see the file-header contract at the top of this file).
 *  Returns every path named, in order; each is still run through
 *  `repoRelative` by the caller before being trusted. */
function applyPatchFilePaths(patchText) {
  if (typeof patchText !== 'string') return [];
  const paths = [];
  for (const line of patchText.split('\n')) {
    const match = /^\*\*\* (?:Add|Delete|Update) File: (.+)$|^\*\*\* Move to: (.+)$/.exec(line);
    if (match) paths.push((match[1] ?? match[2]).trim());
  }
  return paths;
}

// ---------- the hook path ----------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function post(body, token, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl()}/api/v1/work-sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Which coding agent invoked this hook subprocess: `'codex'` or
 *  `'claude_code'` (the wire values `LocalAgentHarness` accepts, alongside
 *  `'flow_cli'` and `'other'` this reporter never sends).
 *
 *  Verified empirically, not assumed — captured a real hook subprocess's full
 *  environment under both harnesses (an isolated `CODEX_HOME`-installed
 *  plugin driven through `codex exec`, and an isolated `CLAUDE_CONFIG_DIR`
 *  session driven through `claude -p`/`--plugin-dir`, both with the ambient
 *  shell wiped via `env -i` first so nothing leaked in from the invoking
 *  terminal). Codex sets four Claude-namespaced-or-not variables on every
 *  hook subprocess: the `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA`
 *  compatibility pair this file already keys off of elsewhere, AND its own
 *  bare `PLUGIN_ROOT`/`PLUGIN_DATA` (no `CLAUDE_` prefix) pointing at the
 *  same paths. Claude Code's hook subprocess sets only the `CLAUDE_`-prefixed
 *  pair — never a bare `PLUGIN_ROOT` or `PLUGIN_DATA`. `PLUGIN_ROOT` is
 *  therefore Codex-exclusive, and — unlike `CLAUDECODE`/`CLAUDE_CODE_*`,
 *  which a Codex session merely launched from inside a Claude Code terminal
 *  can inherit from its parent shell — it is assigned fresh by whichever
 *  harness is directly running this specific hook subprocess, not inherited
 *  from an ambient wrapper. It is also structurally guaranteed present:
 *  Codex only ever invokes this hook as part of resolving cofleet-presence's
 *  own plugin hooks, and it sets `PLUGIN_ROOT` for every plugin hook it
 *  runs, not something specific to this test setup. No `CODEX_*` variable
 *  was present in the hook's env at all under an isolated `CODEX_HOME`. */
function detectHarness() {
  return envSelection(process.env, 'PLUGIN_ROOT') ? 'codex' : 'claude_code';
}

async function runHook() {
  const selectedBaseUrl = baseUrl();
  // Always runs first: this is the only place the witness ever gets written,
  // and a hook is the only caller guaranteed to have CLAUDE_PLUGIN_DATA to
  // witness in the first place.
  writeWitness(selectedBaseUrl);

  const resolved = resolveToken(selectedBaseUrl);
  // The gate: an install-tied credential (OAuth or a file-written static
  // token) needs the marker too. $COFLEET_TOKEN is an operator override with
  // no install to consent for, so it is exempt.
  if (resolved.source !== '$COFLEET_TOKEN' && !hasConsentMarker(selectedBaseUrl)) return;

  const token = await currentToken();
  // Not logged in is the normal state right after install, not an error. So is
  // a refresh that lost a race — both mean "skip this post", never "complain".
  if (!token) return;

  const payload = JSON.parse(await readStdin());
  const sessionId = payload.session_id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return;

  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : process.cwd();
  const event = payload.hook_event_name;
  const state = readState(sessionId);

  const body = { sessionId, harness: detectHarness() };
  let force = false;

  if (event === 'SessionStart') {
    // On a genuine start (no prompt typed yet) the directory is the most
    // honest title available; the first UserPromptSubmit replaces it. Both
    // harnesses also fire SessionStart mid-session with `source: 'compact'`
    // after automatic context compaction — by then a real prompt-derived
    // title already exists, so resetting it to the bare directory name here
    // would silently clobber it on every compaction. Only reset the title
    // when this is not a compaction replay; machine/worktree are harmless
    // facts to refresh either way.
    if (payload.source !== 'compact') {
      body.title = cleanTitle(basename(cwd));
    }
    body.machine = machineName();
    body.worktree = branchName(cwd);
    force = true;
  } else if (event === 'UserPromptSubmit') {
    // The field is `prompt`. Getting this name wrong does not fail loudly: an
    // undefined title is simply omitted from the post, the API keeps whatever
    // the row already had, and every session on the team's wall reads as the
    // directory name SessionStart put there. It shipped that way once.
    // `session_title` is the harness's own summary, used only when a prompt is
    // somehow absent — never as a replacement for what the teammate typed.
    body.title = cleanTitle(payload.prompt) ?? cleanTitle(payload.session_title);
    force = true;
  } else if (event === 'PostToolUse') {
    // Claude Code's Edit/Write/Read/NotebookEdit tools carry `file_path`.
    // Codex's `apply_patch` (aliased into this same matcher — see
    // `applyPatchFilePaths`) carries none; its patch envelope is parsed
    // instead. A Bash `tool_input.command` is deliberately never parsed here.
    const filePaths =
      typeof payload.tool_input?.file_path === 'string'
        ? [payload.tool_input.file_path]
        : payload.tool_name === 'apply_patch'
          ? applyPatchFilePaths(payload.tool_input?.command)
          : [];
    for (const filePath of filePaths) {
      const rel = repoRelative(cwd, filePath);
      if (rel && !state.pending.includes(rel)) {
        state.pending = [...state.pending, rel].slice(-MAX_PENDING_PATHS);
      }
    }
  }

  const now = Date.now();
  if (!force && now - state.lastPostAt < COALESCE_MS) {
    // Not posting this time — keep the accumulated paths for the next flush.
    writeState(sessionId, state);
    return;
  }

  if (state.pending.length > 0) body.paths = state.pending;

  // State is written BEFORE the request, and the pending list is cleared
  // regardless of the outcome. A failed post costs one batch of area keys; a
  // list that only clears on success would grow without bound whenever the
  // network is down, and re-send the same paths forever.
  writeState(sessionId, { lastPostAt: now, pending: [] });
  await post(body, token);
}

// ---------- user-facing subcommands ----------

/** The one line `login`/`status`/`doctor` print when CLAUDE_PLUGIN_DATA was
 *  set but rejected as another install's data directory (see
 *  `verifyPluginDataIdentity`) — `null` when nothing was rejected (unset, or
 *  it verified as this install's own), so the common case prints nothing
 *  new. Names the rejected value and where consent is being resolved
 *  instead, so a silent wrong answer never becomes a silent right one — see
 *  the CLAUDE_PLUGIN_DATA contract note at the top of this file. */
function foreignPluginDataLine(url = configuredBaseUrl()) {
  const check = verifyPluginDataIdentity();
  if (!check.rejected) return null;
  const witnessed = witnessedDataDirs(url);
  const using =
    witnessed.length === 0
      ? 'no witnessed install yet for this origin'
      : witnessed.length === 1
        ? witnessed[0]
        : `${witnessed.length} witnessed installs on this machine`;
  return (
    `Ignored CLAUDE_PLUGIN_DATA (${check.raw}) — that is a different ` +
    `plugin's data directory, not this install's (expected one named ` +
    `"${check.ownName}"). Using ${using} instead.`
  );
}

async function runLogin(argument) {
  // Validate before any credential write. In particular, an invalid operator
  // override must not leave a token at a location unrelated to a real origin.
  const selectedBaseUrl = baseUrl();
  // Escape hatch: an operator-minted `vk_` token still works, for a server with
  // OAuth switched off or a CI box with no browser.
  const NO_MARKER_TARGET_MESSAGE =
    `Reporting consent is recorded per install, and this shell has no ` +
    `CLAUDE_PLUGIN_DATA and no install to record it against yet.\n` +
    `Start a Claude Code session here (which runs the hooks), then run ` +
    `\`cofleet login\` again.\n`;
  const MARKER_REFUSED_MESSAGE =
    `Consent could not be recorded — the marker location resolved but the ` +
    `write itself was refused (something unexpected is already at that path).\n` +
    `Reporting will stay off until that is cleared and \`cofleet login\` runs again.\n`;
  // Finding 7: a headless/CI box with no CLAUDE_PLUGIN_DATA and no witness
  // never gets one — there is no Claude Code session here to ever run a
  // hook. Failing `cofleet login "$TOKEN"` there is permanent, not
  // transient, so this is the operator's way around the per-install gate:
  // $COFLEET_TOKEN is exempt from it entirely (see the hook gate above).
  const operatorTokenMessage = (token) =>
    `Reporting consent is recorded per install, and this shell has no ` +
    `CLAUDE_PLUGIN_DATA and no install to record it against yet — normal on ` +
    `a headless box, where no Claude Code session will ever run here to ` +
    `establish one.\n` +
    `The token still saved. To report from this shell anyway, export:\n` +
    `  export COFLEET_TOKEN='${token}'\n` +
    `  export COFLEET_TOKEN_ORIGIN='${selectedBaseUrl}'\n` +
    `The hook gate exempts $COFLEET_TOKEN — no per-install consent needed.\n`;

  // `count > 1` means CLAUDE_PLUGIN_DATA was unset and more than one
  // witnessed install got marked — say so, since "reporting" alone would
  // undersell what a machine with two harnesses installed just did.
  const reportingLine = (count) =>
    `Work sessions will report to ${selectedBaseUrl}` +
    (count > 1 ? ` from ${count} installs on this machine.\n` : `.\n`);

  // Computed once, before either branch writes anything, so the notice
  // reflects the shell's actual CLAUDE_PLUGIN_DATA rather than anything a
  // write below might touch.
  const foreignNotice = foreignPluginDataLine(selectedBaseUrl);

  if (argument) {
    const token = argument.trim();
    const path = tokenPath(selectedBaseUrl);
    writePrivateFile(path, `${token}\n`);
    const consentResult = writeConsentMarker(selectedBaseUrl);
    process.stdout.write(`Saved a static token.\n`);
    if (foreignNotice) process.stdout.write(`${foreignNotice}\n`);
    if (consentResult.result === 'unresolved') {
      process.stdout.write(operatorTokenMessage(token));
      return 0;
    }
    if (consentResult.result === 'refused') {
      process.stdout.write(MARKER_REFUSED_MESSAGE);
      return 1;
    }
    process.stdout.write(reportingLine(consentResult.count));
    return 0;
  }

  const result = await oauthLogin(selectedBaseUrl, (line) => process.stdout.write(`${line}\n`));
  if (!result.ok) {
    process.stdout.write(`Login failed: ${result.reason}\n`);
    return 1;
  }
  writeCredentials(result.credentials);
  const consentResult = writeConsentMarker(selectedBaseUrl);
  process.stdout.write(`Connected. Credentials: ${credentialsPath()}\n`);
  if (foreignNotice) process.stdout.write(`${foreignNotice}\n`);
  if (consentResult.result !== 'ok') {
    // The interactive OAuth branch keeps exit 1 either way (unresolved or
    // refused): it always runs inside a Claude Code session with a human at
    // the keyboard, so there is no headless-box case to route around here.
    process.stdout.write(NO_MARKER_TARGET_MESSAGE);
    return 1;
  }
  process.stdout.write(reportingLine(consentResult.count));
  return 0;
}

/** How each status maps to something a human can act on. Total by construction
 *  so an unhandled code can't read as success. */
const DIAGNOSIS = {
  400: ['ok', 'Reporting works. The probe was rejected as malformed, which is the expected answer.'],
  401: ['fail', 'The server refused this credential. Get a fresh token and run `cofleet login`.'],
  403: ['fail', 'This credential is not allowed to report sessions.'],
  404: ['fail', 'This Cofleet server has no work-sessions endpoint yet — it predates the feature.'],
  429: ['warn', 'Rate limited right now, but the credential and the endpoint are both fine.'],
};

/** The four `consentState` answers, each carrying everything both readers
 *  need: the short phrase `status`/`doctor`'s one-liner uses, and — for
 *  `doctor` only — the extra diagnostic lines and exit code to stop on
 *  rather than proceeding to the live probe (`null` means "proceed", the
 *  `consented` case). One map instead of hand-written `if`/`if` chains, so
 *  `runDoctor` cannot fall past every check into the probe for a state
 *  nobody handled — `consentStateInfo` fails closed on anything not listed
 *  here rather than defaulting to "proceed". */
const CONSENT_STATE_INFO = {
  consented: {
    statusText: 'reporting',
    doctorStop: null,
  },
  none: {
    statusText: 'logged in but not consented this install — run `cofleet login` to resume',
    doctorStop: {
      exitCode: 1,
      lines: [
        `  reporting:  FAIL — credential found but this install has not consented (marker missing).`,
        `              Run \`cofleet login\` to resume.`,
      ],
    },
  },
  // Aggregate path only (no CLAUDE_PLUGIN_DATA, more than one witnessed
  // install): some have consented and some have not, and this shell cannot
  // tell which install it is actually sitting in. Distinct from `none` (no
  // witnessed install has consented — `login` will fix all of them) and from
  // `unknown` (no witnessed install at all) — collapsing this into either
  // would either wrongly say "reporting" for the person's own harness some
  // of the time, or wrongly say nothing has consented when something has.
  mixed: {
    statusText:
      'logged in — consented on some installs on this machine but not all; run `cofleet status` inside the agent session to check this one, or `cofleet login` here to cover every install',
    doctorStop: {
      exitCode: 1,
      lines: [
        `  reporting:  FAIL — consented on some installs on this machine, but this shell cannot tell which install it is.`,
        `              Run \`cofleet doctor\` inside the agent session to check this one, or \`cofleet login\` here to cover every install.`,
      ],
    },
  },
  unknown: {
    statusText:
      'logged in — cannot verify consent from this shell; start a Claude Code session, then run `cofleet login` again',
    doctorStop: {
      exitCode: 1,
      lines: [
        `  reporting:  UNKNOWN — cannot verify consent from this shell (no CLAUDE_PLUGIN_DATA yet).`,
        `              Start a Claude Code session here, then run \`cofleet doctor\` again.`,
      ],
    },
  },
};

/** Fail-closed lookup: any `consentState` result not in the map above (there
 *  should never be one — `consentState` itself is total over the same four
 *  values) reads as "not reporting", never as "proceed to the probe". */
function consentStateInfo(state) {
  return (
    CONSENT_STATE_INFO[state] ?? {
      statusText: 'logged in but not consented this install — run `cofleet login` to resume',
      doctorStop: {
        exitCode: 1,
        lines: [`  reporting:  FAIL — unrecognised consent state.`],
      },
    }
  );
}

/** Probe the real endpoint with a DELIBERATELY invalid body.
 *
 *  The route authenticates before it validates, so a 400 proves the host is
 *  reachable, the endpoint exists, and the credential was accepted — while
 *  writing nothing. A well-formed probe would work too, and would put a junk
 *  session on the team's wall every time someone ran this. */
async function runDoctor() {
  const selectedBaseUrl = baseUrl();
  const lines = [
    `Cofleet plugin`,
    `  server:     ${selectedBaseUrl}`,
    `  data dir:   ${stableOriginDataDir(selectedBaseUrl)}`,
  ];
  const foreignNotice = foreignPluginDataLine(selectedBaseUrl);
  if (foreignNotice) lines.push(`  note:       ${foreignNotice}`);
  lines.push(`  credential: ${describeCredential()}`);

  const token = await currentToken();
  if (!token) {
    lines.push(``, `Run \`cofleet login\` to authorise this machine.`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 1;
  }

  // The credential-without-marker state (a reinstall found a surviving
  // credential): the hook stays silent, so doctor must not claim reporting
  // works. `unknown` — this shell has no CLAUDE_PLUGIN_DATA and no witness
  // yet to resolve the marker's location through — is a distinct state: it
  // is not proof consent is missing, only that this shell cannot see it, so
  // it must not be reported as FAIL either.
  const resolved = resolveToken(selectedBaseUrl);
  if (resolved.source !== '$COFLEET_TOKEN') {
    const { doctorStop } = consentStateInfo(consentState(selectedBaseUrl));
    if (doctorStop) {
      lines.push(...doctorStop.lines);
      process.stdout.write(`${lines.join('\n')}\n`);
      return doctorStop.exitCode;
    }
  }

  let response;
  try {
    response = await post({}, token, DOCTOR_TIMEOUT_MS);
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'timed out' : 'could not be reached';
    lines.push(`  reporting:  FAIL — ${selectedBaseUrl} ${reason}.`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 1;
  }

  const [level, explanation] = DIAGNOSIS[response.status] ?? [
    'fail',
    `Unexpected response. Nothing is being recorded.`,
  ];
  const label = level === 'ok' ? 'OK' : level === 'warn' ? 'WARN' : 'FAIL';
  lines.push(`  reporting:  ${label} (HTTP ${response.status}) — ${explanation}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return level === 'fail' ? 1 : 0;
}

function describeCredential() {
  const { token, source, kind, credentials } = resolveToken();
  if (!token) return 'MISSING — run `cofleet login`';
  if (kind !== 'oauth') return `static token (from ${source})`;
  const remaining = credentials.expiresAt - Date.now();
  const state =
    remaining > 0 ? `expires in ${Math.round(remaining / 60_000)}m` : 'expired, refreshes on next use';
  return `OAuth (from ${source}, ${state})`;
}

/** No credential at all, a credential this install has not consented for
 *  (post-reinstall), a credential whose consent this shell simply cannot
 *  verify yet (no CLAUDE_PLUGIN_DATA and no witness), reporting, and — on a
 *  machine with more than one witnessed install — the `mixed` state where
 *  only some of them have consented (see `CONSENT_STATE_INFO`).
 *  $COFLEET_TOKEN is exempt from the marker gate entirely — see the
 *  exemption below. */
function describeReportingState(url = configuredBaseUrl()) {
  const resolved = resolveToken(url);
  if (!resolved.token) return 'not logged in';
  if (resolved.source === '$COFLEET_TOKEN') return 'reporting';
  return consentStateInfo(consentState(url)).statusText;
}

function runStatus() {
  const selectedBaseUrl = baseUrl();
  const foreignNotice = foreignPluginDataLine(selectedBaseUrl);
  process.stdout.write(
    `Cofleet plugin\n` +
      `  server:     ${selectedBaseUrl}\n` +
      `  data dir:   ${stableOriginDataDir(selectedBaseUrl)}\n` +
      (foreignNotice ? `  note:       ${foreignNotice}\n` : '') +
      `  credential: ${describeCredential()}\n` +
      `  status:     ${describeReportingState(selectedBaseUrl)}\n`,
  );
}

/** Sweep every credential path for the selected origin — not one file. Also
 *  clears the marker for every install this origin has a trustworthy witness
 *  for, plus (when CLAUDE_PLUGIN_DATA identifies one directly) this shell's
 *  own — symmetric with `login`'s "act on every install" behavior, so a
 *  logout run from one harness does not leave another harness on the same
 *  machine still consented. Also clears every witness entry itself (both the
 *  current per-install layout and the single legacy file), so a stale
 *  consent record never outlives its credential and a later `status` never
 *  misreads a leftover witness, plus any leftover marker from a build that
 *  predates the witness entirely. Collects failures instead of aborting the
 *  sweep on the first one: a non-ENOENT error (EACCES/EPERM/EROFS) on an
 *  early candidate must not leave every later candidate untouched.
 *  Idempotent: a second run finds nothing and exits 0 having removed
 *  nothing. */
async function runLogout() {
  const selectedBaseUrl = baseUrl();
  const markerDirs = [];
  const direct = resolveMarkerDir(selectedBaseUrl);
  if (direct) markerDirs.push(direct);
  for (const dir of witnessedDataDirs(selectedBaseUrl)) {
    if (!markerDirs.includes(dir)) markerDirs.push(dir);
  }
  const candidates = [
    ...credentialsCandidates(selectedBaseUrl),
    ...tokenCandidates(selectedBaseUrl),
    ...markerDirs.map((dir) => join(dir, MARKER_FILENAME)),
    ...witnessEntryFiles(selectedBaseUrl),
    witnessPath(selectedBaseUrl),
    legacyPendingMarkerPath(selectedBaseUrl),
  ];
  const removed = [];
  const failures = [];
  for (const path of candidates) {
    try {
      unlinkSync(path);
      removed.push(path);
    } catch (err) {
      if (!err || err.code === 'ENOENT') continue;
      failures.push({ path, code: err.code ?? 'UNKNOWN' });
    }
  }
  if (removed.length === 0 && failures.length === 0) {
    process.stdout.write('Nothing was stored for this origin.\n');
    return 0;
  }
  for (const path of removed) process.stdout.write(`Removed ${path}\n`);
  for (const { path, code } of failures) process.stdout.write(`Could not remove ${path}: ${code}\n`);
  // Server-side revocation is a follow-up (RFC 7009); this only clears what
  // is stored locally.
  return failures.length > 0 ? 1 : 0;
}

// ---------- entry ----------

/** Only `login`/`logout`/`doctor` ever reach here — the hook path's own
 *  `.catch(() => {})` is untouched, per the contract at the top of this file.
 *
 *  Every one of those three commands used to fall back to a bare `.catch(()
 *  => 1)`: a permission/sandbox denial (a blocked outbound HTTPS call, a
 *  blocked loopback bind, a blocked write under `~/.cofleet`) throws or
 *  rejects instead of returning a handled `{ ok: false, reason }`, and that
 *  fell straight through to `exit 1` with nothing printed anywhere —
 *  confirmed empirically: `cofleet login` under a network-denying sandbox
 *  (macOS `sandbox-exec` with `deny network*`) prints literally nothing and
 *  exits 1, and the static-token branch does the same under a filesystem
 *  write denial. Indistinguishable from a real bug and from `login`
 *  succeeding-then-crashing. Print what actually went wrong so a restricted
 *  agent session can ask for the specific permission instead of guessing.
 *
 *  Never a token or credential: everything that reaches this catch is a
 *  Node/fetch/fs error message (ENOENT, EPERM, "fetch failed", a bare path)
 *  or one of this file's own thrown `Error` messages, none of which embed
 *  secret material — `runLogin`'s success path prints the token deliberately
 *  elsewhere, but nothing on this failure path ever holds one. */
function reportUnexpectedFailure(command, error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `cofleet ${command} failed unexpectedly: ${message}\n` +
      `If this is a sandboxed or restricted session, it may need network and/or ` +
      `filesystem permission for this command — see the cofleet-presence skill.\n`,
  );
}

// Only when this file is the process entry point (always true under the
// `cofleet` shell shim) — never when a test imports it to drive the exported
// functions directly, which must not also run the CLI and call
// `process.exit`.
async function main() {
  const command = process.argv[2];

  // ONLY `doctor`, `login`, and `logout` may ever make this non-zero. The hook path exits 0
  // no matter what — see the contract at the top of this file.
  let exitCode = 0;

  try {
    if (command === 'login') {
      exitCode = await runLogin(process.argv[3]).catch((error) => {
        reportUnexpectedFailure('login', error);
        return 1;
      });
    } else if (command === 'logout') {
      exitCode = await runLogout().catch((error) => {
        reportUnexpectedFailure('logout', error);
        return 1;
      });
    } else if (command === 'status') {
      runStatus();
    } else if (command === 'doctor') {
      exitCode = await runDoctor().catch((error) => {
        reportUnexpectedFailure('doctor', error);
        return 1;
      });
    } else {
      // Every failure inside the hook path is swallowed on purpose.
      await runHook().catch(() => {});
    }
  } catch {
    // Unreachable in practice; the belt to runHook's braces.
  }

  process.exit(exitCode);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
