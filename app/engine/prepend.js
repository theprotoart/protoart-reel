'use strict';
const fs = require('fs');

/**
 * The header put in front of the body without a second copy of it (1.11): the body is moved along by the header's
 * length inside its own file, from the end backwards, and the header written in front. It needs only the header's
 * size in free space (a couple of MB), where joinFiles needs the whole export again: used when the drive is short.
 */
async function prependInPlace(file, head) {
  const H = head.length;
  const fh = await fs.promises.open(file, 'r+');
  try {
    const { size } = await fh.stat();
    const buf = Buffer.alloc(8 << 20);
    for (let end = size; end > 0;) {
      const n = Math.min(buf.length, end), at = end - n;
      const { bytesRead } = await fh.read(buf, 0, n, at);
      if (bytesRead !== n) throw new Error('Couldn’t read the export back');
      await fh.write(buf, 0, n, at + H);
      end = at;
    }
    await fh.write(Buffer.from(head), 0, H, 0);
    await fh.sync();
  } finally { await fh.close(); }
}
module.exports = { prependInPlace };
