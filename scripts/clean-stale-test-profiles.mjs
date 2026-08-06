// Remove temp dirs left behind by e2e runs that didn't shut down cleanly.
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

// Chromium profiles, checked for liveness before removal. The other two
// are plain data dirs (ScriptsDir and its `sm-parent-` variants) with no
// process attached, where age alone is a sufficient signal.
const PROFILE_PREFIX = 'sourcemonkey-test-';
const DATA_PREFIXES = ['sourcemonkey-scripts-', 'sm-parent-'];

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

function sweep() {
  const tmp = os.tmpdir();
  const now = Date.now();
  let removed = 0;

  for (const name of fs.readdirSync(tmp)) {
    const isProfile = name.startsWith(PROFILE_PREFIX);
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
