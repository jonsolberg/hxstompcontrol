/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp

import android.app.Application
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import se.jonsolberg.hxstomp.usb.HxModel
import se.jonsolberg.hxstomp.usb.HxSession
import se.jonsolberg.hxstomp.usb.HxUsbConnection
import se.jonsolberg.hxstomp.usb.Preset
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class UiState(
    val model: HxModel? = null,
    val connected: Boolean = false,
    val busy: Boolean = false,
    val status: String = "Connect your HX Stomp with a USB cable.",
    val error: String? = null,
    val presets: List<Preset> = emptyList(),
    val selected: Int? = null,
    val log: List<String> = emptyList(),
)

class StompViewModel(app: Application) : AndroidViewModel(app) {
    private val usb = app.getSystemService(UsbManager::class.java)
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    private val lock = Mutex()
    private var connection: HxUsbConnection? = null
    private val time = SimpleDateFormat("HH:mm:ss.SSS", Locale.ROOT)

    private fun log(line: String) {
        val stamped = "${time.format(Date())} $line"
        _state.update { it.copy(log = (it.log + stamped).takeLast(2000)) }
    }

    fun findDevice(): UsbDevice? = HxUsbConnection.findDevice(usb)

    fun hasPermission(device: UsbDevice) = usb.hasPermission(device)

    fun noDevice() {
        if (connection == null) {
            _state.update { it.copy(status = "No HX device found. Connect it with a USB (OTG) cable.", error = null) }
        }
    }

    fun permissionDenied() {
        _state.update { it.copy(status = "USB permission was denied.", error = null) }
    }

    /** Opens the device (permission already granted) and reads the preset list. */
    fun connect(device: UsbDevice) {
        viewModelScope.launch(Dispatchers.IO) {
            lock.withLock {
                if (connection?.device?.deviceId == device.deviceId) return@withLock
                connection?.close()
                connection = null
                _state.update { it.copy(busy = true, error = null, status = "Connecting…") }
                try {
                    val c = HxUsbConnection.open(usb, device, ::log)
                    connection = c
                    _state.update { it.copy(model = c.model, connected = true, status = "Connected to ${c.model.name}") }
                } catch (e: Exception) {
                    log("!! ${e.message}")
                    _state.update { it.copy(busy = false, error = e.message, status = "Could not connect") }
                    return@withLock
                }
            }
            refresh()
        }
    }

    fun refresh() {
        viewModelScope.launch(Dispatchers.IO) {
            lock.withLock {
                val c = connection ?: return@withLock
                _state.update { it.copy(busy = true, error = null, status = "Reading presets…") }
                try {
                    val presets = HxSession(c, ::log).listPresets(c.model)
                    _state.update {
                        it.copy(busy = false, presets = presets, status = "${c.model.name} · ${presets.size} presets")
                    }
                } catch (e: Exception) {
                    log("!! ${e.javaClass.simpleName}: ${e.message}")
                    _state.update { it.copy(busy = false, error = e.message ?: e.javaClass.simpleName, status = "Reading presets failed") }
                }
            }
        }
    }

    fun select(slot: Int) {
        viewModelScope.launch(Dispatchers.IO) {
            lock.withLock {
                val c = connection ?: return@withLock
                _state.update { it.copy(busy = true, error = null) }
                try {
                    HxSession(c, ::log).selectPreset(slot)
                    _state.update { it.copy(busy = false, selected = slot) }
                } catch (e: Exception) {
                    log("!! ${e.javaClass.simpleName}: ${e.message}")
                    _state.update { it.copy(busy = false, error = e.message ?: e.javaClass.simpleName) }
                }
            }
        }
    }

    fun detached(device: UsbDevice?) {
        viewModelScope.launch(Dispatchers.IO) {
            lock.withLock {
                val c = connection ?: return@withLock
                if (device != null && device.deviceId != c.device.deviceId) return@withLock
                c.close()
                connection = null
                log("-- device disconnected")
                _state.update {
                    it.copy(connected = false, busy = false, selected = null, status = "${c.model.name} disconnected")
                }
            }
        }
    }

    fun clearLog() = _state.update { it.copy(log = emptyList()) }

    override fun onCleared() {
        connection?.close()
        connection = null
    }
}
