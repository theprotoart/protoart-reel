import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
// serveFile lives in main.js (which needs Electron): load just that function
const src = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('async function serveFile'), src.indexOf('// ------------------------------------------------------------------ writable files'));
const serveFile = new Function('fs', 'path', 'TYPES', 'Buffer', 'Response', 'ReadableStream', fn + '\nreturn serveFile;')(fs, { extname: f => f.slice(f.lastIndexOf('.')) }, {}, Buffer, Response, ReadableStream);

const dir = mkdtempSync(join(tmpdir(), 'serve-')), file = join(dir, 'a.bin');
const data = Buffer.alloc(5 * 1024 * 1024 + 123); for (let i = 0; i < data.length; i++) data[i] = i % 251;
writeFileSync(file, data);
const req = range => ({ headers: { get: k => (k === 'Range' ? range : null) } });

test('whole file, streamed a chunk at a time', async () => {
  const r = await serveFile(file, req(null));
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(data));
});
test('open-ended and closed ranges (seeking)', async () => {
  const r = await serveFile(file, req('bytes=3000000-'));
  assert.equal(r.status, 206);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(data.subarray(3000000)));
  const r2 = await serveFile(file, req('bytes=10-19'));
  assert.ok(Buffer.from(await r2.arrayBuffer()).equals(data.subarray(10, 20)));
});
test('a reader that stops early only gets what it asked for', async () => {
  const r = await serveFile(file, req('bytes=0-'));
  const rd = r.body.getReader(); const { value } = await rd.read(); await rd.cancel();
  assert.ok(value.length <= 1 << 20);
});
