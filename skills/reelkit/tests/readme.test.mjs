import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertBlock } from '../scripts/lib/readme.mjs';
import { MARK_END, MARK_START } from '../scripts/lib/brand.mjs';

const block = `${MARK_START}\nNEW\n${MARK_END}`;

test('replaces only the content between markers', () => {
  const before = `# Title\n\nintro\n\n${MARK_START}\nOLD\n${MARK_END}\n\n## Footer\nkeep me`;
  const out = insertBlock(before, block);
  assert.equal(out, `# Title\n\nintro\n\n${block}\n\n## Footer\nkeep me`);
});

test('appends markers when missing', () => {
  assert.equal(insertBlock('# Hi\n', block), `# Hi\n\n${block}\n`);
});

test('is idempotent', () => {
  const once = insertBlock('# Hi\n', block);
  assert.equal(insertBlock(once, block), once);
});

test('refuses a lone marker', () => {
  assert.throws(() => insertBlock(`# Hi\n${MARK_START}\n`, block), /only one/);
});
