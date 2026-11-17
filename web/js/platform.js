/*
 * HX Stomp Editor — talking to the pedal.
 * Copyright (C) 2026 Jon Solberg — GPL-3.0-or-later (see LICENSE).
 *
 * Direct mode uses only USB MIDI, as documented in the HX Stomp Owner's Manual
 * (Program Change for presets, the MIDI CC list for everything else).
 *
 * Back ends:
 *  - Browser:      Web MIDI (Firefox, Chrome, Edge, Opera — needs https)
 *  - Android app:  window.HXNative bridge (android.media.midi), plus the pedal's own USB
 *                  interface for reading preset names (experimental, see usb/ in the app)
 *  - Demo:         ?demo in the address (or the app's demo switch) – a pretend pedal
 */
(function (root) {
  'use strict';

  var Native = root.HXNative || null;
  var isAndroid = !!Native;
  var isDemo = /[?&]demo\b/.test(location.search) || (isAndroid && Native.isDemo && Native.isDemo());

  function b64ToBytes(s) { var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function bytesToB64(b) { var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function hex(b) { return Array.prototype.map.call(b, function (x) { return (x < 16 ? '0' : '') + x.toString(16).toUpperCase(); }).join(' '); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Async native calls: the app answers through window.__hxNative(id, ok, payload)
  var pending = {}, nextId = 1;
  root.__hxNative = function (id, ok, payload) {
    var p = pending[id]; if (!p) return; delete pending[id];
    ok ? p.res(payload) : p.rej(new Error(payload || 'Cancelled'));
  };
  function nativeAsync(fn) {
    return new Promise(function (res, rej) { var id = nextId++; pending[id] = { res: res, rej: rej }; fn(id); });
  }

  // ------------------------------------------------------------------ demo pedal
  /** Pretends to be an HX Stomp: answers PC with nothing, echoes snapshot changes like the real one can. */
  function DemoPort(emit) { this.emit = emit; }
  DemoPort.prototype.send = function (bytes) {
    var self = this, st = bytes[0] & 0xF0, ch = bytes[0] & 0x0F;
    if (st === 0xB0 && bytes[1] === 69 && bytes[2] <= 3) setTimeout(function () { self.emit(new Uint8Array([0xB0 | ch, 69, bytes[2]])); }, 20);
  };

  // ------------------------------------------------------------------ MIDI
  function Midi() {
    this.connected = false; this.name = ''; this.listeners = []; this.outListeners = [];
    this._out = null; this._in = null; this._buf = []; this._status = 0;
  }
  Midi.prototype.onMessage = function (fn) { this.listeners.push(fn); };
  Midi.prototype.onSend = function (fn) { this.outListeners.push(fn); };
  Midi.prototype._emit = function (msg) { this.listeners.forEach(function (f) { try { f(msg); } catch (e) { console.error(e); } }); };
  /** Byte stream -> messages (Android delivers raw bytes). */
  Midi.prototype._feed = function (bytes) {
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b >= 0xF8) { this._emit(new Uint8Array([b])); continue; }
      if (b === 0xF0) { this._sx = [b]; continue; }
      if (this._sx) { this._sx.push(b); if (b === 0xF7) { this._emit(new Uint8Array(this._sx)); this._sx = null; } continue; }
      if (b & 0x80) { this._buf = [b]; this._status = b; }
      else if (this._status) { if (!this._buf.length) this._buf = [this._status]; this._buf.push(b); }
      var st = this._buf[0] & 0xF0, need = st === 0xC0 || st === 0xD0 ? 2 : 3;
      if (this._buf.length >= need) { this._emit(new Uint8Array(this._buf)); this._buf = []; }
    }
  };
  Midi.prototype.available = function () { return isDemo || isAndroid || !!navigator.requestMIDIAccess; };

  function score(name) { return /HX ?Stomp/i.test(name) ? 3 : /Line ?6|Helix|HX/i.test(name) ? 2 : 0; }

  /** Connects to the pedal (or the best MIDI port). Resolves with the port name. */
  Midi.prototype.connect = async function (preferName) {
    var self = this;
    if (isDemo) {
      self._out = new DemoPort(function (m) { self._emit(m); });
      self.connected = true; self.name = 'HX Stomp (demo)';
      return self.name;
    }
    if (isAndroid) {
      var name = await nativeAsync(function (id) { Native.midiOpen(id); });
      root.__hxMidiIn = function (b) { self._feed(b64ToBytes(b)); };
      root.__hxMidiClosed = function () { self.connected = false; self._emit(null); };
      self.connected = true; self.name = name;
      return name;
    }
    if (!navigator.requestMIDIAccess) throw new Error('This browser has no Web MIDI. Use Firefox, Chrome or Edge, and open the editor over https.');
    var access = await navigator.requestMIDIAccess();
    self.access = access;
    var outs = [], ins = [];
    access.outputs.forEach(function (p) { outs.push(p); });
    access.inputs.forEach(function (p) { ins.push(p); });
    self.ports = outs.map(function (p) { return p.name; });
    function pick(list) {
      if (preferName) for (var i = 0; i < list.length; i++) if (list[i].name === preferName) return list[i];
      return list.slice().sort(function (a, b) { return score(b.name) - score(a.name); })[0];
    }
    var out = pick(outs);
    if (!out) throw new Error('No MIDI device found. Is the HX Stomp connected with a USB cable, and USB MIDI on (Global Settings › MIDI/Tempo)?');
    var inp = null;
    ins.forEach(function (p) { if (!inp && p.name === out.name) inp = p; });
    if (!inp) ins.forEach(function (p) { if (!inp && score(p.name) && score(p.name) === score(out.name)) inp = p; });
    self._out = out; self._in = inp;
    if (inp) inp.onmidimessage = function (ev) { self._emit(ev.data); };
    var want = out.name;
    access.onstatechange = function (ev) {
      var p = ev.port; if (p.name !== want) return;
      if (p.state === 'disconnected') { if (p.type === 'output' && self.connected) { self.connected = false; self._emit(null); } return; }
      if (p.type === 'output') { self._out = p; if (!self.connected) { self.connected = true; self._emit('reconnected'); } }
      if (p.type === 'input') { self._in = p; p.onmidimessage = function (e) { self._emit(e.data); }; }
    };
    self.connected = true; self.name = out.name;
    try { localStorage.setItem('hx-midi-ok', '1'); } catch (e) { }
    return out.name;
  };

  /** Connects without a prompt when that's possible (app, demo, or MIDI already allowed). */
  Midi.prototype.autoConnect = async function (onFound) {
    var self = this;
    function tryNow() {
      if (self.connected || self._busy) return;
      self._busy = true;
      self.connect().then(function (n) { self._busy = false; onFound(n); }, function () { self._busy = false; });
    }
    if (isDemo) { tryNow(); return; }
    if (isAndroid) { root.__hxMidiAdded = tryNow; tryNow(); return; }
    if (!navigator.requestMIDIAccess) return;
    var ok = false;
    try { ok = (await navigator.permissions.query({ name: 'midi' })).state === 'granted'; } catch (e) { }
    try { if (!ok) ok = localStorage.getItem('hx-midi-ok') === '1'; } catch (e) { }
    if (!ok) return;
    try {
      var access = await navigator.requestMIDIAccess(), has = false;
      access.outputs.forEach(function (p) { if (score(p.name)) has = true; });
      access.addEventListener('statechange', function (ev) {
        if (ev.port.type === 'output' && ev.port.state === 'connected' && score(ev.port.name)) setTimeout(tryNow, 300);
      });
      if (has) tryNow();
    } catch (e) { }
  };

  Midi.prototype.disconnect = function () {
    this.clockStop();
    if (isAndroid && !isDemo) { try { Native.midiClose(); } catch (e) { } }
    else if (this._in) this._in.onmidimessage = null;
    this.connected = false;
  };

  Midi.prototype.send = function (bytes) {
    if (!this.connected) throw new Error('Not connected to the pedal');
    if (isAndroid && !isDemo) Native.midiSend(bytesToB64(bytes));
    else this._out.send(bytes);
    var u = new Uint8Array(bytes);
    this.outListeners.forEach(function (f) { try { f(u); } catch (e) { } });
  };

  /** MIDI clock, 24 ticks per quarter note. The pedal follows it when Rx MIDI Clock is USB or Auto. */
  Midi.prototype.clockStart = function (bpm) {
    var self = this;
    self.clockBpm = bpm; self.clockRunning = true;
    if (isAndroid && !isDemo) { Native.midiClockStart(bpm); return; }
    if (self._clk || isDemo) return;
    var next = performance.now() + 30;
    function pump() {
      if (!self.connected) { self.clockStop(); return; }
      var now = performance.now(), ahead = now + (document.hidden ? 1500 : 150);
      if (next < now - 200) next = now + 10;
      while (next < ahead) {
        try { self._out.send([0xF8], next); } catch (e) { self.clockStop(); return; }
        next += 60000 / (self.clockBpm * 24);
      }
    }
    self._clk = setInterval(pump, 25); pump();
  };
  Midi.prototype.clockSet = function (bpm) {
    this.clockBpm = bpm;
    if (isAndroid && !isDemo && this.clockRunning) Native.midiClockSet(bpm);
  };
  Midi.prototype.clockStop = function () {
    this.clockRunning = false;
    if (isAndroid && !isDemo) { try { Native.midiClockStop(); } catch (e) { } return; }
    if (this._clk) { clearInterval(this._clk); this._clk = null; }
  };

  // ------------------------------------------------------------------ the pedal's own USB interface (app only)
  /**
   * Reading preset names is not part of the official MIDI implementation. The Android app can do it
   * through the pedal's editor interface (the protocol HX Edit uses, as documented by OpenHX).
   */
  var Pedal = {
    available: function () { return isDemo || (isAndroid && !!Native.pedalPresets); },
    presets: async function () {
      if (isDemo) {
        await sleep(300);
        return DEMO_NAMES.map(function (n, i) { return { slot: i, name: n }; });
      }
      return JSON.parse(await nativeAsync(function (id) { Native.pedalPresets(id); }));
    },
    log: function () { return isAndroid && Native.pedalLog ? Native.pedalLog() : ''; }
  };

  var DEMO_NAMES = (function () {
    var n = ['Glass Clean', 'Sunday Crunch', 'Lead Boost', 'Ambient Swell', 'Tremolo Surf', 'Slapback Twang', 'Fuzz Wall',
      'Shimmer Pad', 'Funk Wah', 'Plexi Roar', 'Dream Chorus', 'Dotted Eighth', 'Blues Edge', 'Octave Synth', 'Spring Verb',
      'Acoustic Sim', 'Bass DI', 'Studio Dry', 'Rhythm Tight', 'Solo Liquid', 'Phaser Seventies', 'Vibe Haze', 'Doom Drop D',
      'Country Comp', 'Jazz Warm', 'Live Clean', 'Live Drive', 'Live Lead', 'Practice Amp', 'Headphones'];
    var out = [];
    for (var i = 0; i < 126; i++) out.push(n[i] || 'New Preset');
    return out;
  })();

  function saveFile(blob, name) {
    if (isAndroid && Native.saveFile) {
      return blob.arrayBuffer().then(function (buf) {
        return nativeAsync(function (id) { Native.saveFile(id, name, bytesToB64(new Uint8Array(buf))); });
      });
    }
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return Promise.resolve();
  }

  root.HXPlatform = { Midi: Midi, Pedal: Pedal, hex: hex, sleep: sleep, isAndroid: isAndroid, isDemo: isDemo, saveFile: saveFile, demoNames: DEMO_NAMES };
})(window);
