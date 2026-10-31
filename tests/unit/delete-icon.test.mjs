// The trash cans' wording (src/extension/delete-icon.ts): Uninstall for a
// script its source can give back, Delete for one whose stored text is
// its only copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { removalVerb, removeScriptTitle } from '../../dist/extension/delete-icon.js';
import { importedUrl, scratchUrl } from '../../dist/extension/location-kinds.js';

test('a script with a source to reinstall from is uninstalled', () => {
  for (const url of ['https://example.com/a.user.js', 'file:///home/me/a.user.js', '/home/me/a.user.js']) {
    assert.equal(removalVerb(url), 'Uninstall');
  }
  assert.equal(removeScriptTitle('https://example.com/a.user.js'), 'Uninstall this script');
  assert.equal(removeScriptTitle('https://example.com/a.user.js', true), 'Uninstall this version of this script');
});

test('an imported or scratch script is deleted', () => {
  for (const url of [importedUrl('a.user.js'), scratchUrl('run1', 'a.user.js')]) {
    assert.equal(removalVerb(url), 'Delete');
    assert.equal(removeScriptTitle(url), 'Delete this script');
    assert.equal(removeScriptTitle(url, true), 'Delete this version of this script');
  }
});
