// Every file of the editor's window parses as a module. (A misplaced comment once stopped the window loading
// while every other test passed; the build runs these tests, so that can't ship again.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'renderer');
const files = fs.readdirSync(dir, { recursive: true }).filter(f => String(f).endsWith('.js')).map(String);

test('every editor file parses (as the window loads it)', () => {
  assert.ok(files.length > 50);
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(path.join(dir, f)), encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${f}: ${(r.stderr || '').split('\n').slice(0, 4).join(' ')}`);
  }
  assert.deepEqual(bad, []);
});
