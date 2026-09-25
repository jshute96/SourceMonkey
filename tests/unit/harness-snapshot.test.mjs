// snapshot's helpers: which refs a word names, and which lines of a
// tree with boxes show on screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { framePaths, onScreen, pageRefs, refLabels, refOf, tidy } from '../../lib/harness/snapshot.js';

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

test('selectors are wanted for the page\'s elements, whatever their prefix, and not an iframe\'s', () => {
  const tree = [
    '- generic [ref=f3e1]:',
    '  - link "Lists" [ref=f3e214] [cursor=pointer]:',
    '    - /url: lists',
    '  - iframe [ref=f3e5]:',
    '    - button "In frame" [ref=f4e1]',
    '    - generic [ref=f4e2]:',
    '      - button "Deeper" [ref=f4e3]',
    '  - button "After" [ref=f3e6]',
  ].join('\n');
  assert.deepEqual(pageRefs(tree), ['f3e1', 'f3e214', 'f3e5', 'f3e6']);
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
  assert.deepEqual([...framePaths(tree, ['e9'])], [
    ['f3e1', ['e9']], ['f3e2', ['e9']], ['f5e1', ['e9', 'f3e2']], ['f5e2', ['e9', 'f3e2']],
    ['f6e1', ['e9', 'f3e2', 'f5e2']], ['f3e3', ['e9']],
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
