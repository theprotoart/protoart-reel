// Binary property lists (bplist00) and NSKeyedArchiver archives, read into plain JS values.
// Archived objects come back as { $class: 'ClassName', ...fields }; NSDictionary / NSArray / NSString /
// NSDate / NSData / NSNull become the obvious JS values.

export function parseBplist(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (new TextDecoder().decode(b.subarray(0, 8)) !== 'bplist00') throw new Error('Not a binary plist');
  const t = b.length - 32, offSize = b[t + 6], refSize = b[t + 7];
  const num = Number(dv.getBigUint64(t + 8)), top = Number(dv.getBigUint64(t + 16)), table = Number(dv.getBigUint64(t + 24));
  const uint = (p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };
  const offs = Array.from({ length: num }, (_, i) => uint(table + i * offSize, offSize));
  const cache = new Map();
  function obj(i) {
    if (cache.has(i)) return cache.get(i);
    const p = offs[i], m = b[p], hi = m >> 4, lo = m & 15;
    const count = () => { if (lo !== 15) return [lo, p + 1]; const ib = b[p + 1], n = 1 << (ib & 15); return [uint(p + 2, n), p + 2 + n]; };
    let v;
    if (hi === 0) v = lo === 8 ? false : lo === 9 ? true : null;
    else if (hi === 1) { const n = 1 << lo; v = n === 8 ? Number(dv.getBigInt64(p + 1)) : n === 16 ? Number(dv.getBigInt64(p + 9)) : uint(p + 1, n); if (n === 4 && v >= 2 ** 31 && false) v -= 2 ** 32; }
    else if (hi === 2) v = lo === 2 ? dv.getFloat32(p + 1) : dv.getFloat64(p + 1);
    else if (hi === 3) v = { $date: dv.getFloat64(p + 1) }; // seconds since 2001-01-01
    else if (hi === 4) { const [n, s] = count(); v = b.slice(s, s + n); }
    else if (hi === 5) { const [n, s] = count(); v = new TextDecoder('latin1').decode(b.subarray(s, s + n)); }
    else if (hi === 6) { const [n, s] = count(); let str = ''; for (let k = 0; k < n; k++) str += String.fromCharCode(dv.getUint16(s + 2 * k)); v = str; }
    else if (hi === 8) v = { $uid: uint(p + 1, lo + 1) };
    else if (hi === 10 || hi === 12) { const [n, s] = count(); v = []; cache.set(i, v); for (let k = 0; k < n; k++) v.push(obj(uint(s + k * refSize, refSize))); return v; }
    else if (hi === 13) {
      const [n, s] = count(); v = {}; cache.set(i, v);
      for (let k = 0; k < n; k++) v[obj(uint(s + k * refSize, refSize))] = obj(uint(s + (n + k) * refSize, refSize));
      return v;
    } else throw new Error('Unknown plist object 0x' + m.toString(16));
    cache.set(i, v);
    return v;
  }
  return obj(top);
}

/** Unarchives an NSKeyedArchiver plist (bytes or an already-parsed plist). Returns its $top, resolved. */
export function unarchive(input) {
  const pl = input instanceof Uint8Array || input instanceof ArrayBuffer ? parseBplist(input) : input;
  if (!pl || !pl.$objects) throw new Error('Not a keyed archive');
  const objs = pl.$objects, memo = new Map();
  const res = (x, depth = 0) => {
    if (x && typeof x === 'object' && '$uid' in x) {
      const i = x.$uid;
      if (memo.has(i)) return memo.get(i);
      const v = decode(objs[i], depth, i);
      return v;
    }
    return x === '$null' ? null : x;
  };
  function decode(o, depth, i) {
    if (o === '$null') return null;
    if (!o || typeof o !== 'object' || Array.isArray(o) || o instanceof Uint8Array || '$date' in o) return o;
    if (!('$class' in o)) { const out = {}; for (const k in o) out[k] = res(o[k], depth + 1); return out; }
    const cls = res(o.$class)?.$classname || '?';
    if (cls === 'NSDictionary' || cls === 'NSMutableDictionary') {
      const out = {}; memo.set(i, out);
      (o['NS.keys'] || []).forEach((k, n) => { out[res(k)] = res(o['NS.objects'][n], depth + 1); });
      return out;
    }
    if (/^NS(Mutable)?(Array|Set|OrderedSet)$/.test(cls)) { const out = []; memo.set(i, out); for (const v of o['NS.objects'] || []) out.push(res(v, depth + 1)); return out; }
    if (cls === 'NSString' || cls === 'NSMutableString') return o['NS.string'] ?? '';
    if (cls === 'NSDate') return { $date: o['NS.time'] };
    if (cls === 'NSData' || cls === 'NSMutableData') return o['NS.data'];
    if (cls === 'NSNull') return null;
    const out = { $class: cls }; memo.set(i, out);
    if (depth > 40) return out;
    for (const k in o) if (k !== '$class') out[k] = res(o[k], depth + 1);
    return out;
  }
  const top = {};
  for (const k in pl.$top) top[k] = res(pl.$top[k]);
  return top;
}

/** NSColor from an archive → '#rrggbb' (and alpha), from its RGB or white components. */
export function nsColor(c) {
  if (!c || typeof c !== 'object') return null;
  const txt = v => (v instanceof Uint8Array ? new TextDecoder().decode(v).replace(/\0/g, '').trim() : String(v || ''));
  let parts = null;
  if (c.NSRGB) parts = txt(c.NSRGB).split(/\s+/).map(Number);
  else if (c.NSComponents) { const p = txt(c.NSComponents).split(/\s+/).map(Number); parts = p.length >= 3 ? p : [p[0], p[0], p[0], p[1] ?? 1]; }
  else if (c.NSWhite) { const p = txt(c.NSWhite).split(/\s+/).map(Number); parts = [p[0], p[0], p[0], p[1] ?? 1]; }
  if (!parts || parts.some(Number.isNaN)) return null;
  const h = v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return { hex: '#' + h(parts[0]) + h(parts[1]) + h(parts[2]), alpha: parts[3] ?? 1 };
}
