/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.core.content.ContextCompat
import se.jonsolberg.hxstomp.ui.MainScreen
import se.jonsolberg.hxstomp.ui.StompTheme

class MainActivity : ComponentActivity() {
    private val vm: StompViewModel by viewModels()

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val device = intent.usbDevice()
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    if (device != null && intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                        vm.connect(device)
                    } else {
                        vm.permissionDenied()
                    }
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> tryConnect()
                UsbManager.ACTION_USB_DEVICE_DETACHED -> vm.detached(device)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val filter = IntentFilter().apply {
            addAction(ACTION_USB_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        setContent {
            StompTheme {
                MainScreen(vm, onConnect = ::tryConnect)
            }
        }
        tryConnect()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Started by plugging in the device (see device_filter.xml).
        if (intent.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) tryConnect()
    }

    override fun onDestroy() {
        unregisterReceiver(receiver)
        super.onDestroy()
    }

    private fun tryConnect() {
        val device = vm.findDevice() ?: return vm.noDevice()
        if (vm.hasPermission(device)) {
            vm.connect(device)
        } else {
            val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
            val pi = PendingIntent.getBroadcast(
                this, 0, Intent(ACTION_USB_PERMISSION).setPackage(packageName), flags,
            )
            getSystemService(UsbManager::class.java).requestPermission(device, pi)
        }
    }

    private fun Intent.usbDevice(): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33) getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else @Suppress("DEPRECATION") getParcelableExtra(UsbManager.EXTRA_DEVICE)

    companion object {
        const val ACTION_USB_PERMISSION = "se.jonsolberg.hxstomp.USB_PERMISSION"
    }
}
