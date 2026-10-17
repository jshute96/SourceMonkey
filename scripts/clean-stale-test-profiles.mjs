// Remove temp dirs left behind by test runs that didn't shut down cleanly.
//
// The fixtures remove their own `mkdtemp` dirs on teardown, but a run
// that is killed — or whose browser segfaults, which this suite still
// does — never gets there. They accumulate at a few MB each, and an
// orphaned browser still holding one keeps burning CPU.
//
// Best-effort by design: this is a janitor, not a gate. Any failure is
// swallowed so it can never stop someone running the tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Chromium profiles, checked for liveness before removal: the launcher's
// (src/harness/extension-launch.ts, which an sm-dev run's temp browser
// shares, kept while its browser is live) and the older e2e name. The
// data prefixes are plain dirs with no process attached, where age alone
// is a sufficient signal:
// - ScriptsDir and its `sm-parent-` variants.
// - The harness tests' runs dirs (`SM_DEV_RUNS_DIR`). Not under
//   `sm-dev-runs-`, which the real `sm-dev-runs-<user>` would match.
// - browser-launch.spec.ts's dirs. Its config dirs hold an
//   --open-browser profile one level down, which `liveNestedProfile`
//   checks, since a killed test leaves that browser running.
const PROFILE_PREFIXES = ['sm-dev-extension-', 'sourcemonkey-test-'];
const DATA_PREFIXES = ['sourcemonkey-scripts-', 'sm-parent-', 'sm-test-runs-', 'sm-dev-launch-'];

// Long enough that a dir belonging to a run starting right now in
// another checkout is never a candidate, short enough to keep /tmp from
// filling up over a day's work. Only a backstop for the data dirs — for
// profiles, `isLiveProfile` is what actually answers the question.
const MAX_AGE_MS = 60 * 60 * 1000;

// Is a Chromium still using this profile? Chromium writes
// `SingletonLock` as a symlink to `<hostname>-<pid>` and leaves it for
// as long as it runs. Directory mtime cannot answer this: it only bumps
// when an entry is added or removed in the directory ITSELF, and a
// running browser does essentially all its writing inside `Default/`,
// so a live profile's top-level mtime freezes at launch.
function isLiveProfile(dir) {
  let target;
  try {
    target = fs.readlinkSync(path.join(dir, 'SingletonLock'));
  } catch {
    return false;                       // no lock — nothing is holding it
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  if (!Number.isInteger(pid) || pid <= 0) return true;   // unreadable: assume live
  try {
    process.kill(pid, 0);
    return true;                        // the process is there
  } catch (err) {
    return err.code === 'EPERM';        // exists but isn't ours — still live
  }
}

// Is a Chromium still using an --open-browser profile in this config dir
// (`<dir>/sm-dev/browser-profile-<port>`)?
function liveNestedProfile(dir) {
  let names;
  try {
    names = fs.readdirSync(path.join(dir, 'sm-dev'));
  } catch {
    return false;
  }
  return names.some((n) => n.startsWith('browser-profile-') && isLiveProfile(path.join(dir, 'sm-dev', n)));
}

function sweep() {
  const tmp = os.tmpdir();
  const now = Date.now();
  let removed = 0;

  for (const name of fs.readdirSync(tmp)) {
    const isProfile = PROFILE_PREFIXES.some((p) => name.startsWith(p));
    const isData = DATA_PREFIXES.some((p) => name.startsWith(p));
    if (!isProfile && !isData) continue;

    const dir = path.join(tmp, name);
    try {
      // lstat, not stat: a symlink planted under one of our prefixes
      // should be unlinked, never followed and walked.
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory()) {
        fs.rmSync(dir, { force: true });
        continue;
      }
      if (isProfile && isLiveProfile(dir)) continue;
      if (name.startsWith('sm-dev-launch-') && liveNestedProfile(dir)) continue;
      if (now - stat.mtimeMs < MAX_AGE_MS) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone underneath us, or not ours to remove. Next run will retry.
    }
  }
  return removed;
}

try {
  const removed = sweep();
  if (removed > 0) {
    console.log(`[clean] removed ${removed} stale test ${removed === 1 ? 'dir' : 'dirs'}`);
  }
} catch {
  // Nothing here is worth failing a test run over.
}
