/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp.usb

import se.jonsolberg.hxstomp.usb.HxProtocol.ProtocolException

/** Raw bulk I/O. Returns bytes transferred, or a negative value on error/timeout. */
interface BulkTransport {
    fun write(data: ByteArray, timeoutMs: Int): Int
    fun read(buf: ByteArray, timeoutMs: Int): Int
}

/**
 * Runs whole operations against the device. Every operation opens its own
 * session (drain → handshake → command), as HX Edit does.
 */
class HxSession(
    private val io: BulkTransport,
    private val log: (String) -> Unit = {},
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) {
    private val buf = ByteArray(HxProtocol.READ_SIZE)
    private var seq = HxProtocol.FIRST_APP_SEQ

    private fun drain() {
        var n = 0
        while (n < 200) {
            val r = io.read(buf, HxProtocol.DRAIN_TIMEOUT_MS)
            if (r <= 0) break
            log("<< drain ${HxProtocol.hex(buf, minOf(r, 32))}${if (r > 32) " … ($r bytes)" else ""}")
            n++
        }
    }

    /** Sends one packet and reads one reply. Returns the reply length. */
    private fun exchange(packet: ByteArray, what: String): Int {
        log(">> $what ${HxProtocol.hex(packet)}")
        val w = io.write(packet, HxProtocol.TIMEOUT_MS)
        if (w != packet.size) throw ProtocolException("USB write failed during $what ($w)")
        val r = io.read(buf, HxProtocol.TIMEOUT_MS)
        if (r < 0) throw ProtocolException("No answer from the device during $what")
        log("<< $what ($r bytes) ${HxProtocol.hex(buf, minOf(r, 48))}${if (r > 48) " …" else ""}")
        return r
    }

    /** Drain + handshake, retried with backoff (300·2^n ms) if the device is out of sync. */
    private fun open() {
        var attempt = 0
        while (true) {
            try {
                drain()
                HxProtocol.HANDSHAKE.forEachIndexed { i, p -> exchange(p, "handshake ${i + 1}/5") }
                seq = HxProtocol.FIRST_APP_SEQ
                return
            } catch (e: ProtocolException) {
                attempt++
                if (attempt >= 5) throw ProtocolException("The device didn't answer the handshake. Try unplugging and reconnecting it.")
                val wait = 300L shl attempt
                log("!! ${e.message} – retrying in $wait ms")
                sleep(wait)
            }
        }
    }

    private fun nextSeq(): Int = seq.also { seq = (seq + 1) and 0xFF }

    fun listPresets(model: HxModel, setlist: Int = 0): List<Preset> {
        open()
        exchange(HxProtocol.openPresets(nextSeq()), "open presets")

        val stream = java.io.ByteArrayOutputStream()
        var n = exchange(HxProtocol.openStream(nextSeq(), setlist), "open stream")
        if (n > HxProtocol.HEADER) stream.write(buf, HxProtocol.HEADER, n - HxProtocol.HEADER)

        var offset = HxProtocol.FIRST_CHUNK_OFFSET
        var chunks = 0
        while (n >= HxProtocol.FULL_CHUNK) {
            if (++chunks > 4000) throw ProtocolException("The preset list never ended")
            n = exchange(HxProtocol.chunkRequest(nextSeq(), offset), "chunk $chunks")
            if (n > HxProtocol.HEADER) stream.write(buf, HxProtocol.HEADER, n - HxProtocol.HEADER)
            offset += 0x100
            if (offset > 0xFFFFFFFFL) throw ProtocolException("Stream offset overflow")
        }
        log("-- preset stream: ${stream.size()} bytes in ${chunks + 1} chunks")
        drain()
        return HxProtocol.parsePresetStream(stream.toByteArray(), model.presetCount, setlist)
    }

    fun selectPreset(slot: Int, setlist: Int = 0) {
        open()
        exchange(HxProtocol.selectPreset(nextSeq(), setlist, slot), "select preset $slot")
        drain()
    }
}
