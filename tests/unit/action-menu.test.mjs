// Tests for src/action-menu.ts (compiled to dist/action-menu.js).
//
// Pure layout planner: packs script + nested-menu-command groups into
// the 6-item action context-menu cap, spilling any overflow into a
// "More" submenu. Each group (script row + its commands) is kept
// together so the user never sees a script's commands orphaned from
// the row they belong to.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_MENU_LIMIT,
  planActionMenu,
} from '../../dist/action-menu.js';

function mkGroup(scriptId, commandCount) {
  return {
    scriptId,
    title: `${scriptId} | OK`,
    commands: Array.from({ length: commandCount }, (_, i) => ({
      commandId: `${scriptId}-cmd-${i}`,
      title: `${scriptId} cmd ${i}`,
    })),
  };
}

test('limit constant matches Chrome behavior', () => {
  // 6 is the number Chrome itself auto-collapses past — pinning the
  // constant in a test means any drift requires updating the test too.
  assert.equal(ACTION_MENU_LIMIT, 6);
});

test('empty input → empty top, no overflow', () => {
  const plan = planActionMenu([]);
  assert.deepEqual(plan.top, []);
  assert.deepEqual(plan.more, []);
});

test('total cost <= 6 → everything top-level, no More', () => {
  const groups = [mkGroup('a', 0), mkGroup('b', 1), mkGroup('c', 0)];
  const plan = planActionMenu(groups);
  // 1 + 2 + 1 = 4 rows total, well under the cap.
  assert.equal(plan.top.length, 3);
  assert.deepEqual(plan.more, []);
});

test('exactly 6 rows fits without overflow', () => {
  const groups = [mkGroup('a', 2), mkGroup('b', 1), mkGroup('c', 0)];
  // 3 + 2 + 1 = 6 — boundary; should not need More.
  const plan = planActionMenu(groups);
  assert.equal(plan.top.length, 3);
  assert.deepEqual(plan.more, []);
});

test('7 rows triggers More, one of six top slots reserved for the parent', () => {
  const groups = [mkGroup('a', 6)];
  // Single group of cost 7 cannot fit in the 5-slot top budget (6 - 1
  // for More), so it all goes into More.
  const plan = planActionMenu(groups);
  assert.equal(plan.top.length, 0);
  assert.equal(plan.more.length, 1);
  assert.equal(plan.more[0].scriptId, 'a');
});

test('split groups keep the early ones top-level, late ones in More', () => {
  // Costs: 3, 2, 2  = 7 → overflow needed; budget = 5.
  // a (3) fits, b (2) fits exactly to 5 used; c (2) spills to More.
  const groups = [mkGroup('a', 2), mkGroup('b', 1), mkGroup('c', 1)];
  const plan = planActionMenu(groups);
  assert.deepEqual(plan.top.map((g) => g.scriptId), ['a', 'b']);
  assert.deepEqual(plan.more.map((g) => g.scriptId), ['c']);
});

test('once a group spills, later groups stay in More even if they would fit', () => {
  // If we kept packing after the first spill, a small late group could
  // jump ahead of a big earlier one — scrambling visible order. Costs:
  // 4, 3, 1 = 8. budget=5. a (4) fits; b (3) would exceed 5, spills;
  // c (1) would technically still fit in the leftover top slot but
  // MUST also spill to preserve order.
  const groups = [mkGroup('a', 3), mkGroup('b', 2), mkGroup('c', 0)];
  const plan = planActionMenu(groups);
  assert.deepEqual(plan.top.map((g) => g.scriptId), ['a']);
  assert.deepEqual(plan.more.map((g) => g.scriptId), ['b', 'c']);
});

test('a single oversized group spills entirely into More', () => {
  // 11-row group can't fit anywhere top-level; it lives wholly in
  // More (which has no item cap of its own).
  const groups = [mkGroup('big', 10)];
  const plan = planActionMenu(groups);
  assert.deepEqual(plan.top, []);
  assert.equal(plan.more.length, 1);
  assert.equal(plan.more[0].commands.length, 10);
});

test('input array is not mutated', () => {
  const groups = [mkGroup('a', 2), mkGroup('b', 4)];
  const snapshot = JSON.parse(JSON.stringify(groups));
  planActionMenu(groups);
  assert.deepEqual(groups, snapshot);
});

test('errored flag passes through unchanged for top and More groups', () => {
  // The dispatcher uses `errored` at click time to decide whether to
  // route to the Log tab. Both packing paths (top + More) must
  // preserve it so a row that overflows into the submenu still routes
  // correctly when clicked.
  const a = { ...mkGroup('a', 0), errored: true };
  const b = { ...mkGroup('b', 0), errored: false };
  const c = { ...mkGroup('c', 0), errored: true };
  const groups = [a, b, c, mkGroup('d', 0), mkGroup('e', 0), mkGroup('f', 0), mkGroup('g', 0)];
  const plan = planActionMenu(groups);
  const all = [...plan.top, ...plan.more];
  assert.equal(all.find((g) => g.scriptId === 'a').errored, true);
  assert.equal(all.find((g) => g.scriptId === 'b').errored, false);
  assert.equal(all.find((g) => g.scriptId === 'c').errored, true);
});
