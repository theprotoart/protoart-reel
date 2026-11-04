// GPU picture filters for Reel (WebGL2, works on a page canvas or an OffscreenCanvas in a worker):
// colour (exposure, contrast, saturation, vibrance, temperature, tint, highlights, shadows), a 3D LUT,
// sharpen, vignette, black & white, green-screen keying and a matte (alpha) from background removal.
// The whole stack is one shader pass, so stacking filters costs about the same as one.

const VERT = `#version 300 es
in vec2 p; out vec2 uv;
void main() { uv = vec2((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D img, mask, lut;
uniform vec2 texel;
uniform float exposure, contrast, saturation, vibrance, temperature, tint, highlights, shadows;
uniform float inBlack, inWhite, gammaV, outBlack, outWhite, brightness;
uniform float sharpen, vignette, bw, lutAmount, lutSize, useMask, maskFeather, aberr;
uniform vec3 key; uniform float keyOn, keyTol, keySoft, keySpill;

vec3 lutLookup(vec3 c) {
  // 3D LUT stored as lutSize slices side by side: width = size*size, height = size
  float n = lutSize;
  float b = clamp(c.b, 0.0, 1.0) * (n - 1.0);
  float b0 = floor(b), b1 = min(b0 + 1.0, n - 1.0), f = b - b0;
  vec2 rg = clamp(c.rg, 0.0, 1.0) * (n - 1.0) + 0.5;
  vec2 s = vec2(n * n, n);
  vec3 c0 = texture(lut, vec2(b0 * n + rg.x, rg.y) / s).rgb;
  vec3 c1 = texture(lut, vec2(b1 * n + rg.x, rg.y) / s).rgb;
  return mix(c0, c1, f);
}
vec3 toYCbCr(vec3 c) { return vec3(0.299*c.r + 0.587*c.g + 0.114*c.b, -0.169*c.r - 0.331*c.g + 0.5*c.b, 0.5*c.r - 0.419*c.g - 0.081*c.b); }

void main() {
  vec4 src = texture(img, uv);
  vec3 c = src.rgb;
  float a = src.a;
  if (aberr > 0.0) { // chromatic aberration: red and blue land a little apart, more toward the edges (like a lens)
    vec2 d = (uv - 0.5) * aberr * 0.025;
    c = vec3(texture(img, uv + d).r, c.g, texture(img, uv - d).b);
  }
  if (sharpen > 0.0) {
    vec3 blur = (texture(img, uv + vec2(texel.x, 0.0)).rgb + texture(img, uv - vec2(texel.x, 0.0)).rgb +
                 texture(img, uv + vec2(0.0, texel.y)).rgb + texture(img, uv - vec2(0.0, texel.y)).rgb) * 0.25;
    c = c + (c - blur) * sharpen * 2.0;
  }
  if (keyOn > 0.5) {
    vec3 y = toYCbCr(c), k = toYCbCr(key);
    float d = distance(y.yz, k.yz);
    float alpha = smoothstep(keyTol, keyTol + max(0.001, keySoft), d);
    // spill: pull the key colour out of edges
    float spill = clamp(1.0 - d / max(0.001, keyTol * 2.5), 0.0, 1.0) * keySpill;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(c, vec3(lum), spill);
    a *= alpha;
  }
  // levels: input black / white, gamma (midtones), output black / white, then brightness
  c = clamp((c - inBlack) / max(0.01, inWhite - inBlack), 0.0, 1.0);
  c = pow(c, vec3(1.0 / max(0.05, gammaV)));
  c = outBlack + c * (outWhite - outBlack) + brightness;
  c *= exp2(exposure);
  // highlights / shadows: lift or pull the ends of the tonal range
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += shadows * 0.5 * (1.0 - smoothstep(0.0, 0.5, l)) * (1.0 - l);
  c += highlights * 0.5 * smoothstep(0.5, 1.0, l) * l;
  c = (c - 0.5) * (1.0 + contrast) + 0.5;
  // temperature (blue↔amber) and tint (green↔magenta)
  c += vec3(temperature, 0.0, -temperature) * 0.12 + vec3(tint, -tint, tint) * 0.06;
  float g = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(g), c, 1.0 + saturation + vibrance * (1.0 - sat));
  if (bw > 0.0) c = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), bw);
  if (lutAmount > 0.0 && lutSize > 1.0) c = mix(c, lutLookup(c), lutAmount);
  if (vignette > 0.0) { vec2 d = uv - 0.5; c *= 1.0 - vignette * smoothstep(0.25, 0.85, length(d) * 1.3); }
  if (useMask > 0.5) {
    float m = texture(mask, uv).r;
    a *= smoothstep(0.5 - maskFeather, 0.5 + maskFeather, m);
  }
  o = vec4(clamp(c, 0.0, 1.0) * a, a); // premultiplied
}`;

/** Effective uniforms for a clip's filter stack (bypassed filters skipped; later ones add up). */
export function filterParams(filters = [], levels = null) {
  const u = { inBlack: 0, inWhite: 1, gammaV: 1, outBlack: 0, outWhite: 1, brightness: 0, exposure: 0, contrast: 0, saturation: 0, vibrance: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0,
    sharpen: 0, vignette: 0, bw: 0, lut: null, lutAmount: 0, key: null, blur: 0, aberr: 0 };
  for (const f of filters) {
    if (!f || f.off) continue;
    switch (f.type) {
      case 'color': for (const k of ['exposure', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'highlights', 'shadows']) u[k] += f[k] || 0; break;
      case 'look': { const L = LOOKS[f.look]; if (L) for (const [k, v] of Object.entries(L)) u[k] += v * (f.amount ?? 1); break; }
      case 'lut': if (f.file) { u.lut = f.file; u.lutAmount = f.amount ?? 1; } break;
      case 'sharpen': u.sharpen += f.amount ?? 0.5; break;
      case 'vignette': u.vignette += f.amount ?? 0.4; break;
      case 'bw': u.bw = Math.max(u.bw, f.amount ?? 1); break;
      case 'blur': u.blur += f.amount ?? 8; break;
      case 'aberration': u.aberr += f.amount ?? 0.35; break;
      case 'chroma': u.key = { color: f.color || '#00d000', tol: f.tolerance ?? 0.12, soft: f.softness ?? 0.08, spill: f.spill ?? 0.6 }; break;
      default: break;
    }
  }
  if (levels) {
    u.inBlack = levels.black ?? 0; u.inWhite = levels.white ?? 1; u.gammaV = levels.gamma ?? 1;
    u.outBlack = levels.outBlack ?? 0; u.outWhite = levels.outWhite ?? 1; u.brightness = levels.brightness ?? 0;
    u.contrast += levels.contrast || 0; u.saturation += levels.saturation || 0;
  }
  return u;
}
const levelsOn = u => u.inBlack !== 0 || u.inWhite !== 1 || u.gammaV !== 1 || u.outBlack !== 0 || u.outWhite !== 1 || u.brightness !== 0;
/** Does this stack need the GPU pass (blur alone is done by the 2D canvas)? */
export function needsGl(u, matte) {
  return !!(matte || levelsOn(u) || u.key || u.lut || u.aberr || u.sharpen || u.vignette || u.bw || u.exposure || u.contrast || u.saturation || u.vibrance || u.temperature || u.tint || u.highlights || u.shadows);
}

/** Built-in looks (our own colour settings, not copies of anyone's LUTs). */
export const LOOKS = {
  warm: { temperature: 0.35, saturation: 0.08, contrast: 0.05 },
  cool: { temperature: -0.35, tint: 0.05, contrast: 0.05 },
  tealOrange: { temperature: 0.15, saturation: 0.15, contrast: 0.15, tint: -0.1, highlights: 0.1 },
  faded: { contrast: -0.2, shadows: 0.25, saturation: -0.2 },
  punchy: { contrast: 0.25, vibrance: 0.35, saturation: 0.1 },
  moody: { exposure: -0.25, contrast: 0.2, saturation: -0.25, temperature: -0.1, highlights: -0.15 },
  vintage: { temperature: 0.3, saturation: -0.3, contrast: -0.1, shadows: 0.2, tint: 0.08 },
  crisp: { contrast: 0.12, sharpen: 0.35, vibrance: 0.15 },
};

const hexRgb = h => { const n = parseInt(String(h).replace('#', ''), 16) || 0; return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

export class GlFx {
  constructor() {
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(16, 16) : document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: true, antialias: false });
    if (!gl) throw new Error('WebGL2 isn’t available');
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['inBlack', 'inWhite', 'gammaV', 'outBlack', 'outWhite', 'brightness', 'img', 'mask', 'lut', 'texel', 'exposure', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'highlights', 'shadows', 'sharpen', 'vignette', 'bw', 'lutAmount', 'lutSize', 'useMask', 'maskFeather', 'key', 'keyOn', 'keyTol', 'keySoft', 'keySpill', 'aberr']) this.u[n] = gl.getUniformLocation(prog, n);
    this.tex = [0, 1, 2].map(i => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; });
    gl.uniform1i(this.u.img, 0); gl.uniform1i(this.u.mask, 1); gl.uniform1i(this.u.lut, 2);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.lutKey = null;
  }
  setLut(key, lut) {
    if (this.lutKey === key) return;
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tex[2]);
    if (lut) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, lut.size * lut.size, lut.size, 0, gl.RGB, gl.UNSIGNED_BYTE, lut.data2d);
    this.lutKey = key; this.lutSizeNow = lut ? lut.size : 0;
  }
  /**
   * Runs the stack on `img` (video element, VideoFrame, ImageBitmap, canvas) at w×h and returns the
   * canvas holding the result (valid until the next call). mask: matte frame or null.
   */
  process(img, w, h, u, mask, lut, maskFeather = 0.08) {
    const gl = this.gl;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tex[1]);
    if (mask) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
    if (u.lut && lut) this.setLut(u.lut, lut);
    const f = (n, v) => gl.uniform1f(this.u[n], v);
    for (const k of ['exposure', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'highlights', 'shadows', 'sharpen', 'vignette', 'bw', 'brightness', 'inBlack', 'outBlack', 'aberr']) f(k, u[k] || 0);
    for (const k of ['inWhite', 'gammaV', 'outWhite']) f(k, u[k] ?? 1);
    gl.uniform2f(this.u.texel, 1 / w, 1 / h);
    f('lutAmount', u.lut && lut ? u.lutAmount : 0); f('lutSize', u.lut && lut ? lut.size : 0);
    f('useMask', mask ? 1 : 0); f('maskFeather', maskFeather);
    if (u.key) { gl.uniform3f(this.u.key, ...hexRgb(u.key.color)); f('keyOn', 1); f('keyTol', u.key.tol); f('keySoft', u.key.soft); f('keySpill', u.key.spill); } else f('keyOn', 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

// ------------------------------------------------------------------ .cube LUT files

/** Parses an Adobe/Resolve .cube 3D LUT into an RGB8 texture laid out for the shader. */
export function parseCube(text) {
  let size = 0; const vals = [];
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const m = line.split(/\s+/);
    if (m[0] === 'LUT_3D_SIZE') { size = parseInt(m[1], 10); continue; }
    if (m[0] === 'DOMAIN_MIN') { dmin = m.slice(1, 4).map(Number); continue; }
    if (m[0] === 'DOMAIN_MAX') { dmax = m.slice(1, 4).map(Number); continue; }
    if (/^[A-Z_]/.test(m[0])) continue; // TITLE, LUT_1D_SIZE…
    if (m.length >= 3) vals.push(+m[0], +m[1], +m[2]);
  }
  if (!(size >= 2 && size <= 128) || vals.length < size ** 3 * 3) throw new Error('Not a 3D .cube LUT');
  // .cube order: red fastest, then green, then blue. Texture: x = b*size + r, y = g.
  const data2d = new Uint8Array(size * size * size * 3);
  const norm = (v, i) => Math.round(Math.max(0, Math.min(1, (v - dmin[i]) / ((dmax[i] - dmin[i]) || 1))) * 255);
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const s = ((b * size + g) * size + r) * 3, d = ((g * size * size) + b * size + r) * 3;
    data2d[d] = norm(vals[s], 0); data2d[d + 1] = norm(vals[s + 1], 1); data2d[d + 2] = norm(vals[s + 2], 2);
  }
  return { size, data2d };
}
