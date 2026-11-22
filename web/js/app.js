/*
 * HX Stomp Control — user interface.
 * Copyright (C) 2026 Jon Solberg — GPL-3.0-or-later (see LICENSE).
 */
(function () {
  'use strict';

  var VERSION = '0.2.3';
  var PF = window.HXPlatform, HLX = window.HLX, CC = window.HXMidiMap.CC;

  // ------------------------------------------------------------------ settings (kept in the browser)
  var KEY = PF.isDemo ? 'hx-settings-demo' : 'hx-settings';
  var DEF = {
    model: 'stomp', ch: 1, numbering: 'bank', theme: 'auto', port: '',
    fs: [{ label: 'FS1', color: '#9a7bff' }, { label: 'FS2', color: '#3ccf6b' }, { label: 'FS3', color: '#ff4a3d' },
      { label: 'FS4', color: '#3b82f6' }, { label: 'FS5', color: '#f5a524' }],
    names: null
  };
  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { }
    var out = JSON.parse(JSON.stringify(DEF));
    Object.keys(s).forEach(function (k) { out[k] = s[k]; });
    return out;
  }
  var CFG = loadSettings();
  function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(CFG)); } catch (e) { } }

  // ------------------------------------------------------------------ state
  var S = {
    page: 'direct',
    midi: new PF.Midi(),
    preset: null, snapshot: null, tuner: false, bypassed: false, knobs: [64, 64, 64], exp: [0, 0],
    looper: { rec: false, play: false, rev: false, half: false },
    tempo: 120, taps: [], clockOut: false, clockIn: null, clockTicks: [],
    seen: { any: false, pc: false, cc69: false, clock: false },
    log: [], logPaused: false,
    filter: '',
    set: null,        // open setlist {fileName, wrapper, inner, presets}
    doc: null,        // open preset {fileName, doc, preset, fromSetlist: index|null}
    docOrig: null, dirty: false, block: null, blockDsp: 'dsp0'
  };

  // ------------------------------------------------------------------ DOM helpers
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function $(id) { return document.getElementById(id); }
  function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
  function toast(msg, kind) {
    var t = h('div', { class: 'toast ' + (kind || '') }, msg);
    $('toasts').appendChild(t);
    var life = kind === 'err' ? 7000 : 3000;
    setTimeout(function () { t.classList.add('out'); }, life);
    setTimeout(function () { t.remove(); }, life + 500);
  }
  function errToast(e) { console.error(e); toast(e && e.message ? e.message : String(e), 'err'); }

  // ------------------------------------------------------------------ preset numbers and names
  function count() { return CFG.model === 'xl' ? 128 : 126; }
  function perBank() { return CFG.model === 'xl' ? 4 : 3; }
  function firstBank() { return CFG.model === 'xl' ? 1 : 0; }
  function label(slot) {
    if (slot == null) return '---';
    if (CFG.numbering === 'num') return pad(slot, 3);
    return pad(Math.floor(slot / perBank()) + firstBank(), 2) + 'ABCD'[slot % perBank()];
  }
  function names() {
    if (!CFG.names || CFG.names.length !== count()) {
      var n = []; for (var i = 0; i < count(); i++) n.push('');
      if (CFG.names) for (var j = 0; j < Math.min(n.length, CFG.names.length); j++) n[j] = CFG.names[j] || '';
      CFG.names = n;
    }
    return CFG.names;
  }
  function nameOf(slot) { return slot == null ? '' : (names()[slot] || ''); }

  // ------------------------------------------------------------------ MIDI out
  function ch() { return (Math.max(1, Math.min(16, CFG.ch | 0)) - 1); }
  function send(bytes) {
    try { S.midi.send(bytes); return true; }
    catch (e) { errToast(e); return false; }
  }
  function cc(n, v) { return send([0xB0 | ch(), n, Math.max(0, Math.min(127, v | 0))]); }
  function pc(n) { return send([0xC0 | ch(), n & 0x7F]); }

  function selectPreset(slot) {
    if (slot < 0 || slot >= count()) return;
    if (pc(slot)) { S.preset = slot; S.snapshot = null; refreshDirect(); refreshPresetMarks(); }
  }
  function stepPreset(dir) {
    if (!cc(CC.PRESET_STEP, dir > 0 ? 127 : 0)) return;
    if (S.preset != null) S.preset = (S.preset + dir + count()) % count();
    S.snapshot = null; refreshDirect(); refreshPresetMarks();
  }
  function selectSnapshot(i) {
    if (!cc(CC.SNAPSHOT, i)) return;
    if (i <= 3) S.snapshot = i;
    else if (S.snapshot != null) S.snapshot = (S.snapshot + (i === 8 ? 1 : -1) + snapCount()) % snapCount();
    refreshDirect();
  }
  function snapCount() { return CFG.model === 'xl' ? 4 : 3; }

  // ------------------------------------------------------------------ MIDI in
  function describe(m) {
    if (!m || !m.length) return '';
    var st = m[0] & 0xF0, c = (m[0] & 0x0F) + 1;
    if (m[0] === 0xF8) return 'Clock';
    if (m[0] === 0xFA) return 'Start'; if (m[0] === 0xFC) return 'Stop'; if (m[0] === 0xFB) return 'Continue';
    if (st === 0xC0) return 'Program ' + m[1] + ' (' + label(m[1]) + ')  ch ' + c;
    if (st === 0xB0) {
      var row = window.HXMidiMap.TABLE.filter(function (r) { return r[0] === m[1]; })[0];
      return 'CC ' + m[1] + ' = ' + m[2] + (row ? '  ' + row[2] : '') + '  ch ' + c;
    }
    if (st === 0x90) return 'Note on ' + m[1] + ' vel ' + m[2];
    if (st === 0x80) return 'Note off ' + m[1];
    if (m[0] === 0xF0) return 'SysEx (' + m.length + ' bytes)';
    return '';
  }
  function logMsg(dir, m) {
    if (m[0] === 0xF8 || S.logPaused) return;
    var t = new Date(), ts = pad(t.getHours(), 2) + ':' + pad(t.getMinutes(), 2) + ':' + pad(t.getSeconds(), 2) + '.' + pad(t.getMilliseconds(), 3);
    S.log.push({ t: ts, dir: dir, hex: PF.hex(m), txt: describe(m) });
    if (S.log.length > 500) S.log.splice(0, S.log.length - 500);
    if (S.page === 'midi') renderMonitor();
  }
  S.midi.onSend(function (m) { logMsg('out', m); });
  S.midi.onMessage(function (m) {
    if (m === null) { toast('The pedal was disconnected'); S.midi.clockStop(); S.clockOut = false; renderStatus(); render(); return; }
    if (m === 'reconnected') { toast('The pedal is back'); renderStatus(); return; }
    S.seen.any = true;
    logMsg('in', m);
    if (m[0] === 0xF8) { clockTick(); return; }
    var st = m[0] & 0xF0, mc = m[0] & 0x0F;
    if (mc !== ch() && st !== 0xF0) return;
    if (st === 0xC0) {
      S.seen.pc = true;
      if (m[1] < count()) { S.preset = m[1]; S.snapshot = null; refreshDirect(); refreshPresetMarks(); }
    } else if (st === 0xB0 && m[1] === CC.SNAPSHOT && m[2] <= 3) {
      S.seen.cc69 = true; S.snapshot = m[2]; refreshDirect();
    }
  });
  function clockTick() {
    var now = performance.now();
    S.seen.clock = true;
    S.clockTicks.push(now);
    if (S.clockTicks.length > 97) S.clockTicks.shift();
    if (S.clockTicks.length >= 25 && S.clockTicks.length % 24 === 1) {
      var span = S.clockTicks[S.clockTicks.length - 1] - S.clockTicks[0];
      S.clockIn = Math.round(60000 / (span / (S.clockTicks.length - 1) * 24) * 10) / 10;
      var el = $('clockIn'); if (el) el.textContent = S.clockIn.toFixed(1) + ' BPM from the pedal';
    }
  }

  // ------------------------------------------------------------------ connection
  function renderStatus() {
    var b = $('status');
    b.innerHTML = '';
    add(b, [h('span', { class: 'dot' + (S.midi.connected ? ' ok' : '') }),
      h('span', null, S.midi.connected ? S.midi.name : (S.midi.available() ? 'Connect pedal' : 'No MIDI in this browser'))]);
    var sp = S.preset != null ? ' · ' + label(S.preset) : '';
    if (S.midi.connected && sp) add(b.lastChild, sp);
  }
  async function connect(prefer) {
    try {
      var n = await S.midi.connect(prefer || CFG.port || undefined);
      toast('Connected: ' + n);
      renderStatus(); render();
    } catch (e) { errToast(e); renderStatus(); }
  }

  // ------------------------------------------------------------------ pages
  function setPage(p) {
    S.page = p;
    document.querySelectorAll('nav.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.page === p); });
    try { history.replaceState(null, '', location.pathname + location.search + '#' + p); } catch (e) { }
    render();
  }
  function render() {
    var m = $('main');
    m.innerHTML = '';
    var pages = { direct: pageDirect, presets: pagePresets, editor: pageEditor, midi: pageMidi, system: pageSystem, help: pageHelp };
    m.appendChild((pages[S.page] || pageDirect)());
    m.scrollTop = 0;
  }
  var HTTPS = 'https://jonsolberg.github.io/hxstompforandroid/';
  function notConnectedNote() {
    if (S.midi.connected) return null;
    if (!PF.isAndroid && !PF.isDemo && !window.isSecureContext) {
      return h('div', { class: 'warn' }, h('b', null, 'Direct mode needs the secure (https) version. '),
        'Browsers only allow USB MIDI on https pages. The Editor works here too. ',
        h('a', { href: HTTPS + location.hash }, 'Open the https version'), ' · ', h('a', { href: '?demo#direct' }, 'or try the demo'));
    }
    return h('div', { class: 'warn' },
      h('b', null, 'Not connected. '),
      S.midi.available()
        ? ['Connect the HX Stomp with a USB cable, turn on ', h('i', null, 'USB MIDI'), ' in Global Settings › MIDI/Tempo, then ',
          h('button', { class: 'small primary', onclick: function () { connect(); } }, 'Connect'), ' ',
          h('a', { href: '?demo#direct' }, 'or try the demo')]
        : 'This browser has no Web MIDI. Use Firefox, Chrome or Edge on a computer, or the Android app.');
  }

  // ---------------------------------------------------------------- Direct
  function pageDirect() {
    var page = h('div', { class: 'page' }, notConnectedNote());
    var fs = CFG.fs;

    // The pedal as a panel of fixed size (920 × 660), scaled to fit. Our own drawing of the layout:
    // screen, VIEW/ACTION and PAGE buttons with their knobs, VOLUME, three parameter knobs, footswitches and jacks.
    function at(x, y, el) { el.style.left = x + 'px'; el.style.top = y + 'px'; return el; }
    var conn = S.midi.connected;
    var lcd = h('div', { class: 'lcd' + (S.tuner ? ' tuner' : ''), id: 'lcd' });
    var panel = h('div', { class: 'hxpanel' + (conn ? '' : ' off') },
      // jacks along the top edge
      [[150, 'EXP 1/2'], [255, 'RETURN'], [360, 'SEND'], [480, 'INPUT'], [600, 'OUTPUT'], [720, 'PHONES'], [830, 'USB']].map(function (j, i) {
        return [at(j[0], -13, h('span', { class: i === 6 ? 'jack usb' : i === 5 ? 'jack mini' : 'jack' })), at(j[0], -34, h('span', { class: 'jlabel' }, j[1]))];
      }),
      at(56, 22, h('span', { class: 'screw' })), at(864, 22, h('span', { class: 'screw' })),
      // the screen
      at(275, 175, h('div', { class: 'bezel' }, lcd)),
      // VIEW / ACTION with the upper knob, PAGE with the lower knob
      at(610, 105, h('div', { class: 'pill' },
        hwkey('view', 'VIEW', 'Play/Edit view (CC 73)', function () { cc(CC.VIEW, 127); }),
        hwkey('action', 'ACTION', 'ACTION has no MIDI control', null))),
      at(610, 105, bigKnob('Turn: previous/next preset (CC 72)', function (d) { stepPreset(d); })),
      at(610, 160, h('span', { class: 'plabel bracket' }, 'SAVE')),
      at(610, 232, h('div', { class: 'pill' },
        hwkey('pl', '◀ PAGE', 'Page left (CC 81)', function () { cc(CC.PAGE, 0); }),
        hwkey('pr', 'PAGE ▶', 'Page right (CC 81)', function () { cc(CC.PAGE, 127); }))),
      at(610, 232, bigKnob('Turn: page left/right (CC 81)', function (d) { cc(CC.PAGE, d > 0 ? 127 : 0); })),
      at(610, 287, h('span', { class: 'plabel bracket' }, '☰')),
      at(810, 85, h('span', { class: 'plabel' }, 'VOLUME')),
      at(810, 145, h('div', { class: 'knob vol', title: 'The volume knob has no MIDI control' }, h('div', { class: 'k' }))),
      // the three parameter knobs
      [0, 1, 2].map(function (i) { return at(165 + i * 110, 372, knob('Knob ' + (i + 1), i)); }),
      at(720, 372, h('div', { class: 'panelinfo', id: 'panelinfo' })),
      // the footswitch section
      at(460, 440, h('span', { class: 'seamshade' })),
      [0, 1, 2].map(function (i) { return at([140, 460, 780][i], 545, footswitch(i, fs[i])); }));
    var wrap = h('div', { class: 'hxwrap' }, panel);
    add(page, wrap);
    setTimeout(function () { fitPanel(wrap, panel); }, 0);

    // the rest of the pedal's functions, as plain buttons
    var ext = [3, 4].map(function (i) {
      var b = h('button', { disabled: !conn, title: 'External footswitch ' + (i + 1) + ' (CC ' + (CC.FS1 + i) + ')' }, fs[i].label);
      momentary(b, CC.FS1 + i); return b;
    });
    add(page, h('div', { class: 'card ctlbar' }, h('div', { class: 'row' },
      h('button', { id: 'tapBtn', disabled: !conn, onclick: tap, title: 'Tap tempo (CC 64)' }, 'Tap'),
      h('button', { id: 'tunerBtn', disabled: !conn, title: 'Tuner on/off (CC 68)', onclick: function () { S.tuner = !S.tuner; cc(CC.TUNER, 127); refreshDirect(); } }, 'Tuner'),
      h('button', { id: 'bypassBtn', disabled: !conn, title: 'All bypass (CC 70)', onclick: function () { S.bypassed = !S.bypassed; cc(CC.ALL_BYPASS, S.bypassed ? 0 : 127); refreshDirect(); } }, 'All bypass'),
      h('button', { disabled: !conn, title: 'Next footswitch mode (CC 71 = 4)', onclick: function () { cc(CC.MODE, 4); } }, 'Mode'),
      h('span', { class: 'sep' }),
      h('button', { disabled: !conn, title: 'Previous preset (CC 72)', onclick: function () { stepPreset(-1); } }, '◀ Preset'),
      h('button', { disabled: !conn, title: 'Next preset (CC 72)', onclick: function () { stepPreset(1); } }, 'Preset ▶'),
      h('button', { disabled: !conn, title: 'Previous snapshot (CC 69 = 9)', onclick: function () { selectSnapshot(9); } }, '◀ Snapshot'),
      h('button', { disabled: !conn, title: 'Next snapshot (CC 69 = 8)', onclick: function () { selectSnapshot(8); } }, 'Snapshot ▶'),
      h('span', { class: 'sep' }), ext)));

    // --- tiles
    var snapBtns = h('div', { class: 'seg' });
    for (var i = 0; i < snapCount(); i++) (function (i) {
      snapBtns.appendChild(h('button', { class: S.snapshot === i ? 'on' : '', onclick: function () { selectSnapshot(i); } }, 'Snapshot ' + (i + 1)));
    })(i);
    var jump = h('select', { onchange: function () { selectPreset(+this.value); } },
      h('option', { value: '', disabled: true, selected: S.preset == null }, 'Go to preset…'),
      names().map(function (n, i) { return h('option', { value: i, selected: S.preset === i }, label(i) + (n ? '  ' + n : '')); }));
    var tiles = h('div', { class: 'tiles' },
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Presets and snapshots'),
        h('div', { class: 'row' }, jump), h('div', { class: 'row', style: 'margin-top:10px' }, snapBtns),
        h('p', { class: 'muted small', style: 'margin:10px 0 0' }, 'The pedal reports preset changes when MIDI PC Tx includes USB, and snapshot changes when Snapshot CC Send is on (see System).')),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Expression pedals'),
        [0, 1].map(function (i) {
          var v = h('span', { class: 'small' }, String(S.exp[i]));
          return h('div', { class: 'slider-row' }, h('span', null, 'EXP ' + (i + 1)),
            h('input', { type: 'range', min: 0, max: 127, value: S.exp[i], oninput: function () { S.exp[i] = +this.value; v.textContent = this.value; cc(i ? CC.EXP2 : CC.EXP1, S.exp[i]); } }), v);
        }),
        h('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'Works like a real expression pedal on whatever EXP 1/2 controls in the preset.')),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Looper'),
        h('div', { class: 'row' },
          loopBtn('Record', function () { cc(CC.LOOPER_REC, 127); S.looper.rec = true; S.looper.play = true; }),
          loopBtn('Overdub', function () { cc(CC.LOOPER_REC, 0); }),
          loopBtn('Play', function () { cc(CC.LOOPER_PLAY, 127); S.looper.play = true; }),
          loopBtn('Stop', function () { cc(CC.LOOPER_PLAY, 0); S.looper.play = false; }),
          loopBtn('Play once', function () { cc(CC.LOOPER_ONCE, 127); }),
          loopBtn('Undo/Redo', function () { cc(CC.LOOPER_UNDO, 127); })),
        h('div', { class: 'row', style: 'margin-top:8px' },
          toggle('Reverse', S.looper.rev, function (on) { S.looper.rev = on; cc(CC.LOOPER_REV, on ? 127 : 0); }),
          toggle('Half speed', S.looper.half, function (on) { S.looper.half = on; cc(CC.LOOPER_HALF, on ? 127 : 0); })),
        h('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'Needs a Looper block in the preset.')),
      h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Tempo'),
        h('div', { class: 'row' }, h('span', { class: 'tempo', id: 'tempoTxt' }, S.tempo.toFixed(1)), h('span', { class: 'muted' }, 'BPM'),
          h('span', { class: 'beat', id: 'beat' }), h('span', { class: 'grow' }),
          h('button', { onclick: tap }, 'Tap')),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('input', { type: 'number', min: 30, max: 240, step: 0.1, value: S.tempo, onchange: function () { setTempo(+this.value); } }),
          toggle('Send MIDI clock', S.clockOut, function (on) {
            S.clockOut = on;
            if (on) S.midi.clockStart(S.tempo); else S.midi.clockStop();
          })),
        h('p', { class: 'muted small', id: 'clockIn', style: 'margin:6px 0 0' },
          S.clockIn ? S.clockIn.toFixed(1) + ' BPM from the pedal' : 'Tap sends CC 64. MIDI clock needs Rx MIDI Clock = USB or Auto on the pedal.')));
    add(page, tiles);
    add(page, h('p', { class: 'muted small', style: 'text-align:center;margin-top:12px' },
      'Keys: ', kb('1'), kb('2'), kb('3'), ' footswitches · ', kb('←'), kb('→'), ' preset · ', kb('↑'), kb('↓'), ' snapshot · ',
      kb('T'), ' tap · ', kb('U'), ' tuner · ', kb('V'), ' view'));
    setTimeout(refreshDirect, 0);
    return page;
  }
  function kb(k) { return h('span', { class: 'kbd' }, k); }
  function hwkey(cls, text, title, fn) {
    return h('button', { class: 'hwkey ' + cls, title: title, disabled: !S.midi.connected || !fn, onclick: fn || undefined }, text);
  }
  /** A knob that turns in steps (the pedal's two endless knobs). */
  function bigKnob(title, onStep) {
    var cap = h('div', { class: 'k' }), k = h('div', { class: 'knob big', title: title }, cap);
    var rot = 0, acc = 0, lastY = null;
    function step(d) { if (!S.midi.connected) return; rot += d * 24; cap.style.setProperty('--rot', rot + 'deg'); onStep(d); }
    k.addEventListener('pointerdown', function (e) { k.setPointerCapture(e.pointerId); lastY = e.clientY; acc = 0; e.preventDefault(); });
    k.addEventListener('pointermove', function (e) {
      if (lastY === null) return;
      acc += lastY - e.clientY; lastY = e.clientY;
      while (acc > 22) { acc -= 22; step(1); } while (acc < -22) { acc += 22; step(-1); }
    });
    k.addEventListener('pointerup', function () { lastY = null; });
    k.addEventListener('wheel', function (e) { e.preventDefault(); step(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    return k;
  }
  function fitPanel(wrap, panel) {
    var W = 920, H = 660, TOP = 46;
    var s = Math.min(1, (wrap.clientWidth || W) / W);
    panel.style.transform = 'scale(' + s + ')';
    panel.style.top = Math.round(TOP * s) + 'px';
    panel.style.left = Math.max(0, Math.round(((wrap.clientWidth || W) - W * s) / 2)) + 'px';
    wrap.style.height = Math.ceil((H + TOP) * s) + 'px';
  }
  window.addEventListener('resize', function () { var w = document.querySelector('.hxwrap'), p = document.querySelector('.hxpanel'); if (w && p) fitPanel(w, p); });
  function hw(text, title, fn, id) {
    return h('button', { class: 'hwbtn', title: title, id: id, disabled: !S.midi.connected, onclick: fn || undefined }, text);
  }
  function loopBtn(text, fn) { return h('button', { disabled: !S.midi.connected, onclick: fn }, text); }
  function toggle(text, on, fn) {
    var b = h('button', { class: on ? 'on' : '', disabled: !S.midi.connected, onclick: function () { var v = !b.classList.contains('on'); b.classList.toggle('on', v); fn(v); } }, text);
    return b;
  }
  function momentary(el, n, ring) {
    var down = false;
    function press(e) { if (!S.midi.connected) return; e.preventDefault(); if (down) return; down = true; (ring || el).classList.add('down', 'lit'); cc(n, 127); }
    function release() { if (!down) return; down = false; (ring || el).classList.remove('down', 'lit'); cc(n, 0); }
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointerleave', release);
    el.addEventListener('pointercancel', release);
    el._press = press; el._release = release;
  }
  function footswitch(i, f) {
    var ring = h('div', { class: 'ring', id: 'fs' + i, style: '--c:' + f.color, title: f.label + ' — footswitch ' + (i + 1) + ' (CC ' + (CC.FS1 + i) + ')' },
      h('div', { class: 'nut' }), h('div', { class: 'cap' }));
    momentary(ring, CC.FS1 + i);
    return h('div', { class: 'fs' }, ring);
  }
  function knob(name, i) {
    var k = h('div', { class: 'k' }), v = h('div', { class: 'v' }, String(S.knobs[i]));
    var kn = h('div', { class: 'knob', title: name + ' (CC ' + (CC.KNOB1 + i) + ') — drag up/down, double-click for the middle' }, k);
    var el = h('div', { class: 'knobwrap' }, kn, h('span', { class: 'kl' }, name), v);
    function show() { k.style.setProperty('--rot', ((S.knobs[i] / 127) * 270 - 135) + 'deg'); v.textContent = S.knobs[i]; }
    var last = 0;
    function set(val) {
      val = Math.max(0, Math.min(127, Math.round(val)));
      if (val === S.knobs[i]) return;
      S.knobs[i] = val; show();
      var now = performance.now();
      if (now - last > 15) { last = now; if (S.midi.connected) cc(CC.KNOB1 + i, val); }
      else { clearTimeout(el._t); el._t = setTimeout(function () { if (S.midi.connected) cc(CC.KNOB1 + i, S.knobs[i]); }, 20); }
    }
    var startY = 0, startV = 0, drag = false;
    kn.addEventListener('pointerdown', function (e) { drag = true; startY = e.clientY; startV = S.knobs[i]; kn.setPointerCapture(e.pointerId); });
    kn.addEventListener('pointermove', function (e) { if (drag) set(startV + (startY - e.clientY) * 0.6); });
    kn.addEventListener('pointerup', function () { drag = false; });
    kn.addEventListener('wheel', function (e) { e.preventDefault(); set(S.knobs[i] + (e.deltaY < 0 ? 2 : -2)); }, { passive: false });
    kn.addEventListener('dblclick', function () { set(64); });
    show();
    return el;
  }
  function refreshDirect() {
    renderStatus();
    var lcd = $('lcd'); if (!lcd) return;
    lcd.className = 'lcd' + (S.tuner ? ' tuner' : '');
    lcd.innerHTML = '';
    var fs = CFG.fs;
    if (S.tuner) {
      add(lcd, [h('div', { class: 'pn' }, 'TUNER'), h('div', { class: 'pname muted' }, 'Tuning on the pedal'), h('div', { class: 'tunebar' })]);
    } else {
      add(lcd, [
        h('div', { class: 'snapicon', title: 'Snapshot' }, S.snapshot != null ? String(S.snapshot + 1) : '–'),
        h('div', { class: 'pn' }, label(S.preset)),
        h('div', { class: 'pname' }, S.preset == null ? (S.midi.connected ? 'Pick a preset' : '') : (nameOf(S.preset) || 'Preset ' + label(S.preset))),
        h('div', { class: 'chainline' }, h('i'), h('i'), h('i'), h('i'), h('i')),
        h('div', { class: 'fsl' }, [0, 1, 2].map(function (i) {
          return h('div', { style: 'color:' + fs[i].color }, h('span', null, fs[i].label), h('b', { style: 'border-color:' + fs[i].color }));
        }))
      ]);
    }
    var info = $('panelinfo');
    if (info) info.textContent = S.bypassed ? 'ALL BYPASS' : S.midi.connected ? 'MIDI ch ' + CFG.ch + (S.snapshot != null ? ' · snapshot ' + (S.snapshot + 1) : '') : 'not connected';
    var t = $('tunerBtn'); if (t) t.classList.toggle('on', S.tuner);
    var b = $('bypassBtn'); if (b) b.classList.toggle('on', S.bypassed);
    var tt = $('tempoTxt'); if (tt) tt.textContent = S.tempo.toFixed(1);
  }
  function tap() {
    if (!cc(CC.TAP, 127)) return;
    var now = performance.now();
    S.taps = S.taps.filter(function (t) { return now - t < 2500; });
    S.taps.push(now);
    if (S.taps.length >= 2) {
      var d = (S.taps[S.taps.length - 1] - S.taps[0]) / (S.taps.length - 1);
      setTempo(60000 / d);
    }
    var bt = $('beat'); if (bt) { bt.classList.add('on'); setTimeout(function () { bt.classList.remove('on'); }, 120); }
    var tb = $('tapBtn'); if (tb) { tb.classList.add('lit'); setTimeout(function () { tb.classList.remove('lit'); }, 120); }
  }
  function setTempo(bpm) {
    if (!isFinite(bpm)) return;
    S.tempo = Math.max(30, Math.min(240, Math.round(bpm * 10) / 10));
    if (S.clockOut) S.midi.clockSet(S.tempo);
    refreshDirect();
  }

  document.addEventListener('keydown', function (e) {
    if (S.page !== 'direct' || e.ctrlKey || e.metaKey || e.altKey || !S.midi.connected) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    var k = e.key;
    if (k >= '1' && k <= '3') { var r = $('fs' + (+k - 1)); if (r && r._press) r._press(e); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); stepPreset(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); stepPreset(1); }
    else if (k === 'ArrowUp') { e.preventDefault(); selectSnapshot(8); }
    else if (k === 'ArrowDown') { e.preventDefault(); selectSnapshot(9); }
    else if (k === 't' || k === 'T') tap();
    else if (k === 'u' || k === 'U') { S.tuner = !S.tuner; cc(CC.TUNER, 127); refreshDirect(); }
    else if (k === 'v' || k === 'V') cc(CC.VIEW, 127);
  });
  document.addEventListener('keyup', function (e) {
    if (e.key >= '1' && e.key <= '3') { var r = $('fs' + (+e.key - 1)); if (r && r._release) r._release(); }
  });

  // ---------------------------------------------------------------- Presets
  function pagePresets() {
    var page = h('div', { class: 'page' }, notConnectedNote());
    var src = h('div', { class: 'card' },
      h('h2', null, 'Presets'),
      h('p', { class: 'muted' }, 'Tap a preset to switch to it on the pedal (Program Change). Names are kept in this browser/app — ',
        PF.Pedal.available() ? 'read them from the pedal, ' : '', 'take them from a setlist file exported from HX Edit, or type them yourself.'),
      h('div', { class: 'row' },
        h('input', { type: 'search', placeholder: 'Find preset…', value: S.filter, class: 'grow',
          oninput: function () { S.filter = this.value; drawBanks(); } }),
        PF.Pedal.available() ? h('button', { class: 'primary', onclick: readNames }, 'Read names from pedal') : null,
        h('button', { onclick: function () { openFile('names'); } }, 'Names from setlist (.hls)…'),
        h('button', { onclick: exportNames }, 'Export list'),
        h('button', { onclick: function () { if (confirm('Forget all preset names?')) { CFG.names = null; saveSettings(); drawBanks(); } } }, 'Clear names')));
    add(page, src);
    var banks = h('div', { class: 'banks', id: 'banks' });
    add(page, banks);
    setTimeout(drawBanks, 0);
    return page;
  }
  function drawBanks() {
    var el = $('banks'); if (!el) return;
    el.innerHTML = '';
    var f = S.filter.trim().toLowerCase(), n = names(), per = perBank();
    for (var b = 0; b * per < count(); b++) {
      var rows = [];
      for (var j = 0; j < per; j++) {
        var s = b * per + j; if (s >= count()) break;
        if (f && (n[s] || '').toLowerCase().indexOf(f) < 0 && label(s).toLowerCase().indexOf(f) < 0) continue;
        rows.push(presetRow(s));
      }
      if (rows.length) el.appendChild(h('div', { class: 'bank' }, h('div', { class: 'bh' }, 'BANK ' + pad(b + firstBank(), 2)), rows));
    }
  }
  function presetRow(s) {
    var inSet = S.set && S.set.presets[s] && !HLX.isEmptyPreset(S.set.presets[s]);
    return h('div', { class: 'pr' + (S.preset === s ? ' cur' : ''), 'data-slot': s, onclick: function () { selectPreset(s); } },
      h('span', { class: 'num' }, label(s)),
      h('span', { class: 'nm' + (nameOf(s) ? '' : ' muted') }, nameOf(s) || 'New Preset'),
      h('span', { class: 'acts' },
        h('button', { class: 'small', title: 'Rename', onclick: function (e) { e.stopPropagation(); rename(s); } }, '✎'),
        inSet ? h('button', { class: 'small', title: 'Open in the editor', onclick: function (e) { e.stopPropagation(); openFromSetlist(s); } }, 'Edit') : null));
  }
  function refreshPresetMarks() {
    document.querySelectorAll('.pr').forEach(function (r) { r.classList.toggle('cur', +r.dataset.slot === S.preset); });
    renderStatus();
  }
  function rename(s) {
    var v = prompt('Name for preset ' + label(s), nameOf(s));
    if (v === null) return;
    names()[s] = v.slice(0, 16); saveSettings(); drawBanks(); refreshDirect();
  }
  async function readNames() {
    try {
      toast('Reading presets from the pedal…');
      var list = await PF.Pedal.presets(), n = names();
      list.forEach(function (p) { if (p.slot < n.length) n[p.slot] = p.name; });
      saveSettings(); drawBanks(); refreshDirect();
      toast('Read ' + list.length + ' preset names');
    } catch (e) { errToast(e); }
  }
  function exportNames() {
    var txt = names().map(function (n, i) { return label(i) + '\t' + (n || ''); }).join('\n') + '\n';
    PF.saveFile(new Blob([txt], { type: 'text/plain' }), 'hx-stomp-presets.txt').catch(errToast);
  }

  // ---------------------------------------------------------------- files
  var fileMode = 'editor';
  function openFile(mode) { fileMode = mode; var i = $('fileinput'); i.value = ''; i.click(); }
  $('fileinput').addEventListener('change', function () { if (this.files[0]) loadFile(this.files[0], fileMode); });
  async function loadFile(file, mode) {
    try {
      var r = await HLX.open(file);
      if (r.kind === 'setlist') {
        S.set = r;
        if (mode === 'names' || mode === 'editor') {
          var n = names();
          r.presets.forEach(function (p, i) { if (i < n.length) n[i] = HLX.isEmptyPreset(p) ? '' : HLX.presetName(p); });
          saveSettings();
          toast('Setlist "' + file.name + '": ' + r.presets.length + ' presets — names updated');
        }
        if (S.page === 'presets') drawBanks(); else if (mode === 'editor') render();
        return;
      }
      if (mode === 'names') { toast('That is a single preset. Pick a setlist (.hls) for names.', 'err'); return; }
      openDoc({ fileName: file.name, doc: r.doc, preset: r.preset, fromSetlist: null });
    } catch (e) { errToast(e); }
  }
  function openDoc(d) {
    S.doc = d; S.dirty = false; S.block = null; S.blockDsp = 'dsp0';
    S.docOrig = HLX.stringify(d.doc);
    setPage('editor');
  }
  function openFromSetlist(i) {
    var p = S.set.presets[i];
    openDoc({ fileName: (HLX.presetName(p) || 'preset') + '.hlx', doc: HLX.presetDoc(p), preset: HLX.presetDoc(p).data || p, fromSetlist: i });
  }
  function changed() { S.dirty = true; var b = $('dirtyMark'); if (b) b.style.display = ''; }

  // ---------------------------------------------------------------- Editor
  function pageEditor() {
    var page = h('div', { class: 'page' });
    if (!S.doc) {
      var drop = h('div', { class: 'drop' },
        h('p', null, h('b', null, 'Drop a preset (.hlx) or setlist (.hls) here')),
        h('p', null, h('button', { class: 'primary', onclick: function () { openFile('editor'); } }, 'Open file…')),
        h('p', { class: 'muted small' }, 'Export them from HX Edit (Preset › Export, or Export on a setlist). Edit here, save, and import the file with HX Edit.'));
      ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
      drop.addEventListener('dragleave', function () { drop.classList.remove('over'); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0], 'editor'); });
      add(page, h('div', { class: 'card' }, h('h2', null, 'Preset editor'),
        h('p', null, 'Edit HX Stomp presets as files: the name, tempo, every block\'s settings and on/off state, and the snapshots.'),
        drop));
      if (S.set) add(page, setlistCard());
      add(page, h('div', { class: 'warn' }, h('b', null, 'Live editing on the pedal is coming later. '),
        'The pedal\'s official MIDI implementation can\'t read or change a preset\'s blocks, so this works on files for now. ',
        'In Direct mode you can still turn the pedal\'s three parameter knobs and page through the blocks.'));
      return page;
    }
    var d = S.doc, p = d.preset;
    var nameIn = h('input', { type: 'text', maxlength: 16, value: HLX.presetName(p), style: 'font-weight:600;width:200px',
      oninput: function () { HLX.setPresetName(p, this.value); changed(); } });
    var g = p.tone.global || {};
    var tempoIn = h('input', { type: 'number', min: 20, max: 240, step: 0.1, value: g['@tempo'] != null ? g['@tempo'] : 120,
      onchange: function () { g['@tempo'] = +this.value; HLX.setFloat(g, '@tempo'); changed(); } });
    add(page, h('div', { class: 'card' },
      h('div', { class: 'row' }, h('b', null, 'Preset'), nameIn, h('span', { class: 'muted' }, 'Tempo'), tempoIn,
        h('span', { class: 'pill', id: 'dirtyMark', style: S.dirty ? '' : 'display:none' }, 'changed'),
        h('span', { class: 'grow' }),
        h('button', { class: 'primary', onclick: saveDoc }, 'Save .hlx'),
        d.fromSetlist != null ? h('button', { onclick: putBackInSetlist, title: 'Put the changes back into the open setlist' }, 'Back to setlist') : null,
        h('button', { onclick: revertDoc, title: 'Undo all changes since opening' }, 'Revert'),
        h('button', { onclick: function () { if (!S.dirty || confirm('Close without saving?')) { S.doc = null; render(); } } }, 'Close')),
      h('p', { class: 'muted small', style: 'margin:8px 0 0' }, d.fileName + (d.fromSetlist != null ? ' · from setlist position ' + label(d.fromSetlist) : '') +
        ' · import the saved file into HX Edit to put it on the pedal.')));

    // chain
    var dsps = ['dsp0', 'dsp1'].filter(function (k) { return p.tone[k] && HLX.blocks(p, k).length; });
    var chainCard = h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Signal chain'));
    dsps.forEach(function (dsp) {
      var bl = HLX.blocks(p, dsp), chain = h('div', { class: 'chain' });
      if (dsps.length > 1) add(chainCard, h('div', { class: 'muted small' }, dsp === 'dsp0' ? 'DSP 1' : 'DSP 2'));
      [0, 1].forEach(function (path) {
        var row = bl.filter(function (x) { return (x.kind === 'input' || x.kind === 'output') ? (x.key.slice(-1) === (path ? 'B' : 'A')) : x.path === path && x.kind !== 'cab'; });
        if (!row.some(function (x) { return x.kind === 'block' || x.kind === 'split' || x.kind === 'join'; }) && path === 1) return;
        var pr = h('div', { class: 'path' }, h('span', { class: 'pl' }, path ? 'B' : 'A'));
        row.forEach(function (x, j) {
          if (j) pr.appendChild(h('div', { class: 'wire' }));
          pr.appendChild(blockChip(dsp, x));
        });
        chain.appendChild(pr);
      });
      add(chainCard, chain);
    });
    if (!dsps.length) add(chainCard, h('p', { class: 'muted' }, 'This preset is empty.'));
    add(page, chainCard);

    if (S.block) add(page, blockCard(p, S.blockDsp, S.block));
    add(page, snapshotsCard(p));
    add(page, controllersCard(p));
    if (S.set) add(page, setlistCard());
    return page;
  }
  function blockChip(dsp, x) {
    var b = x.b, io = x.kind === 'input' || x.kind === 'output';
    var off = b['@enabled'] === false;
    var title = io ? (x.kind === 'input' ? 'Input ' : 'Output ') + x.key.slice(-1) : x.info.cat;
    return h('div', { class: 'blk' + (io ? ' io' : '') + (off ? ' off' : '') + (S.block === x.key && S.blockDsp === dsp ? ' sel' : ''),
      style: io ? '' : '--bc:' + x.info.color, title: b['@model'],
      onclick: function () { S.block = x.key; S.blockDsp = dsp; render(); setTimeout(function () { var c = $('blockCard'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 50); } },
      h('div', { class: 'bt' }, x.kind === 'split' ? 'Split' : x.kind === 'join' ? 'Merge' : title),
      h('div', { class: 'bn' }, io ? '' : x.info.name));
  }
  function blockCard(p, dsp, key) {
    var b = p.tone[dsp] && p.tone[dsp][key];
    if (!b) return null;
    var info = HLX.modelInfo(b['@model']);
    var ctl = HLX.controlled(p, dsp, key);
    var card = h('div', { class: 'card', id: 'blockCard' });
    var head = h('div', { class: 'row' },
      h('h3', { style: 'margin:0', class: 'grow' }, info.name, ' ', h('span', { class: 'pill' }, info.cat)),
      '@enabled' in b ? h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: b['@enabled'] !== false,
        onchange: function () { b['@enabled'] = this.checked; changed(); render(); } }), 'On') : null);
    add(card, head);
    add(card, h('p', { class: 'muted small' }, h('code', null, b['@model']), b['@stereo'] ? ' · stereo' : '', b['@trails'] != null ? ' · trails ' + (b['@trails'] ? 'on' : 'off') : ''));
    add(card, paramGrid(b, ctl));
    // an amp's linked cab
    var cabKey = b['@cab'];
    if (cabKey && p.tone[dsp][cabKey]) {
      var cb = p.tone[dsp][cabKey];
      add(card, [h('h3', null, 'Cab: ', HLX.modelInfo(cb['@model']).name), paramGrid(cb, HLX.controlled(p, dsp, cabKey))]);
    }
    return card;
  }
  function paramGrid(b, ctl) {
    var grid = h('div', { class: 'params' });
    HLX.params(b).forEach(function (k) {
      var v = b[k], input;
      if (typeof v === 'boolean') input = h('input', { type: 'checkbox', checked: v, onchange: function () { b[k] = this.checked; changed(); } });
      else {
        var fl = HLX.isFloat(b, k);
        input = h('input', { type: 'number', value: v, step: fl ? (Math.abs(v) <= 1 ? 0.01 : 0.1) : 1,
          onchange: function () { var x = +this.value; if (!isFinite(x)) return; b[k] = fl ? x : Math.round(x); changed(); } });
      }
      var c = ctl[k];
      grid.appendChild(h('div', { class: 'param' },
        h('span', { class: 'pn', title: k }, k, c ? h('span', { class: 'snapdot', title: controllerText(c) }, '● ' + controllerName(c['@controller'])) : null),
        input));
    });
    if (!grid.children.length) grid.appendChild(h('p', { class: 'muted' }, 'No settings.'));
    return grid;
  }
  function controllerName(n) {
    return ({ 1: 'EXP 1', 2: 'EXP 2', 9: 'Snapshot', 18: 'MIDI CC', 19: 'Snapshot' })[n] || ('controller ' + n);
  }
  function controllerText(c) {
    return controllerName(c['@controller']) + (c['@cc'] != null ? ' CC ' + c['@cc'] : '') + ': ' + c['@min'] + ' → ' + c['@max'];
  }
  function snapshotsCard(p) {
    var snaps = HLX.snapshots(p);
    var card = h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Snapshots'));
    if (!snaps.length) { add(card, h('p', { class: 'muted' }, 'No snapshots in this preset.')); return card; }
    var keys = [];
    ['dsp0', 'dsp1'].forEach(function (dsp) {
      HLX.blocks(p, dsp).forEach(function (x) { if (x.kind === 'block') keys.push({ dsp: dsp, key: x.key, info: x.info }); });
    });
    var showN = Math.max(snapCount(), snaps.filter(function (s) { return s.s['@valid']; }).length);
    snaps = snaps.slice(0, Math.max(showN, 1));
    var t = h('table', { class: 'grid snaps' });
    t.appendChild(h('tr', null, h('th', null, ''), snaps.map(function (s) {
      return h('th', null, h('input', { type: 'text', maxlength: 16, value: s.s['@name'] || ('SNAPSHOT ' + (s.index + 1)),
        oninput: function () { s.s['@name'] = this.value; s.s['@custom_name'] = true; changed(); } }));
    })));
    t.appendChild(h('tr', null, h('td', { class: 'muted' }, 'Tempo'), snaps.map(function (s) {
      return h('td', null, h('input', { type: 'number', step: 0.1, min: 20, max: 240, value: s.s['@tempo'] != null ? s.s['@tempo'] : 120,
        onchange: function () { s.s['@tempo'] = +this.value; HLX.setFloat(s.s, '@tempo'); changed(); } }));
    })));
    keys.forEach(function (k) {
      t.appendChild(h('tr', null, h('td', null, h('span', { style: 'color:' + k.info.color }, '■ '), k.info.name),
        snaps.map(function (s) {
          var bl = s.s.blocks && s.s.blocks[k.dsp];
          var on = bl && k.key in bl ? bl[k.key] : null;
          return h('td', null, h('input', { type: 'checkbox', checked: on === null ? p.tone[k.dsp][k.key]['@enabled'] !== false : on, title: 'Block on in this snapshot',
            onchange: function () { s.s.blocks = s.s.blocks || {}; s.s.blocks[k.dsp] = s.s.blocks[k.dsp] || {}; s.s.blocks[k.dsp][k.key] = this.checked; changed(); } }));
        })));
    });
    // per-snapshot parameter values
    snaps.forEach(function (s) {
      var c = s.s.controllers || {};
      Object.keys(c).forEach(function (dsp) {
        Object.keys(c[dsp] || {}).forEach(function (bk) {
          Object.keys(c[dsp][bk] || {}).forEach(function (pn) {
            var rowId = 'snp-' + dsp + bk + pn;
            var row = t.querySelector('[data-r="' + rowId + '"]');
            if (!row) {
              var blk = p.tone[dsp] && p.tone[dsp][bk];
              row = h('tr', { 'data-r': rowId }, h('td', null, (blk ? HLX.modelInfo(blk['@model']).name : bk) + ' › ', h('b', null, pn)),
                snaps.map(function () { return h('td'); }));
              t.appendChild(row);
            }
            var o = c[dsp][bk][pn], v = o['@value'], cell = row.children[1 + snaps.indexOf(s)];
            cell.innerHTML = '';
            cell.appendChild(typeof v === 'boolean'
              ? h('input', { type: 'checkbox', checked: v, onchange: function () { o['@value'] = this.checked; changed(); } })
              : h('input', { type: 'number', value: v, step: 0.01, onchange: function () { var x = +this.value; if (isFinite(x)) { o['@value'] = HLX.isFloat(o, '@value') ? x : Math.round(x); changed(); } } }));
          });
        });
      });
    });
    add(card, h('div', { style: 'overflow-x:auto' }, t));
    add(card, h('p', { class: 'muted small', style: 'margin:8px 0 0' }, 'Rows with a ', h('b', null, '›'), ' are settings that change per snapshot.'));
    return card;
  }
  function controllersCard(p) {
    var c = p.tone.controller, rows = [];
    if (c) Object.keys(c).forEach(function (dsp) {
      Object.keys(c[dsp] || {}).forEach(function (bk) {
        var blk = p.tone[dsp] && p.tone[dsp][bk];
        Object.keys(c[dsp][bk] || {}).forEach(function (pn) {
          var o = c[dsp][bk][pn];
          rows.push(h('tr', null, h('td', null, blk ? HLX.modelInfo(blk['@model']).name : bk), h('td', null, pn),
            h('td', null, controllerName(o['@controller']) + (o['@cc'] != null ? ' ' + o['@cc'] : '')),
            h('td', null, numIn(o, '@min')), h('td', null, numIn(o, '@max'))));
        });
      });
    });
    if (!rows.length) return null;
    return h('div', { class: 'card' }, h('h3', { style: 'margin-top:0' }, 'Controller assignments'),
      h('table', { class: 'grid' }, h('tr', null, h('th', null, 'Block'), h('th', null, 'Setting'), h('th', null, 'Controlled by'), h('th', null, 'Min'), h('th', null, 'Max')), rows));
  }
  function numIn(o, k) {
    if (typeof o[k] === 'boolean') return h('input', { type: 'checkbox', checked: o[k], onchange: function () { o[k] = this.checked; changed(); } });
    return h('input', { type: 'number', value: o[k], step: 0.01, onchange: function () { var x = +this.value; if (isFinite(x)) { o[k] = x; changed(); } } });
  }
  function setlistCard() {
    var sl = S.set;
    return h('div', { class: 'card' }, h('div', { class: 'row' }, h('b', null, 'Setlist: ' + sl.fileName), h('span', { class: 'grow' }),
      h('select', { onchange: function () { if (this.value !== '') openFromSetlist(+this.value); } },
        h('option', { value: '' }, 'Open a preset from the setlist…'),
        sl.presets.map(function (pp, i) { return HLX.isEmptyPreset(pp) ? null : h('option', { value: i }, label(i) + '  ' + HLX.presetName(pp)); })),
      h('button', { onclick: saveSetlist, title: 'Experimental: save the whole setlist with your changes' }, 'Save setlist .hls'),
      h('button', { onclick: function () { S.set = null; render(); } }, 'Close')));
  }
  function fileName(base, ext) { return (base || 'preset').replace(/[\\/:*?"<>|]+/g, '_').trim() + ext; }
  function saveDoc() {
    var d = S.doc;
    PF.saveFile(HLX.presetFile(d.doc), fileName(HLX.presetName(d.preset), '.hlx'))
      .then(function () { S.dirty = false; S.docOrig = HLX.stringify(d.doc); toast('Saved — import it with HX Edit'); render(); }, errToast);
  }
  function revertDoc() {
    if (!S.dirty) return;
    var doc = HLX.parse(S.docOrig);
    S.doc.doc = doc; S.doc.preset = HLX.presetOf(doc); S.dirty = false; render();
  }
  function putBackInSetlist() {
    var i = S.doc.fromSetlist, src = S.set.presets[i];
    var p = S.doc.preset;
    src.tone = p.tone; if (src.meta) src.meta.name = HLX.presetName(p); else src.meta = p.meta;
    var n = names(); if (i < n.length) { n[i] = HLX.presetName(p); saveSettings(); }
    S.dirty = false; toast('Put back into the setlist — save the setlist to keep it');
  }
  async function saveSetlist() {
    try {
      var blob = await HLX.setlistFile(S.set);
      await PF.saveFile(blob, S.set.fileName.replace(/\.hls$/i, '') + '-edited.hls');
      toast('Setlist saved (experimental) — import it with HX Edit');
    } catch (e) { errToast(e); }
  }

  // ---------------------------------------------------------------- MIDI page
  function pageMidi() {
    var pcIn = h('input', { type: 'number', min: 0, max: 127, value: S.preset || 0 });
    var ccN = h('input', { type: 'number', min: 0, max: 127, value: 69 }), ccV = h('input', { type: 'number', min: 0, max: 127, value: 0 });
    return h('div', { class: 'page' }, notConnectedNote(),
      h('div', { class: 'card' }, h('h2', null, 'Send'),
        h('div', { class: 'row' }, 'Program change', pcIn, h('button', { disabled: !S.midi.connected, onclick: function () { selectPreset(+pcIn.value); } }, 'Send'),
          h('span', { style: 'width:20px' }), 'CC', ccN, 'value', ccV,
          h('button', { disabled: !S.midi.connected, onclick: function () { cc(+ccN.value, +ccV.value); } }, 'Send')),
        h('p', { class: 'muted small', style: 'margin:8px 0 0' }, 'On MIDI channel ' + CFG.ch + ' (change it under System).')),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, 'Monitor'),
        h('button', { class: S.logPaused ? 'on' : '', onclick: function () { S.logPaused = !S.logPaused; this.classList.toggle('on', S.logPaused); } }, 'Pause'),
        h('button', { onclick: function () { S.log = []; renderMonitor(); } }, 'Clear')),
        h('div', { class: 'mon', id: 'mon', style: 'margin-top:10px' })), setTimeout(renderMonitor, 0) && null);
  }
  function renderMonitor() {
    var m = $('mon'); if (!m) return;
    m.innerHTML = '';
    if (!S.log.length) { m.appendChild(h('div', { class: 'muted' }, 'Nothing yet. Messages from and to the pedal show up here (MIDI clock is left out).')); return; }
    S.log.slice(-200).forEach(function (l) {
      m.appendChild(h('div', { class: l.dir }, l.t + ' ' + (l.dir === 'in' ? '◀ ' : '▶ ') + l.hex.padEnd(10) + ' ' + l.txt));
    });
    m.scrollTop = m.scrollHeight;
  }

  // ---------------------------------------------------------------- System
  function pageSystem() {
    var page = h('div', { class: 'page' });
    function check(ok, title, text) {
      return h('div', { class: 'check' }, h('span', { class: 'st ' + (ok ? 'ok' : 'no') }, ok ? '✓' : '•'),
        h('div', null, h('b', null, title), h('div', { class: 'muted small' }, text)));
    }
    add(page, h('div', { class: 'card' }, h('h2', null, 'Pedal setup'),
      h('p', { class: 'muted' }, 'These are set on the HX Stomp itself: press and hold the PAGE knobs (or use HX Edit) to open the menu, then Global Settings › MIDI/Tempo. A ✓ means the app has seen it working.'),
      check(S.midi.connected, 'USB MIDI: On', 'Page 3. Lets the pedal send and receive MIDI over the USB cable.'),
      check(S.midi.connected, 'MIDI Base Channel: ' + CFG.ch, 'Page 1. Must match the channel set below.'),
      check(false, 'MIDI PC Rx: USB or MIDI/USB', 'Page 3. Lets the app switch presets.'),
      check(S.seen.pc, 'MIDI PC Tx: USB or MIDI/USB', 'Page 3. The pedal tells the app when you change preset on it.'),
      check(S.seen.cc69, 'Snapshot CC Send: On', 'Page 4. The pedal tells the app when you change snapshot on it.'),
      check(S.seen.clock, 'Tx MIDI Clock: USB (optional)', 'Page 2. The app shows the pedal\'s tempo.'),
      check(false, 'Rx MIDI Clock: USB or Auto (optional)', 'Page 1. Lets the app\'s MIDI clock set the pedal\'s tempo.'),
      h('p', { class: 'muted small', style: 'margin:10px 0 0' }, 'Other global settings (inputs/outputs, footswitches, EXP pedals, displays) can only be changed on the pedal or in HX Edit.')));

    function sel(key, opts, after) {
      return h('select', { onchange: function () { CFG[key] = isNaN(+this.value) || key === 'port' ? this.value : +this.value; saveSettings(); if (after) after(); renderStatus(); } },
        opts.map(function (o) { return h('option', { value: o[0], selected: String(CFG[key]) === String(o[0]) }, o[1]); }));
    }
    var chs = []; for (var c = 1; c <= 16; c++) chs.push([c, 'Channel ' + c]);
    var ports = (S.midi.ports || []).map(function (n) { return [n, n]; });
    var form = h('div', { class: 'form' },
      'Pedal', sel('model', [['stomp', 'HX Stomp (126 presets, 3 snapshots)'], ['xl', 'HX Stomp XL (128 presets, 4 snapshots)']], function () { CFG.names = null; names(); }),
      'MIDI channel', sel('ch', chs),
      'Preset numbers', sel('numbering', [['bank', 'Banks (00A, 00B, 00C …)'], ['num', 'Numbers (000–125)']]),
      'Theme', sel('theme', [['auto', 'Like the system'], ['light', 'Light'], ['dark', 'Dark']], applyTheme),
      PF.isAndroid ? null : 'MIDI device', PF.isAndroid ? null : h('div', { class: 'row' }, sel('port', [['', 'Find the HX Stomp by itself']].concat(ports)),
        h('button', { onclick: function () { S.midi.disconnect(); connect(CFG.port); } }, 'Connect')));
    add(page, h('div', { class: 'card' }, h('h2', null, 'App settings'), form));

    var palette = ['#9a7bff', '#3ccf6b', '#ff4a3d', '#3b82f6', '#f5a524', '#ec4899', '#14b8a6', '#e5e7eb'];
    add(page, h('div', { class: 'card' }, h('h2', null, 'Footswitch labels'),
      h('p', { class: 'muted' }, 'Shown on the on-screen pedal. The pedal\'s own labels can\'t be read over MIDI.'),
      h('div', { class: 'form' }, CFG.fs.map(function (f, i) {
        return [h('span', null, 'FS' + (i + 1) + (i > 2 ? ' (external)' : '')),
          h('div', { class: 'row' }, h('input', { type: 'text', maxlength: 14, value: f.label, oninput: function () { f.label = this.value; saveSettings(); } }),
            h('div', { class: 'colors' }, palette.map(function (c) {
              return h('button', { class: f.color === c ? 'sel' : '', style: 'background:' + c, title: c,
                onclick: function () { f.color = c; saveSettings(); render(); } });
            })))];
      }))));
    add(page, h('div', { class: 'card' }, h('h2', null, 'About'),
      h('p', null, 'HX Stomp Control ' + VERSION + (PF.isDemo ? ' · demo mode' : '') + (PF.isAndroid ? ' · Android app' : ' · web')),
      h('div', { class: 'row' },
        PF.isDemo ? h('a', { href: location.pathname }, 'Leave the demo') : h('a', { href: '?demo' }, 'Try the demo (no pedal needed)'),
        PF.isAndroid ? h('button', { onclick: function () { var pre = $('usblog'); pre.style.display = ''; pre.textContent = PF.Pedal.log() || '(empty — use Presets › Read names from pedal first)'; } }, 'Show USB log') : null,
        h('button', { onclick: function () { if (confirm('Reset all app settings and preset names?')) { localStorage.removeItem(KEY); location.reload(); } } }, 'Reset settings')),
      h('pre', { id: 'usblog', class: 'mon', style: 'display:none;margin-top:10px;white-space:pre-wrap' })));
    return page;
  }

  // ---------------------------------------------------------------- Help
  function pageHelp() {
    var rows = window.HXMidiMap.TABLE.map(function (r) { return h('tr', null, h('td', null, String(r[0])), h('td', null, r[1]), h('td', null, r[2])); });
    return h('div', { class: 'page' },
      h('div', { class: 'warn' }, h('b', null, 'Experimental and under development. '), 'Independent hobby project, not affiliated with Line 6 or Yamaha Guitar Group.'),
      h('div', { class: 'card' }, h('h2', null, 'What it does'),
        h('p', null, h('b', null, 'Direct'), ' — play the HX Stomp from the screen: footswitches, the three parameter knobs, presets, snapshots, tuner, tap tempo, all bypass, EXP 1/2, the looper and MIDI clock.'),
        h('p', null, h('b', null, 'Presets'), ' — all presets with their names; tap one to switch to it.'),
        h('p', null, h('b', null, 'Editor'), ' — open preset (.hlx) and setlist (.hls) files exported from HX Edit and change names, tempo, block settings, blocks on/off and snapshots. Save, then import with HX Edit.'),
        h('p', null, h('b', null, 'MIDI'), ' — see everything that goes to and from the pedal, and send your own messages.'),
        h('p', null, h('b', null, 'System'), ' — the pedal settings Direct mode needs, with a live check, and the app\'s own settings.')),
      h('div', { class: 'card' }, h('h2', null, 'Which browser'),
        h('table', { class: 'grid' },
          h('tr', null, h('th', null, ''), h('th', null, 'Direct, Presets, MIDI'), h('th', null, 'Editor')),
          h('tr', null, h('td', null, 'Firefox, Chrome, Edge, Opera on a computer'), h('td', null, '✅ over https (asks for MIDI permission the first time)'), h('td', null, '✅')),
          h('tr', null, h('td', null, 'Android app'), h('td', null, '✅ plus reading preset names from the pedal'), h('td', null, '✅')),
          h('tr', null, h('td', null, 'Safari, iPhone/iPad'), h('td', null, '❌ no Web MIDI'), h('td', null, '✅')))),
      h('div', { class: 'card' }, h('h2', null, 'How Direct mode talks to the pedal'),
        h('p', null, 'Only with the MIDI messages in the HX Stomp Owner\'s Manual: Program Change 0–125 picks a preset, and these control changes do the rest. Every message goes out on the MIDI channel set under System.'),
        h('table', { class: 'grid' }, h('tr', null, h('th', null, 'CC'), h('th', null, 'Values'), h('th', null, 'What it does')), rows),
        h('p', { class: 'muted small', style: 'margin:8px 0 0' }, 'Footswitches are momentary: the app sends 127 when you press and 0 when you let go, like a real switch.')),
      h('div', { class: 'card' }, h('h2', null, 'Live editing'),
        h('p', null, 'Changing blocks and settings directly on the pedal, like HX Edit does, needs the pedal\'s private USB protocol. It isn\'t documented by Line 6, so it\'s being worked out step by step and will come in a later version. Reading preset names in the Android app already uses it (based on the OpenHX project\'s documentation).')),
      h('div', { class: 'card' }, h('h2', null, 'About'),
        h('p', null, 'HX Stomp Control ' + VERSION + ' · © 2026 Jon Solberg. Free software under the GNU GPL v3 or later. Not affiliated with Line 6.'),
        h('p', null, h('a', { href: 'https://github.com/jonsolberg/hxstompforandroid', target: '_blank', rel: 'noopener' }, 'Source and help on GitHub'), ' · ',
          h('a', { href: 'https://jonsolberg.se:8080/', target: '_blank', rel: 'noopener' }, 'jonsolberg.se'), ' · ',
          h('a', { href: 'https://ko-fi.com/jonsolberg', target: '_blank', rel: 'noopener' }, '❤️ Support me on Ko-fi')),
        h('p', { class: 'muted small' }, 'Line 6, HX Stomp, HX Edit and Helix are trademarks of Yamaha Guitar Group, Inc. HX Stomp Control ' + VERSION + '.')));
  }

  // ------------------------------------------------------------------ start
  function applyTheme() {
    if (CFG.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', CFG.theme);
  }
  window.hxBack = function () { if (S.page !== 'direct') { setPage('direct'); return true; } return false; };
  window.addEventListener('beforeunload', function (e) { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  document.querySelectorAll('nav.tabs button').forEach(function (b) { b.addEventListener('click', function () { setPage(b.dataset.page); }); });
  $('status').addEventListener('click', function () { if (!S.midi.connected) connect(); else setPage('system'); });
  document.addEventListener('dragover', function (e) { e.preventDefault(); });
  document.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0], 'editor'); });

  applyTheme();
  var start = (location.hash || '').replace('#', '');
  setPage(['direct', 'presets', 'editor', 'midi', 'system', 'help'].indexOf(start) >= 0 ? start : 'direct');
  renderStatus();
  S.midi.autoConnect(function (n) {
    toast('Connected: ' + n); renderStatus(); render();
    if (PF.isDemo) { S.preset = 2; S.snapshot = 0; if (!names().some(Boolean)) { PF.demoNames.forEach(function (x, i) { if (i < count()) names()[i] = x; }); } refreshDirect(); }
  });
})();
