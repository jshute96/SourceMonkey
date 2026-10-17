// snapshot's helpers: which refs a word names, and which lines of a
// tree with boxes show on screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { framePaths, onScreen, refLabels, refOf, tidy, topRefs, treeParts, withoutDocument } from '../../../lib/harness/snapshot.js';

test('a whole page\'s tree goes without its document line, a level less indented', () => {
  const tree = [
    '- document [ref=e9]:',
    '  - generic [active] [ref=e1]:',
    '    - button "Save" [ref=e2]',
    '  - button "Panel" [ref=e3]',
  ].join('\n');
  assert.equal(withoutDocument(tree), [
    '- generic [active] [ref=e1]:',
    '  - button "Save" [ref=e2]',
    '- button "Panel" [ref=e3]',
  ].join('\n'));
  // Anything else stays as it is.
  for (const other of ['- generic [ref=e1]:\n  - button "a" [ref=e2]', '- document [ref=e1]']) assert.equal(withoutDocument(other), other);
});

test('a ref is e4, f3e2, ref=e4 or [ref=e4], and nothing else is', () => {
  assert.equal(refOf('e4'), 'e4');
  assert.equal(refOf('f1e2'), 'f1e2');
  assert.equal(refOf('ref=e4'), 'e4');
  assert.equal(refOf('[ref=e4]'), 'e4');
  for (const selector of ['#e4', 'e', 'button', '[ref=x]', 'e4 > a']) assert.equal(refOf(selector), null);
});

test('only lines on screen stay, with the lines they are under, and without boxes', () => {
  const tree = [
    '- generic [ref=e1] [box=0,0,800,4000]:',
    '  - main [ref=e2] [box=0,0,800,4000]:',
    '    - button "Near" [ref=e3] [box=10,10,50,20]',
    '    - link "Far" [ref=e4] [box=10,3000,50,20]:',
    '      - /url: /far',
    '    - list [ref=e5] [box=0,2000,800,100]:',
    '      - listitem [ref=e6] [box=0,2000,800,20]: text',
    '    - generic [ref=e7] [box=0,2000,800,10]:',
    '      - button "Fixed" [ref=e8] [box=700,500,50,20]',
    '    - paragraph [ref=e9] [box=0,100,800,20]: text',
  ].join('\n');
  assert.equal(onScreen(tree, 800, 600), [
    '- generic [ref=e1]:',
    '  - main [ref=e2]:',
    '    - button "Near" [ref=e3]',
    '    - generic [ref=e7]:',
    '      - button "Fixed" [ref=e8]',
    '    - paragraph [ref=e9]: text',
  ].join('\n'));
});

test('a frame\'s boxes are from its corner, and only its own box of it shows', () => {
  const tree = [
    '- generic [ref=e1] [box=0,0,800,600]:',
    '  - iframe [ref=e2] [box=100,500,300,50]:',
    '    - button "Top" [ref=f1e1] [box=0,0,50,20]',
    '    - button "Scrolled away" [ref=f1e2] [box=0,200,50,20]',
    '    - button "Below the screen" [ref=f1e3] [box=0,120,50,20]',
  ].join('\n');
  assert.equal(onScreen(tree, 800, 600), [
    '- generic [ref=e1]:',
    '  - iframe [ref=e2]:',
    '    - button "Top" [ref=f1e1]',
  ].join('\n'));
});

test('each ref is noted with the iframes it is in, outermost first', () => {
  const tree = [
    '- generic [ref=f3e1]:',
    '  - iframe [ref=f3e2]:',
    '    - button "In" [ref=f5e1]',
    '    - iframe [ref=f5e2]:',
    '      - button "Deeper" [ref=f6e1]',
    '  - button "Out" [ref=f3e3]',
  ].join('\n');
  assert.deepEqual([...framePaths(tree)], [
    ['f3e1', []], ['f3e2', []], ['f5e1', ['f3e2']], ['f5e2', ['f3e2']],
    ['f6e1', ['f3e2', 'f5e2']], ['f3e3', []],
  ]);
});

test('cursor=pointer goes from links and buttons, quoted or not, and stays elsewhere', () => {
  const tree = [
    '- link "a" [ref=e1] [cursor=pointer]:',
    '- \'link "b: c" [ref=e2] [cursor=pointer]\':',
    '- button "d" [ref=e3] [cursor=pointer]',
    '- generic [ref=e4] [cursor=pointer]: e',
  ].join('\n');
  assert.equal(tidy(tree), [
    '- link "a" [ref=e1]:',
    '- \'link "b: c" [ref=e2]\':',
    '- button "d" [ref=e3]',
    '- generic [ref=e4] [cursor=pointer]: e',
  ].join('\n'));
});

test('a ref is labeled by its role and name, unquoted and cut short', () => {
  const tree = [
    '- generic [ref=f1e1]:',
    '  - link "past" [ref=e5] [cursor=pointer]:',
    "  - 'link \"It''s: here\" [ref=e6]':",
    `  - heading "${'x'.repeat(80)}" [level=1] [ref=e7]`,
  ].join('\n');
  const labels = refLabels(tree);
  assert.equal(labels.get('f1e1'), 'generic');
  assert.equal(labels.get('e5'), 'link "past"');
  assert.equal(labels.get('e6'), 'link "It\'s: here"');
  assert.equal(labels.get('e7'), `heading "${'x'.repeat(51)}…`);
});

test('--find shows the elements that say the text, not ones whose role or attributes do', () => {
  const tree = [
    '- main [ref=e1]:',
    '  - generic [ref=e2]:',
    '    - generic [ref=e3]:',
    '      - link "Liked  Songs" [ref=e4]:',
    '        - /url: /collection/tracks',
    '      - text: 12 songs',
    '  - list [ref=e5]:',
    '    - listitem [ref=e6]: Discover Weekly',
    '    - \'button "Play: songs" [ref=e7]\'',
    '    - button "Other" [ref=e8]',
    '    - button "Save [draft]" [ref=e9]',
  ].join('\n');
  const find = (text) => treeParts(tree, { text });
  // A link's name, its /url, any case and spacing; a text line stands for its element.
  assert.deepEqual(find('liked songs'), ['- link "Liked  Songs" [ref=e4]:\n  - /url: /collection/tracks']);
  assert.deepEqual(find('/collection'), ['- link "Liked  Songs" [ref=e4]:\n  - /url: /collection/tracks']);
  assert.equal(find('12 songs')[0].split('\n')[0], '- generic [ref=e3]:');
  assert.deepEqual(find('play: songs'), ['- \'button "Play: songs" [ref=e7]\'']);
  assert.deepEqual(find('button'), []);
  assert.deepEqual(find('ref=e4'), []);
  assert.deepEqual(find('[draft]'), ['- button "Save [draft]" [ref=e9]']);
  // A match inside another's part shows once.
  assert.equal(find('songs').length, 2);
  // Within a selector's matches only.
  assert.deepEqual(treeParts(tree, { text: 'songs', matches: [['e5']] }), ['- \'button "Play: songs" [ref=e7]\'']);
});

test('a selector shows each of its matches in the tree, and those it can\'t find go', () => {
  const tree = [
    '- list [ref=e1]:',
    '  - listitem [ref=e2]: One',
    '  - listitem [ref=e3]: Two',
    '- generic [ref=e4]:',
    '  - button "A" [ref=e5]',
    '  - button "B" [ref=e6]',
  ].join('\n');
  assert.deepEqual(treeParts(tree, { matches: [['e2'], ['e3'], ['e9']] }), ['- listitem [ref=e2]: One', '- listitem [ref=e3]: Two']);
  // A match the tree leaves out itself is its children together.
  assert.deepEqual(treeParts(tree, { matches: [['e5', 'e6']] }), ['- button "A" [ref=e5]\n- button "B" [ref=e6]']);
  // Matches inside another show once, in it.
  assert.equal(treeParts(tree, { matches: [['e2'], ['e3']], up: 1 }).length, 1);
  assert.deepEqual(topRefs('- generic [ref=e2]:\n  - link "x" [ref=e3]'), ['e2']);
  assert.deepEqual(topRefs('- link "a" [ref=e3]\n- text: b\n- link "c" [ref=e4]'), ['e3', 'e4']);
});

test('--find goes --up levels, and with --context, up through what adds few lines', () => {
  const tree = [
    '- main [ref=e1]:',
    ...Array.from({ length: 20 }, (_, i) => `  - paragraph [ref=p${i}]: filler ${i}`),
    '  - generic [ref=e2]:',
    '    - generic [ref=e3]:',
    '      - heading "Title" [ref=e4]',
    '      - text: by someone',
  ].join('\n');
  assert.equal(treeParts(tree, { text: 'title', up: 1 })[0].split('\n')[0], '- generic [ref=e3]:');
  assert.equal(treeParts(tree, { text: 'title', up: 9 })[0].split('\n')[0], '- main [ref=e1]:');
  // Up through both wrappers, not to main, which has 20 more lines.
  assert.equal(treeParts(tree, { text: 'title', context: true })[0], [
    '- generic [ref=e2]:',
    '  - generic [ref=e3]:',
    '    - heading "Title" [ref=e4]',
    '    - text: by someone',
  ].join('\n'));
});
