/*
 * HX Stomp Control — the HX Stomp's MIDI implementation.
 * Copyright (C) 2026 Jon Solberg — GPL-3.0-or-later (see LICENSE).
 *
 * From the HX Stomp Owner's Manual (firmware 3.80), chapter "MIDI" and
 * "Global Settings > MIDI/Tempo". Presets are recalled with Program Change 0–125.
 */
(function (root) {
  'use strict';
  var CC = {
    EXP1: 1, EXP2: 2,
    FS1: 49, FS2: 50, FS3: 51, FS4: 52, FS5: 53,
    LOOPER_REC: 60,      // 0–63 overdub, 64–127 record
    LOOPER_PLAY: 61,     // 0–63 stop, 64–127 play
    LOOPER_ONCE: 62,     // 64–127
    LOOPER_UNDO: 63,     // 64–127
    TAP: 64,             // 64–127
    LOOPER_REV: 65,      // 0–63 forward, 64–127 reverse
    LOOPER_HALF: 66,     // 0–63 full, 64–127 half speed
    TUNER: 68,           // 0–127: tuner screen on/off
    SNAPSHOT: 69,        // 0–3 = snapshot 1–4, 8 = next, 9 = previous
    ALL_BYPASS: 70,      // 0–63 bypass, 64–127 on
    MODE: 71,            // footswitch mode: 0 Stomp, 1 Scroll, 2 Preset, 3 Snapshot, 4 next, 5 previous
    PRESET_STEP: 72,     // 0–63 previous, 64–127 next
    VIEW: 73,            // toggles Play and Edit views
    KNOB1: 75, KNOB2: 76, KNOB3: 77,
    PAGE: 81             // 0–63 page left, 64–127 page right
  };

  /** Rows for the Help page: [CC, values, what it does]. */
  var TABLE = [
    [1, '0–127', 'EXP 1 pedal'], [2, '0–127', 'EXP 2 pedal'],
    [49, '0–127', 'FS1 (press 64–127, release 0–63)'], [50, '0–127', 'FS2'], [51, '0–127', 'FS3'],
    [52, '0–127', 'FS4 (external switch)'], [53, '0–127', 'FS5 (external switch)'],
    [60, '0–63 overdub · 64–127 record', 'Looper Record/Overdub'], [61, '0–63 stop · 64–127 play', 'Looper Play/Stop'],
    [62, '64–127', 'Looper Play Once'], [63, '64–127', 'Looper Undo/Redo'], [64, '64–127', 'Tap tempo'],
    [65, '0–63 forward · 64–127 reverse', 'Looper Forward/Reverse'], [66, '0–63 full · 64–127 half', 'Looper Full/Half speed'],
    [68, '0–127', 'Tuner screen on/off'], [69, '0–3 · 8 next · 9 previous', 'Snapshot select'],
    [70, '0–63 bypass · 64–127 on', 'All bypass'], [71, '0–5', 'Footswitch mode (Stomp, Scroll, Preset, Snapshot, next, previous)'],
    [72, '0–63 previous · 64–127 next', 'Preset down/up'], [73, '0–127', 'Play/Edit view'],
    [75, '0–127', 'Parameter knob 1'], [76, '0–127', 'Parameter knob 2'], [77, '0–127', 'Parameter knob 3'],
    [81, '0–63 left · 64–127 right', 'Page left/right']
  ];

  root.HXMidiMap = { CC: CC, TABLE: TABLE };
})(window);
