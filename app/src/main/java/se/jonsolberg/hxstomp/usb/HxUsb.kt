/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp.usb

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager

/** An open, claimed connection to the device's vendor-specific bulk interface. */
class HxUsbConnection private constructor(
    val device: UsbDevice,
    val model: HxModel,
    private val conn: UsbDeviceConnection,
    private val intf: UsbInterface,
    private val epOut: UsbEndpoint,
    private val epIn: UsbEndpoint,
) : BulkTransport {

    override fun write(data: ByteArray, timeoutMs: Int) =
        conn.bulkTransfer(epOut, data, data.size, timeoutMs)

    override fun read(buf: ByteArray, timeoutMs: Int) =
        conn.bulkTransfer(epIn, buf, buf.size, timeoutMs)

    fun close() {
        runCatching { conn.releaseInterface(intf) }
        runCatching { conn.close() }
    }

    companion object {
        fun findDevice(manager: UsbManager): UsbDevice? =
            manager.deviceList.values.firstOrNull {
                it.vendorId == HxModel.VENDOR_ID && HxModel.byProductId(it.productId) != null
            }

        fun open(manager: UsbManager, device: UsbDevice, log: (String) -> Unit): HxUsbConnection {
            val model = HxModel.byProductId(device.productId)
                ?: throw HxProtocol.ProtocolException("Unsupported device (PID 0x%04X)".format(device.productId))

            // Find the interface carrying bulk OUT 0x01 and bulk IN 0x81.
            var found: Triple<UsbInterface, UsbEndpoint, UsbEndpoint>? = null
            for (i in 0 until device.interfaceCount) {
                val itf = device.getInterface(i)
                var out: UsbEndpoint? = null
                var inp: UsbEndpoint? = null
                for (e in 0 until itf.endpointCount) {
                    val ep = itf.getEndpoint(e)
                    if (ep.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
                    if (ep.address == HxProtocol.EP_OUT) out = ep
                    if (ep.address == HxProtocol.EP_IN) inp = ep
                }
                log("-- interface ${itf.id} class ${itf.interfaceClass} endpoints ${itf.endpointCount}")
                if (out != null && inp != null && found == null) found = Triple(itf, out, inp)
            }
            val (intf, epOut, epIn) = found
                ?: throw HxProtocol.ProtocolException("Couldn't find the editor interface on the ${model.name}")

            val conn = manager.openDevice(device)
                ?: throw HxProtocol.ProtocolException("Android refused to open the ${model.name}")
            if (!conn.claimInterface(intf, true)) {
                conn.close()
                throw HxProtocol.ProtocolException("Couldn't claim the ${model.name}'s USB interface")
            }
            // CLEAR_FEATURE(ENDPOINT_HALT) on both endpoints.
            for (ep in listOf(epOut, epIn)) {
                conn.controlTransfer(0x02, 0x01, 0, ep.address, null, 0, 500)
            }
            log("-- opened ${model.name} (interface ${intf.id})")
            return HxUsbConnection(device, model, conn, intf, epOut, epIn)
        }
    }
}
