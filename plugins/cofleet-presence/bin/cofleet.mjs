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
//      carries whole commands. Only `file_path` is read out; the rest is
//      dropped on the floor and never leaves the machine.
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
//   records that install's plugin-data origin directory into a small file in
//   the stable root — `~/.cofleet/origins/<key>/plugin-data-dir`. `login`,
//   `status`, `doctor`, and `logout` all resolve the marker's location the
//   same way: CLAUDE_PLUGIN_DATA when set, else the witnessed directory *only
//   if it still exists* (never created — that would fabricate consent for an
//   install that is not there). With neither, the state is unknown, not
//   "not consented": `login` records no marker and asks for a hook to run
//   first; `status`/`doctor` say plainly that they cannot see it from this
//   shell instead of asserting a negative.
//
//   The gate does not apply to $COFLEET_TOKEN: that is an operator-supplied
//   process override (CI, a server with OAuth off), not an interactive login
//   tied to any particular install.

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
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

export function originDataDirs(url = configuredBaseUrl()) {
  const key = originKey(url);
  const dirs = [];
  const pluginData = envSelection(process.env, 'CLAUDE_PLUGIN_DATA');
  if (pluginData) dirs.push(join(pluginData, 'origins', key));
  const stable = join(stableDataRoot(), 'origins', key);
  if (!dirs.includes(stable)) dirs.push(stable);
  return dirs;
}

function stableOriginDataDir(url = configuredBaseUrl()) {
  return join(stableDataRoot(), 'origins', originKey(url));
}

function legacyDataRoots() {
  const roots = [];
  const pluginData = envSelection(process.env, 'CLAUDE_PLUGIN_DATA');
  if (pluginData) roots.push(pluginData);
  const stable = stableDataRoot();
  if (!roots.includes(stable)) roots.push(stable);
  return roots;
}

function isProduction(url = configuredBaseUrl()) {
  return url === PRODUCTION_BASE_URL;
}

const MARKER_FILENAME = 'consented';
const WITNESS_FILENAME = 'plugin-data-dir';
/** Written by a build that predates the witness. No longer read for
 *  anything — `logout` sweeps it up as garbage; nothing else looks at it. */
const LEGACY_PENDING_MARKER_FILENAME = 'consent-pending';

function witnessPath(url = configuredBaseUrl()) {
  return join(stableOriginDataDir(url), WITNESS_FILENAME);
}

function legacyPendingMarkerPath(url = configuredBaseUrl()) {
  return join(stableOriginDataDir(url), LEGACY_PENDING_MARKER_FILENAME);
}

/** Record which plugin-data origin directory the current install uses, so a
 *  later non-hook process (a terminal `login`/`status`/`doctor`/`logout`)
 *  can find it without CLAUDE_PLUGIN_DATA. Called on every hook run — the
 *  only path guaranteed to have the env var. Writes only when the content
 *  differs, and never lets a failure escape: a hook must never disrupt a
 *  session over a diagnostic file. */
function writeWitness(url = configuredBaseUrl()) {
  const pluginData = envSelection(process.env, 'CLAUDE_PLUGIN_DATA');
  if (!pluginData) return;
  const dir = originDataDirs(url)[0];
  try {
    // The directory itself is what `login`'s fallback checks for existence
    // (see `witnessedDataDir`). Creating it here is not fabricating consent
    // — CLAUDE_PLUGIN_DATA being set is the platform's own proof this install
    // is really present, and this hook run is real evidence of that, not a
    // guess. `login` still never creates it on its own — see there.
    mkdirSync(dir, { recursive: true });
    const path = witnessPath(url);
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

/** The witnessed plugin-data origin directory, but only when it still
 *  exists AND is trustworthy. A directory the witness remembers but that is
 *  gone (or was never there, or fails validation) must never be treated as
 *  this install's marker location — that would fabricate consent for an
 *  install that is not present, or write through content an attacker
 *  supplied. */
function witnessedDataDir(url = configuredBaseUrl()) {
  try {
    const dir = readFileSync(witnessPath(url), 'utf8').trim();
    if (!dir) return null;
    return isTrustedWitnessTarget(dir, url) ? dir : null;
  } catch {
    return null;
  }
}

/** Where the install-generation marker lives, resolved the same way by every
 *  caller: CLAUDE_PLUGIN_DATA when set (always true under a hook) AND its
 *  root still really there, otherwise the witnessed directory if it still
 *  exists. Null means neither source is available — the marker's location
 *  is unknown from here, not "absent". The CLAUDE_PLUGIN_DATA root check
 *  matters because `mkdirSync` downstream would otherwise resurrect a wiped
 *  install directory just to write a marker into it. */
function resolveMarkerDir(url = configuredBaseUrl()) {
  const pluginData = envSelection(process.env, 'CLAUDE_PLUGIN_DATA');
  if (pluginData) {
    let stat;
    try {
      stat = lstatSync(pluginData);
    } catch {
      return null;
    }
    if (!isRealDirectory(stat)) return null;
    return originDataDirs(url)[0];
  }
  return witnessedDataDir(url);
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

/** The half of `writeConsentMarker` that runs *before* the racy `mkdirSync`:
 *  resolves the marker directory and captures the plugin-data root's
 *  identity while it is still trusted to exist. Returns `null` when the
 *  location cannot be resolved, or when the root is confirmed gone the
 *  instant before we would touch the filesystem — the tightest form of the
 *  race, caught before any write is attempted. Split out from
 *  `commitConsentMarker` so a test can deterministically land an uninstall
 *  in between the two, the same window an unlucky real one could land in. */
export function prepareConsentMarker(url = configuredBaseUrl()) {
  const dir = resolveMarkerDir(url);
  if (!dir) return null;

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

/** Record consent for a successful login. See `prepareConsentMarker` and
 *  `commitConsentMarker` for what each half does and why; `'unresolved'`
 *  (no CLAUDE_PLUGIN_DATA and no usable witness yet, or the root already
 *  gone) is not the same problem as a `'refused'` write — it is the
 *  permanent state of a headless box that will never run a hook here, and
 *  `runLogin`'s static-token form has an operator-supplied way around it. */
function writeConsentMarker(url = configuredBaseUrl()) {
  const prepared = prepareConsentMarker(url);
  if (!prepared) return 'unresolved';
  return commitConsentMarker(prepared);
}

/** The hook gate: true only when CLAUDE_PLUGIN_DATA is set AND the marker
 *  exists in that exact directory. Hooks never consult the witness for this
 *  — they are the ones that write it, and always have the env var. */
function hasConsentMarker(url = configuredBaseUrl()) {
  if (!envSelection(process.env, 'CLAUDE_PLUGIN_DATA')) return false;
  try {
    return lstatSync(join(originDataDirs(url)[0], MARKER_FILENAME)).isFile();
  } catch {
    return false;
  }
}

/** For `status`/`doctor`/`logout`, which may run from a terminal with no
 *  CLAUDE_PLUGIN_DATA: `'consented'` and `'none'` are both resolved answers
 *  (the marker directory is known, present or not); `'unknown'` means this
 *  shell cannot see it at all yet — no env var and no witness. */
function consentState(url = configuredBaseUrl()) {
  const dir = resolveMarkerDir(url);
  if (!dir) return 'unknown';
  try {
    return lstatSync(join(dir, MARKER_FILENAME)).isFile() ? 'consented' : 'none';
  } catch {
    return 'none';
  }
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
  return join(originDataDirs()[0], 'sessions', `${safe}.json`);
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

  const body = { sessionId, harness: 'claude_code' };
  let force = false;

  if (event === 'SessionStart') {
    // No prompt has been typed yet, so the directory is the most honest title
    // available. The first UserPromptSubmit replaces it.
    body.title = cleanTitle(basename(cwd));
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
    const rel = repoRelative(cwd, payload.tool_input?.file_path);
    if (rel && !state.pending.includes(rel)) {
      state.pending = [...state.pending, rel].slice(-MAX_PENDING_PATHS);
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

  if (argument) {
    const token = argument.trim();
    const path = tokenPath(selectedBaseUrl);
    writePrivateFile(path, `${token}\n`);
    const consentResult = writeConsentMarker(selectedBaseUrl);
    process.stdout.write(`Saved a static token.\n`);
    if (consentResult === 'unresolved') {
      process.stdout.write(operatorTokenMessage(token));
      return 0;
    }
    if (consentResult === 'refused') {
      process.stdout.write(MARKER_REFUSED_MESSAGE);
      return 1;
    }
    process.stdout.write(`Work sessions will report to ${selectedBaseUrl}.\n`);
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
  if (consentResult !== 'ok') {
    // The interactive OAuth branch keeps exit 1 either way (unresolved or
    // refused): it always runs inside a Claude Code session with a human at
    // the keyboard, so there is no headless-box case to route around here.
    process.stdout.write(NO_MARKER_TARGET_MESSAGE);
    return 1;
  }
  process.stdout.write(`Work sessions will report to ${selectedBaseUrl}.\n`);
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

/** The three `consentState` answers, each carrying everything both readers
 *  need: the short phrase `status`/`doctor`'s one-liner uses, and — for
 *  `doctor` only — the extra diagnostic lines and exit code to stop on
 *  rather than proceeding to the live probe (`null` means "proceed", the
 *  `consented` case). One map instead of two hand-written `if`/`if` chains,
 *  so `runDoctor` cannot fall past both checks into the probe for a state
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
 *  should never be one — `consentState` itself is total over the same three
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

/** The four states a person can act on: no credential at all, a credential
 *  this install has not consented for (post-reinstall), a credential whose
 *  consent this shell simply cannot verify yet (no CLAUDE_PLUGIN_DATA and no
 *  witness), and reporting. $COFLEET_TOKEN is exempt from the marker gate
 *  entirely — see the exemption below. */
function describeReportingState(url = configuredBaseUrl()) {
  const resolved = resolveToken(url);
  if (!resolved.token) return 'not logged in';
  if (resolved.source === '$COFLEET_TOKEN') return 'reporting';
  return consentStateInfo(consentState(url)).statusText;
}

function runStatus() {
  const selectedBaseUrl = baseUrl();
  process.stdout.write(
    `Cofleet plugin\n` +
      `  server:     ${selectedBaseUrl}\n` +
      `  data dir:   ${stableOriginDataDir(selectedBaseUrl)}\n` +
      `  credential: ${describeCredential()}\n` +
      `  status:     ${describeReportingState(selectedBaseUrl)}\n`,
  );
}

/** Sweep every credential path for the selected origin — not one file. Also
 *  clears the marker (resolved the same way every other reader resolves it)
 *  and the witness, so a stale consent record never outlives its credential,
 *  plus any leftover marker from a build that predates the witness. Collects
 *  failures instead of aborting the sweep on the first one: a non-ENOENT
 *  error (EACCES/EPERM/EROFS) on an early candidate must not leave every
 *  later candidate untouched. Idempotent: a second run finds nothing and
 *  exits 0 having removed nothing. */
async function runLogout() {
  const selectedBaseUrl = baseUrl();
  const markerDir = resolveMarkerDir(selectedBaseUrl);
  const candidates = [
    ...credentialsCandidates(selectedBaseUrl),
    ...tokenCandidates(selectedBaseUrl),
    ...(markerDir ? [join(markerDir, MARKER_FILENAME)] : []),
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
      exitCode = await runLogin(process.argv[3]).catch(() => 1);
    } else if (command === 'logout') {
      exitCode = await runLogout().catch(() => 1);
    } else if (command === 'status') {
      runStatus();
    } else if (command === 'doctor') {
      exitCode = await runDoctor().catch(() => 1);
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
