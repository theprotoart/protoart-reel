// A small read-only SQLite reader: walks a table's b-tree and decodes its rows. Enough for the index database
// ScreenFlow keeps at the end of every .scc recording (no indexes, overflow pages or WAL needed for reading).

const varint = (b, p) => {
  let v = 0;
  for (let i = 0; i < 8; i++) { const c = b[p + i]; v = v * 128 + (c & 0x7f); if (!(c & 0x80)) return [v, i + 1]; }
  return [v * 256 + b[p + 8], 9];
};

/** Opens a database held in a Uint8Array. Returns { tables: { name: { columns, rows() } } }. */
export function openSqlite(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (new TextDecoder().decode(buf.subarray(0, 15)) !== 'SQLite format 3') throw new Error('Not an SQLite database');
  let pageSize = dv.getUint16(16); if (pageSize === 1) pageSize = 65536;
  const reserved = buf[20], usable = pageSize - reserved, enc = dv.getUint32(56) || 1;
  const td = new TextDecoder(enc === 1 ? 'utf-8' : enc === 2 ? 'utf-16le' : 'utf-16be');
  const page = n => buf.subarray((n - 1) * pageSize, n * pageSize);
  // payload of a cell, following overflow pages when it doesn't fit
  function payload(pg, p, len) {
    const X = usable - 35;
    if (len <= X) return pg.subarray(p, p + len);
    const M = ((usable - 12) * 32) / 255 - 23, K = M + ((len - M) % (usable - 4));
    const local = K <= X ? K : M, out = new Uint8Array(len);
    out.set(pg.subarray(p, p + local), 0);
    let got = local, next = new DataView(pg.buffer, pg.byteOffset + p + local, 4).getUint32(0);
    while (got < len && next) {
      const op = page(next), n = Math.min(usable - 4, len - got);
      out.set(op.subarray(4, 4 + n), got); got += n; next = new DataView(op.buffer, op.byteOffset, 4).getUint32(0);
    }
    return out;
  }
  function record(r) {
    const [hlen, a] = varint(r, 0); let p = a, q = hlen; const types = [], vals = [];
    while (p < hlen) { const [t, n] = varint(r, p); types.push(t); p += n; }
    const v = new DataView(r.buffer, r.byteOffset, r.byteLength);
    for (const t of types) {
      if (t === 0) vals.push(null);
      else if (t >= 1 && t <= 6) {
        const n = [0, 1, 2, 3, 4, 6, 8][t]; let x = 0;
        if (n === 8) x = Number(v.getBigInt64(q));
        else { for (let i = 0; i < n; i++) x = x * 256 + r[q + i]; if (r[q] & 0x80) x -= 2 ** (8 * n); }
        vals.push(x); q += n;
      } else if (t === 7) { vals.push(v.getFloat64(q)); q += 8; }
      else if (t === 8) vals.push(0);
      else if (t === 9) vals.push(1);
      else if (t >= 12) {
        const n = t % 2 ? (t - 13) / 2 : (t - 12) / 2, s = r.subarray(q, q + n);
        vals.push(t % 2 ? td.decode(s).replace(/\0+$/, '') : s.slice()); q += n;
      }
    }
    return vals;
  }
  function* walk(n) {
    const pg = page(n), h = n === 1 ? 100 : 0, type = pg[h], cells = (pg[h + 3] << 8) | pg[h + 4];
    const hdr = type === 2 || type === 5 ? 12 : 8;
    for (let i = 0; i < cells; i++) {
      const p = (pg[h + hdr + i * 2] << 8) | pg[h + hdr + i * 2 + 1];
      if (type === 13) { // table leaf: payload length, rowid, payload
        const [len, a] = varint(pg, p), [, b] = varint(pg, p + a);
        yield record(payload(pg, p + a + b, len));
      } else if (type === 5) yield* walk(new DataView(pg.buffer, pg.byteOffset + p, 4).getUint32(0));
    }
    if (type === 5) yield* walk(new DataView(pg.buffer, pg.byteOffset + h + 8, 4).getUint32(0));
  }
  const tables = {};
  for (const [type, name, , root, sql] of walk(1)) {
    if (type !== 'table') continue;
    const cols = /\((.*)\)/s.exec(sql)?.[1].split(',').map(s => s.trim().split(/\s+/)[0]) || [];
    tables[name] = { columns: cols, rows: () => Array.from(walk(root)), objects: () => Array.from(walk(root), r => Object.fromEntries(cols.map((c, i) => [c, r[i]]))) };
  }
  return { tables };
}
