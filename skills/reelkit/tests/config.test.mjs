import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../scripts/lib/config.mjs';

test('loadConfig can be called repeatedly in one process (schema compiled once)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reelkit-cfg-'));
  try {
    const file = path.join(dir, 'reelkit.config.yaml');
    writeFileSync(file, 'baseUrl: http://localhost:3000\nscenes:\n  - { name: a, url: / }\n');
    assert.doesNotThrow(() => {
      loadConfig(file);
      loadConfig(file);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
