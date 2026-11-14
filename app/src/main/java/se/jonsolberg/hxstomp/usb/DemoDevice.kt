/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp.usb

import java.io.ByteArrayOutputStream

/**
 * A pretend HX Stomp for demos and screenshots (start the app with `--ez demo true`).
 * It answers the real protocol, so the app's normal code paths and USB log are exercised.
 */
class DemoDevice(private val model: HxModel = HxModel.HX_STOMP) : BulkTransport {
    private val stream = buildStream()
    private var pending: ByteArray? = null
    private var page = 0

    private fun buildStream(): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x82.toByte(), 0x66, 0xCD.toByte(), 0x03, 0xEA.toByte(), 0x6A, 0x01)) // preamble
        val n = model.presetCount
        out.write(byteArrayOf(0xDC.toByte(), (n shr 8).toByte(), n.toByte()))
        for (i in 0 until n) {
            out.write(0x81)
            out.write(i)                       // fixint index (< 128)
            out.write(0x81)
            out.write(109)
            val name = ((NAMES.getOrNull(i) ?: "New Preset") + "\u0000").toByteArray()
            out.write(0xA0 or name.size)
            out.write(name)
        }
        return out.toByteArray()
    }

    private fun nextPage(): ByteArray {
        val from = minOf(page * 256, stream.size)
        val to = minOf(stream.size, from + 256)
        page++
        return ByteArray(HxProtocol.HEADER) + stream.copyOfRange(from, to)
    }

    override fun write(data: ByteArray, timeoutMs: Int): Int {
        Thread.sleep(4)
        val cmd = data[11].toInt() and 0xFF
        val seq = data[9].toInt() and 0xFF
        pending = when {
            cmd == 0x0C -> { page = 0; nextPage() }
            cmd == 0x08 && data.size == 16 && seq >= 0x08 -> nextPage()
            else -> ByteArray(HxProtocol.HEADER).also { it[9] = seq.toByte() }
        }
        return data.size
    }

    override fun read(buf: ByteArray, timeoutMs: Int): Int {
        val p = pending ?: return -1
        pending = null
        p.copyInto(buf)
        return p.size
    }

    companion object {
        /** Invented preset names – the rest of the slots read "New Preset". */
        val NAMES = listOf(
            "Glass Clean", "Sunday Crunch", "Lead Boost", "Ambient Swell", "Tremolo Surf",
            "Slapback Twang", "Fuzz Wall", "Shimmer Pad", "Funk Wah", "Plexi Roar",
            "Dream Chorus", "Dotted Eighth", "Blues Edge", "Octave Synth", "Spring Verb",
            "Acoustic Sim", "Bass DI", "Studio Dry", "Rhythm Tight", "Solo Liquid",
            "Phaser Seventies", "Vibe Haze", "Doom Drop D", "Country Comp", "Jazz Warm",
            "Live Clean", "Live Drive", "Live Lead", "Practice Amp", "Headphones",
        )
    }
}
