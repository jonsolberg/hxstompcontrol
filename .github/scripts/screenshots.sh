#!/usr/bin/env bash
# Installs the APK on the emulator, runs it in demo mode and captures screenshots + logcat.
set -x
mkdir -p shots
APK=app/build/outputs/apk/release/app-release.apk
PKG=se.jonsolberg.hxstomp
adb shell settings put global hide_error_dialogs 1
sleep 25
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS
adb install -r "$APK"
adb logcat -c
shot() { sleep 1; adb exec-out screencap -p > "shots/$1.png"; }

# Taps the first on-screen element whose text or content-desc contains $1.
tap_text() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null
  adb pull /sdcard/ui.xml shots/ui-last.xml >/dev/null
  XY=$(python3 - "$1" <<'PY'
import re, sys, xml.etree.ElementTree as ET
want = sys.argv[1].lower()
for n in ET.parse('shots/ui-last.xml').iter('node'):
    if want in (n.get('text', '') + ' ' + n.get('content-desc', '')).lower():
        x1, y1, x2, y2 = map(int, re.findall(r'\d+', n.get('bounds')))
        print((x1 + x2) // 2, (y1 + y2) // 2)
        break
PY
)
  if [ -n "$XY" ]; then adb shell input tap $XY; else echo "not found: $1"; fi
  sleep 2
}

# 1. Started without a pedal
adb shell am start -n $PKG/.MainActivity
sleep 6
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS
shot 01-not-connected

# 2. Demo mode: a simulated HX Stomp
adb shell am force-stop $PKG
adb shell am start -n $PKG/.MainActivity --ez demo true
sleep 6
shot 02-presets
tap_text "Lead Boost"
shot 03-selected
tap_text "Search presets"
adb shell input text "live"
sleep 1
adb shell input keyevent 111   # ESC hides the keyboard
shot 04-search
tap_text "USB log"
shot 05-usb-log

adb logcat -d > shots/logcat.txt
adb logcat -d | grep -E "AndroidRuntime|FATAL" > shots/crashes.txt || true
exit 0
