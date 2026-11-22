/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.media.midi.MidiDevice
import android.media.midi.MidiDeviceInfo
import android.media.midi.MidiInputPort
import android.media.midi.MidiManager
import android.media.midi.MidiOutputPort
import android.media.midi.MidiReceiver
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.ViewGroup
import android.widget.FrameLayout
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import se.jonsolberg.hxstomp.usb.HxSession
import se.jonsolberg.hxstomp.usb.HxUsbConnection
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.locks.LockSupport

/**
 * Hosts the bundled editor (assets = the web version in ../web) in a WebView and gives it
 *  - USB MIDI through android.media.midi (Direct mode, the documented MIDI implementation), and
 *  - the pedal's own USB editor interface, used only to read the preset names (experimental).
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private val ui = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    private var midiManager: MidiManager? = null
    private var midiDevice: MidiDevice? = null
    private var midiIn: MidiInputPort? = null   // we send into the pedal's input port
    private var midiOut: MidiOutputPort? = null // and listen on its output port
    private var removeCallback: MidiManager.DeviceCallback? = null

    @Volatile private var clockRun = false
    @Volatile private var clockBpm = 120.0
    private var clockThread: Thread? = null

    private var pendingPresetsId = -1
    private val usbLog = ArrayList<String>()
    private val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.ROOT)

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingSave: Pair<Int, ByteArray>? = null

    private val openFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        fileCallback?.onReceiveValue(if (uri != null) arrayOf(uri) else null)
        fileCallback = null
    }
    private val createFile = registerForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val (id, bytes) = pendingSave ?: return@registerForActivityResult
        pendingSave = null
        if (uri == null) { reply(id, false, "Cancelled"); return@registerForActivityResult }
        try {
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw IOException("Cannot write the file")
            reply(id, true, "")
        } catch (e: Exception) { reply(id, false, e.message) }
    }

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != ACTION_USB_PERMISSION) return
            val id = pendingPresetsId
            pendingPresetsId = -1
            if (id < 0) return
            if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) readPresets(id)
            else reply(id, false, "USB permission was denied")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        web = WebView(this)
        web.setBackgroundColor(getColor(R.color.bg))
        // The WebView ignores its own padding, so the system bars are kept clear by a container around it.
        val root = FrameLayout(this)
        root.setBackgroundColor(getColor(R.color.bg))
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowContentAccess = false
            blockNetworkLoads = true // everything is bundled; nothing comes from the network
            textZoom = 100
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "http" || u.scheme == "https") {
                    try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: ActivityNotFoundException) { }
                    return true
                }
                return u.scheme != "file"
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                return try { openFile.launch(arrayOf("*/*")); true } catch (_: ActivityNotFoundException) { fileCallback = null; false }
            }
        }
        web.addJavascriptInterface(Bridge(), "HXNative")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.hxBack&&hxBack()") { r -> if (r != "true") finish() }
            }
        })

        ContextCompat.registerReceiver(this, usbReceiver, IntentFilter(ACTION_USB_PERMISSION), ContextCompat.RECEIVER_NOT_EXPORTED)
        midiManager = getSystemService(Context.MIDI_SERVICE) as MidiManager?
        // Connect by itself when the pedal is plugged in.
        @Suppress("DEPRECATION")
        midiManager?.registerDeviceCallback(object : MidiManager.DeviceCallback() {
            override fun onDeviceAdded(info: MidiDeviceInfo) {
                if (score(info) > 0) web.evaluateJavascript("window.__hxMidiAdded&&__hxMidiAdded()", null)
            }
        }, ui)

        val demo = intent?.getBooleanExtra(EXTRA_DEMO, false) == true
        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl("file:///android_asset/index.html" + if (demo) "?demo" else "")
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        closeMidi()
        try { unregisterReceiver(usbReceiver) } catch (_: Exception) { }
        io.shutdownNow()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ JS callbacks

    private fun js(code: String) { ui.post { web.evaluateJavascript(code, null) } }

    private fun reply(id: Int, ok: Boolean, payload: String?) {
        js("window.__hxNative&&__hxNative($id,$ok,${JSONObject.quote(payload ?: "")})")
    }

    // ------------------------------------------------------------------ MIDI

    private fun score(info: MidiDeviceInfo): Int {
        val p = info.properties
        val all = listOf(MidiDeviceInfo.PROPERTY_NAME, MidiDeviceInfo.PROPERTY_PRODUCT, MidiDeviceInfo.PROPERTY_MANUFACTURER)
            .joinToString(" ") { p.getString(it) ?: "" }.uppercase(Locale.ROOT)
        if (info.inputPortCount == 0 || info.outputPortCount == 0) return -1
        var s = 0
        if (all.contains("HX STOMP") || all.contains("HXSTOMP")) s += 4
        if (all.contains("LINE 6") || all.contains("LINE6") || all.contains("HELIX")) s += 2
        if (info.type == MidiDeviceInfo.TYPE_USB) s += 1
        return s
    }

    private fun deviceName(info: MidiDeviceInfo): String =
        info.properties.getString(MidiDeviceInfo.PROPERTY_NAME)
            ?: info.properties.getString(MidiDeviceInfo.PROPERTY_PRODUCT) ?: "MIDI device"

    @Suppress("DEPRECATION")
    private fun openMidi(id: Int) {
        val mm = midiManager ?: return reply(id, false, "This phone has no MIDI support")
        closeMidi()
        val best = mm.devices.maxByOrNull { score(it) }?.takeIf { score(it) > 0 }
            ?: return reply(id, false, "No USB MIDI device found. Connect the HX Stomp with a USB data cable (USB-C/OTG) and turn on USB MIDI in Global Settings › MIDI/Tempo.")
        mm.openDevice(best, { device ->
            if (device == null) { reply(id, false, "Could not open ${deviceName(best)}"); return@openDevice }
            midiDevice = device
            midiIn = device.openInputPort(0)
            midiOut = device.openOutputPort(0)
            if (midiIn == null) { closeMidi(); reply(id, false, "The MIDI port is busy (another app may be using it)"); return@openDevice }
            midiOut?.connect(object : MidiReceiver() {
                override fun onSend(msg: ByteArray, offset: Int, count: Int, timestamp: Long) {
                    val b64 = Base64.encodeToString(msg, offset, count, Base64.NO_WRAP)
                    js("window.__hxMidiIn&&__hxMidiIn('$b64')")
                }
            })
            removeCallback = object : MidiManager.DeviceCallback() {
                override fun onDeviceRemoved(removed: MidiDeviceInfo) {
                    if (removed.id == best.id) { closeMidi(); js("window.__hxMidiClosed&&__hxMidiClosed()") }
                }
            }.also { mm.registerDeviceCallback(it, ui) }
            reply(id, true, deviceName(best))
        }, ui)
    }

    private fun closeMidi() {
        stopClock()
        try { midiOut?.close() } catch (_: IOException) { }
        try { midiIn?.close() } catch (_: IOException) { }
        try { midiDevice?.close() } catch (_: IOException) { }
        removeCallback?.let { midiManager?.unregisterDeviceCallback(it) }
        midiOut = null; midiIn = null; midiDevice = null; removeCallback = null
    }

    private fun startClock() {
        if (clockThread?.isAlive == true) return
        clockRun = true
        clockThread = Thread({
            val tick = byteArrayOf(0xF8.toByte())
            var next = System.nanoTime()
            while (clockRun) {
                val now = System.nanoTime()
                if (now < next) { LockSupport.parkNanos(next - now); continue }
                try { midiIn?.send(tick, 0, 1) } catch (_: IOException) { }
                next += (60e9 / (clockBpm * 24)).toLong()
                if (System.nanoTime() - next > 100_000_000L) next = System.nanoTime()
            }
        }, "midi-clock").apply { priority = Thread.MAX_PRIORITY; start() }
    }

    private fun stopClock() {
        clockRun = false
        clockThread?.interrupt()
        clockThread = null
    }

    // ------------------------------------------------------------------ the pedal's editor interface

    private fun log(line: String) {
        synchronized(usbLog) {
            usbLog.add("${time.format(Date())} $line")
            if (usbLog.size > 3000) usbLog.subList(0, usbLog.size - 3000).clear()
        }
    }

    private fun requestPresets(id: Int) {
        val usb = getSystemService(UsbManager::class.java)
        val device: UsbDevice = HxUsbConnection.findDevice(usb)
            ?: return reply(id, false, "No HX Stomp found on USB")
        if (usb.hasPermission(device)) { readPresets(id); return }
        pendingPresetsId = id
        val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(this, 0, Intent(ACTION_USB_PERMISSION).setPackage(packageName), flags)
        usb.requestPermission(device, pi)
    }

    private fun readPresets(id: Int) {
        io.execute {
            val usb = getSystemService(UsbManager::class.java)
            val device = HxUsbConnection.findDevice(usb) ?: return@execute reply(id, false, "No HX Stomp found on USB")
            var c: HxUsbConnection? = null
            try {
                c = HxUsbConnection.open(usb, device, ::log)
                val presets = HxSession(c, ::log).listPresets(c.model)
                val out = JSONArray()
                presets.forEach { out.put(JSONObject().put("slot", it.slot).put("name", it.name)) }
                reply(id, true, out.toString())
            } catch (e: Exception) {
                log("!! ${e.javaClass.simpleName}: ${e.message}")
                reply(id, false, (e.message ?: e.javaClass.simpleName) + " — the USB log is under System › About.")
            } finally {
                c?.close()
            }
        }
    }

    // ------------------------------------------------------------------ the bridge

    private inner class Bridge {
        @JavascriptInterface fun isDemo(): Boolean = intent?.getBooleanExtra(EXTRA_DEMO, false) == true
        @JavascriptInterface fun version(): String = BuildConfigVersion.NAME

        @JavascriptInterface fun midiOpen(id: Int) { ui.post { openMidi(id) } }
        @JavascriptInterface fun midiClose() { ui.post { closeMidi() } }
        @JavascriptInterface fun midiSend(b64: String) {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            try { midiIn?.send(bytes, 0, bytes.size) } catch (_: IOException) { }
        }
        @JavascriptInterface fun midiClockStart(bpm: Double) { clockBpm = bpm; startClock() }
        @JavascriptInterface fun midiClockSet(bpm: Double) { clockBpm = bpm }
        @JavascriptInterface fun midiClockStop() { stopClock() }

        @JavascriptInterface fun pedalPresets(id: Int) { ui.post { requestPresets(id) } }
        @JavascriptInterface fun pedalLog(): String = synchronized(usbLog) { usbLog.joinToString("\n") }

        @JavascriptInterface fun saveFile(id: Int, name: String, b64: String) {
            ui.post {
                pendingSave = id to Base64.decode(b64, Base64.DEFAULT)
                try { createFile.launch(name) } catch (_: ActivityNotFoundException) { pendingSave = null; reply(id, false, "No file picker available") }
            }
        }
    }

    companion object {
        const val ACTION_USB_PERMISSION = "se.jonsolberg.hxstomp.USB_PERMISSION"
        const val EXTRA_DEMO = "demo"
    }
}

/** The app version, shown in the web UI (kept here so no BuildConfig generation is needed). */
object BuildConfigVersion { const val NAME = "0.2.3" }
