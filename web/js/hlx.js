/*
 * HX Stomp Editor — preset (.hlx) and setlist (.hls) files.
 * Copyright (C) 2026 Jon Solberg — GPL-3.0-or-later (see LICENSE).
 *
 * .hlx files exported by HX Edit are JSON. Numbers that HX Edit wrote with a decimal point
 * (1.0) must stay floats when the file is written back, so this module has its own small JSON
 * parser that remembers which values were floats, and a writer that keeps them that way.
 * Key order is kept as in the file.
 *
 * .hls setlists are a JSON wrapper whose "encoded_data" is base64 of zlib-compressed JSON
 * holding a "presets" list.
 */
(function (root) {
  'use strict';

  var FLOATS = typeof Symbol === 'function' ? Symbol('floats') : '__floats';

  // ------------------------------------------------------------------ JSON that keeps floats
  function parse(text) {
    var i = 0, n = text.length;
    function ws() { while (i < n) { var c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; } }
    function fail(msg) { throw new Error('Not a valid preset file (' + msg + ' at character ' + i + ')'); }
    function mark(o, k) { if (!o[FLOATS]) Object.defineProperty(o, FLOATS, { value: new Set(), enumerable: false }); o[FLOATS].add(k); }
    function str() {
      var j = i + 1, out = '';
      for (;;) {
        var e = text.indexOf('"', j), b = text.indexOf('\\', j);
        if (e < 0) fail('unterminated text');
        if (b < 0 || b > e) { out += text.slice(j, e); i = e + 1; return out; }
        out += text.slice(j, b);
        var c = text[b + 1];
        if (c === 'u') { out += String.fromCharCode(parseInt(text.substr(b + 2, 4), 16)); j = b + 6; }
        else { out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' })[c] || c; j = b + 2; }
      }
    }
    function val(parent, key) {
      ws();
      var c = text[i];
      if (c === '{') {
        i++; var o = {}; ws();
        if (text[i] === '}') { i++; return o; }
        for (;;) {
          ws(); if (text[i] !== '"') fail('expected a name');
          var k = str(); ws(); if (text[i] !== ':') fail('expected :'); i++;
          o[k] = val(o, k); ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === '}') { i++; return o; }
          fail('expected , or }');
        }
      }
      if (c === '[') {
        i++; var a = []; ws();
        if (text[i] === ']') { i++; return a; }
        for (;;) {
          a.push(val(a, a.length)); ws();
          if (text[i] === ',') { i++; continue; }
          if (text[i] === ']') { i++; return a; }
          fail('expected , or ]');
        }
      }
      if (c === '"') return str();
      if (text.startsWith('true', i)) { i += 4; return true; }
      if (text.startsWith('false', i)) { i += 5; return false; }
      if (text.startsWith('null', i)) { i += 4; return null; }
      var m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
      if (!m) fail('unexpected "' + c + '"');
      i += m[0].length;
      if (m[1] || m[2]) mark(parent, key);
      return Number(m[0]);
    }
    var root = {}, v = val(root, '');
    ws(); if (i < n) fail('extra text');
    return v;
  }

  function isFloat(o, k) { return !!(o && o[FLOATS] && o[FLOATS].has(k)); }
  function setFloat(o, k) { if (!o[FLOATS]) Object.defineProperty(o, FLOATS, { value: new Set(), enumerable: false }); o[FLOATS].add(k); }

  function num(v, float) {
    if (!isFinite(v)) return '0';
    var s = String(v);
    if (float && /^-?\d+$/.test(s)) s += '.0';
    return s;
  }
  /** Writes JSON in HX Edit's layout ("key" : value, three-space indent). */
  function stringify(v) {
    function w(x, ind, parent, key) {
      if (x === null) return 'null';
      if (typeof x === 'number') return num(x, isFloat(parent, key));
      if (typeof x === 'boolean') return x ? 'true' : 'false';
      if (typeof x === 'string') return JSON.stringify(x);
      var pad = ind + '   ';
      if (Array.isArray(x)) {
        if (!x.length) return '[]';
        return '[\n' + x.map(function (e, j) { return pad + w(e, pad, x, j); }).join(',\n') + '\n' + ind + ']';
      }
      var ks = Object.keys(x);
      if (!ks.length) return '{}';
      return '{\n' + ks.map(function (k) { return pad + JSON.stringify(k) + ' : ' + w(x[k], pad, x, k); }).join(',\n') + '\n' + ind + '}';
    }
    return w(v, '', null, null) + '\n';
  }

  // ------------------------------------------------------------------ zlib (.hls)
  function b64ToBytes(s) { var bin = atob(s.replace(/\s+/g, '')), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function bytesToB64(b) { var s = '', CH = 0x8000; for (var i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH)); return btoa(s); }
  async function pipe(bytes, stream) {
    var out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }
  function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot open setlist files (no DecompressionStream)');
    return pipe(bytes, new DecompressionStream('deflate'));
  }
  function deflate(bytes) { return pipe(bytes, new CompressionStream('deflate')); }
  var CRC_T = null;
  function crc32(b) {
    if (!CRC_T) { CRC_T = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < b.length; i++) crc = CRC_T[(crc ^ b[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ------------------------------------------------------------------ preset model
  /** Finds the preset object (the one holding "tone") in a parsed file. */
  function presetOf(doc) {
    if (doc && doc.tone) return doc;
    if (doc && doc.data && doc.data.tone) return doc.data;
    return null;
  }
  function presetName(p) {
    var m = p && (p.meta || (p.data && p.data.meta));
    return (m && m.name) || '';
  }
  function setPresetName(p, name) {
    var m = p.meta || (p.meta = {});
    m.name = name.slice(0, 16);
  }

  var CATS = [
    [/^Amp/, 'Amp', '#e5484d'], [/^Preamp/, 'Preamp', '#e5484d'], [/^Cab|^Mic/, 'Cab', '#c2703d'],
    [/^ImpulseResponse|^IR/, 'IR', '#c2703d'], [/^Dist|^Drive|^Fuzz|^Boost/, 'Distortion', '#f5a524'],
    [/^Compressor|^Dynamics|^Gate|^NoiseGate|^Dyn/, 'Dynamics', '#f2d544'], [/^EQ/, 'EQ', '#9a9a9a'],
    [/^Chorus|^Flanger|^Phaser|^Tremolo|^Vibrato|^Rotary|^Mod|^Uni|^Pitch.*Vib/, 'Modulation', '#3b82f6'],
    [/^Delay|^Echo|^Looper.*Delay/, 'Delay', '#22c55e'], [/^Reverb|^Verb/, 'Reverb', '#f97316'],
    [/^Pitch|^Synth|^Harmon|^Octave/, 'Pitch/Synth', '#a855f7'], [/^Filter|^Wah|^Envelope|^Talk/, 'Filter/Wah', '#ec4899'],
    [/^Vol|^Pan|^Gain/, 'Volume/Pan', '#64748b'], [/^Looper/, 'Looper', '#14b8a6'], [/^FXLoop|^Send|^Return/, 'Send/Return', '#0ea5e9'],
    [/^AppDSPFlow|^AppDSP/, 'Routing', '#64748b']
  ];
  function modelInfo(model) {
    var raw = String(model || '');
    var m = raw.replace(/^(HD2_|HelixStomp_|HX2_|VIC_|L6C_|HD2|Helix)/, '');
    var cat = 'Effect', color = '#8b8f98';
    for (var i = 0; i < CATS.length; i++) if (CATS[i][0].test(m)) { cat = CATS[i][1]; color = CATS[i][2]; break; }
    var nice = m.replace(/^(Amp|Preamp|Cab|Dist|Delay|Reverb|Compressor|Dynamics|EQ|Chorus|Flanger|Phaser|Tremolo|Vibrato|Rotary|Mod|Pitch|Filter|Wah|Vol|Looper|FXLoop|Send|Return|AppDSPFlow)/, function (p) { return p + ' '; })
      .replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/(\d)x (\d)/g, '$1x$2').replace(/(\d)([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
    if (/^ImpulseResponse/.test(m)) nice = 'Impulse Response ' + m.replace(/\D+/g, '');
    return { cat: cat, color: color, name: nice || raw };
  }

  /** The blocks of one DSP, sorted by path and position. Includes split/join/input/output. */
  function blocks(p, dsp) {
    var d = p.tone[dsp]; if (!d) return [];
    return Object.keys(d).filter(function (k) { return d[k] && typeof d[k] === 'object' && '@model' in d[k]; })
      .map(function (k) {
        var b = d[k], kind = /^block/.test(k) ? 'block' : /^cab/.test(k) ? 'cab' : /^input/.test(k) ? 'input' : /^output/.test(k) ? 'output' : k;
        return { key: k, dsp: dsp, b: b, kind: kind, path: b['@path'] || 0, pos: kind === 'input' ? -1 : kind === 'output' ? 99 : (b['@position'] != null ? b['@position'] : 50), info: modelInfo(b['@model']) };
      })
      .sort(function (a, b) { return a.path - b.path || a.pos - b.pos; });
  }

  function snapshots(p) {
    var out = [];
    for (var i = 0; i < 8; i++) { var s = p.tone['snapshot' + i]; if (s) out.push({ index: i, s: s }); }
    return out;
  }

  /** Parameters of a block that the user can edit (not "@" internals, not nested objects). */
  function params(b) {
    return Object.keys(b).filter(function (k) { return k[0] !== '@' && (typeof b[k] === 'number' || typeof b[k] === 'boolean'); });
  }

  /** Which parameters of this block are controlled by snapshots / controllers. */
  function controlled(p, dsp, key) {
    var c = p.tone.controller && p.tone.controller[dsp] && p.tone.controller[dsp][key];
    return c || {};
  }

  // ------------------------------------------------------------------ files
  async function open(file) {
    var text = await file.text();
    var doc = parse(text);
    if (doc && typeof doc.encoded_data === 'string') {
      var raw = await inflate(b64ToBytes(doc.encoded_data));
      var inner = parse(new TextDecoder().decode(raw));
      var list = inner.presets || (inner.data && inner.data.presets) || [];
      return { kind: 'setlist', fileName: file.name, wrapper: doc, inner: inner, presets: list };
    }
    var p = presetOf(doc);
    if (!p) throw new Error(file.name + ' is not an HX preset (.hlx) or setlist (.hls) file');
    return { kind: 'preset', fileName: file.name, doc: doc, preset: p };
  }

  function presetFile(doc) { return new Blob([stringify(doc)], { type: 'application/json' }); }

  /** A setlist preset as a stand-alone .hlx document. */
  function presetDoc(p) {
    if (p.data) return p;
    var meta = p.meta || {};
    return { data: { device: p.device || 2162694, device_version: p.device_version || 0, meta: meta, tone: p.tone },
      meta: { original: 0, pbn: 0, premium: 0 }, schema: 'L6Preset', version: 6 };
  }

  async function setlistFile(sl) {
    var bytes = new TextEncoder().encode(stringify(sl.inner));
    var w = sl.wrapper;
    w.encoded_data = bytesToB64(await deflate(bytes));
    if ('decompressed_size' in w) w.decompressed_size = bytes.length;
    if ('crc32' in w) w.crc32 = crc32(bytes);
    return new Blob([stringify(w)], { type: 'application/json' });
  }

  function isEmptyPreset(p) {
    if (!p || !p.tone) return true;
    var d = p.tone.dsp0 || {}, d1 = p.tone.dsp1 || {};
    return !Object.keys(d).concat(Object.keys(d1)).some(function (k) { return /^block/.test(k); });
  }

  root.HLX = {
    parse: parse, stringify: stringify, isFloat: isFloat, setFloat: setFloat, crc32: crc32,
    open: open, presetOf: presetOf, presetName: presetName, setPresetName: setPresetName,
    modelInfo: modelInfo, blocks: blocks, snapshots: snapshots, params: params, controlled: controlled,
    presetFile: presetFile, presetDoc: presetDoc, setlistFile: setlistFile, isEmptyPreset: isEmptyPreset
  };
})(window);
