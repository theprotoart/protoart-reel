import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { addRange, missing } = createRequire(import.meta.url)('../app/engine/verbatim.js');

test('verbatim: only the parts not written down yet are transcribed', () => {
  assert.deepEqual(missing([], 344, 460), [[344, 460]]);
  let have = addRange([], 344, 460);
  assert.deepEqual(missing(have, 350, 400), []);
  assert.deepEqual(missing(have, 300, 500), [[300, 344], [460, 500]]);
  have = addRange(have, 500, 520);
  assert.deepEqual(have, [[344, 460], [500, 520]]);
  assert.deepEqual(missing(have, 450, 510), [[460, 500]]);
  have = addRange(have, 460, 500.1);
  assert.deepEqual(have, [[344, 520]]);
  assert.deepEqual(missing(have, 344.1, 520.2), []); // a hair's breadth counts as done
  assert.deepEqual(missing([[0, 1e9]], 10, 20), []); // an older whole-recording transcript
});
