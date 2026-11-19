// Chapters and captions inside a finished MP4 (1.15) whose movie header comes last, as the Mac's encoder writes the
// Rust core's exports: their samples go in a new mdat at the end, then a new moov with the text tracks added
// (lib/mp4.js moovWithText), and only then is the old moov turned into free space, so the file plays at every step.
'use strict';
const fs = require('fs');

/** Top-level boxes: [{ type, start, size }] from their headers alone. */
function topBoxes(fd, size) {
  const out = [], h = Buffer.alloc(16);
  let p = 0;
  while (p + 8 <= size) {
    fs.readSync(fd, h, 0, 16, p);
    let n = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (n === 1) n = Number(h.readBigUInt64BE(8)); else if (n === 0) n = size - p;
    if (n < 8 || p + n > size) break;
    out.push({ type, start: p, size: n });
    p += n;
  }
  return out;
}

/**
 * text: { chapters, captions, dur } (seconds; see lib/mp4.js textSamples). mp4: lib/mp4.js. Returns true when it
 * added something; false when there was nothing to add or the file isn't laid out as expected (left untouched).
 */
function addTextTracks(file, text, mp4) {
  const ts = mp4.textSamples(text);
  if (!ts.chap && !ts.subs) return false;
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    const tops = topBoxes(fd, size);
    const moov = tops.find(b => b.type === 'moov');
    // the file must end at its last box (nothing half-written after), and the movie header be a size we can hold
    const last = tops[tops.length - 1];
    if (!moov || !last || last.start + last.size !== size || moov.size > 256 << 20 || tops.filter(b => b.type === 'moov').length !== 1) return false;
    const old = Buffer.alloc(moov.size);
    fs.readSync(fd, old, 0, moov.size, moov.start);
    const mdatHead = Buffer.alloc(8);
    mdatHead.writeUInt32BE(8 + ts.data.length, 0); mdatHead.write('mdat', 4, 'latin1');
    const nm = mp4.moovWithText(new Uint8Array(old.buffer, old.byteOffset, old.length), ts, size + 8);
    fs.writeSync(fd, mdatHead, 0, 8, size);
    fs.writeSync(fd, ts.data, 0, ts.data.length, size + 8);
    fs.writeSync(fd, nm, 0, nm.length, size + 8 + ts.data.length);
    fs.fsyncSync(fd);
    fs.writeSync(fd, Buffer.from('free', 'latin1'), 0, 4, moov.start + 4); // the old one: free space now
    fs.fsyncSync(fd);
    return true;
  } finally { fs.closeSync(fd); }
}

/**
 * Sets a finished movie's file type (its first box, ftyp) for a .mov ('qt  ') or .m4v ('M4V ') in place: the new box
 * takes the old one's room exactly, with as many compatible brands as fit and any room left as a free box, so
 * nothing else in the file moves.
 */
function setBrand(file, kind) {
  const major = kind === 'mov' ? 'qt  ' : 'M4V ';
  const compat = kind === 'mov' ? ['qt  '] : ['M4V ', 'M4A ', 'mp42', 'isom'];
  const fd = fs.openSync(file, 'r+');
  try {
    const h = Buffer.alloc(8);
    fs.readSync(fd, h, 0, 8, 0);
    if (h.toString('latin1', 4, 8) !== 'ftyp') return false;
    const room = h.readUInt32BE(0);
    if (room < 16 || room > 4096) return false;
    for (let n = compat.length; n >= 1; n--) {
      const size = 16 + 4 * n, rest = room - size;
      if (rest !== 0 && rest < 8) continue;
      const b = Buffer.alloc(room);
      b.writeUInt32BE(size, 0); b.write('ftyp', 4, 'latin1'); b.write(major, 8, 'latin1'); b.writeUInt32BE(kind === 'mov' ? 0x200 : 1, 12);
      compat.slice(0, n).forEach((c, i) => b.write(c, 16 + 4 * i, 'latin1'));
      if (rest) { b.writeUInt32BE(rest, size); b.write('free', size + 4, 'latin1'); }
      fs.writeSync(fd, b, 0, room, 0);
      return true;
    }
    return false;
  } finally { fs.closeSync(fd); }
}

module.exports = { addTextTracks, topBoxes, setBrand };
