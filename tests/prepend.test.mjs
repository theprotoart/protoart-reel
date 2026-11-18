import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const { prependInPlace } = createRequire(import.meta.url)('../app/engine/prepend.js');

test('an export finished on a nearly full drive: the header put in front without a second copy', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prep-'));
  try {
    for (const [hn, bn] of [[1792393, 20 << 20], [32, 7], [100, 0], [9 << 20, 17 << 20]]) { // more than one 8 MB step, and odd sizes
      const head = crypto.randomBytes(hn), body = crypto.randomBytes(bn), f = path.join(dir, 'x.part');
      fs.writeFileSync(f, body);
      await prependInPlace(f, new Uint8Array(head));
      const out = fs.readFileSync(f);
      assert.equal(out.length, hn + bn);
      assert.ok(out.subarray(0, hn).equals(head), 'header in front');
      assert.ok(out.subarray(hn).equals(body), `body intact (${hn}+${bn})`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
