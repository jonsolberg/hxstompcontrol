/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp.usb

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream

class HxProtocolTest {

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    /** Builds a stream the way the device sends it: preamble + array16 of {index: {109: "name\0"}}. */
    private fun stream(preamble: ByteArray, count: Int, names: (Int) -> String, base: Int = 0): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(preamble)
        out.write(bytes(0xDC, count shr 8, count and 0xFF))
        for (i in 0 until count) {
            val idx = base + i
            out.write(0x81)
            when {
                idx < 128 -> out.write(idx)
                idx < 256 -> out.write(bytes(0xCC, idx))
                else -> out.write(bytes(0xCD, idx shr 8, idx and 0xFF))
            }
            out.write(0x82)                       // inner map: 109 → name, 110 → something else
            out.write(109)
            val name = (names(i) + "\u0000").toByteArray()
            out.write(0xA0 or name.size)
            out.write(name)
            out.write(110)
            out.write(bytes(0x93, 1, 2, 3))
        }
        return out.toByteArray()
    }

    @Test fun parsesHxStompStream() {
        val s = stream(bytes(0x00, 0xFF, 0x42, 0x13, 0x37), 126, { "Preset $it" })
        val presets = HxProtocol.parsePresetStream(s, 126)
        assertEquals(126, presets.size)
        assertEquals(Preset(0, "Preset 0"), presets[0])
        assertEquals(Preset(125, "Preset 125"), presets[125])
    }

    @Test fun parsesSecondSetlistIndices() {
        val s = stream(ByteArray(0), 128, { "S$it" }, base = 256)
        val presets = HxProtocol.parsePresetStream(s, 128, setlist = 2)
        assertEquals(0, presets.first().slot)
        assertEquals("S127", presets.last().name)
    }

    @Test(expected = HxProtocol.ProtocolException::class)
    fun missingMarkerFails() {
        HxProtocol.parsePresetStream(bytes(1, 2, 3, 4), 126)
    }

    @Test fun labelsMatchDevice() {
        assertEquals("00A", HxModel.HX_STOMP.label(0))
        assertEquals("00C", HxModel.HX_STOMP.label(2))
        assertEquals("01A", HxModel.HX_STOMP.label(3))
        assertEquals("41C", HxModel.HX_STOMP.label(125))
        assertEquals("01A", HxModel.HX_STOMP_XL.label(0))
        assertEquals("32D", HxModel.HX_STOMP_XL.label(127))
    }

    @Test fun packetsMatchDocumentation() {
        assertArrayEquals(
            bytes(
                0x1D, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, 0x06, 0x00, 0x04, 0x1A, 0x10, 0x00, 0x00,
                0x01, 0x00, 0x02, 0x00, 0x0D, 0x00, 0x00, 0x00, 0x83, 0x66, 0xCD, 0x03, 0xF2, 0x64, 0x14, 0x65,
                0x82, 0x6B, 0x00, 0x6C, 0x05, 0x00, 0x00, 0x00,
            ),
            HxProtocol.selectPreset(0x06, 0, 5),
        )
        assertArrayEquals(
            bytes(0x08, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, 0x09, 0x00, 0x08, 0x38, 0x12, 0x00, 0x00),
            HxProtocol.chunkRequest(0x09, 0x1238),
        )
        assertEquals(listOf(20, 28, 16, 36, 16), HxProtocol.HANDSHAKE.map { it.size })
        assertEquals(36, HxProtocol.openPresets(6).size)
        assertEquals(40, HxProtocol.openStream(7, 0).size)
    }

    @Test fun msgPackBasics() {
        val v = MsgPackReader(bytes(0x83, 0x66, 0xCD, 0x03, 0xE9, 0x67, 0x00, 0x68, 0xC0)).read()
        assertEquals(1001L, v.mapGet(102))
        assertEquals(0L, v.mapGet(103))
        assertEquals(null, v.mapGet(104))
        assertEquals(-1L, MsgPackReader(bytes(0xFF)).read())
        assertEquals("hi", MsgPackReader(bytes(0xD9, 2, 'h'.code, 'i'.code)).read())
    }

    /** Fake device: answers handshake with a short ack and serves the stream in 256-byte pages. */
    private class FakeDevice(private val payload: ByteArray) : BulkTransport {
        val written = mutableListOf<ByteArray>()
        private var pending: ByteArray? = null
        private var page = 0

        override fun write(data: ByteArray, timeoutMs: Int): Int {
            written += data
            val cmd = data[11].toInt() and 0xFF
            pending = when {
                cmd == 0x0C -> { page = 0; nextPage() }
                cmd == 0x08 && written.size > 7 -> nextPage()
                else -> ByteArray(16) { 0x11 }
            }
            return data.size
        }

        private fun nextPage(): ByteArray {
            val from = page * 256
            val to = minOf(payload.size, from + 256)
            page++
            return ByteArray(16) + payload.copyOfRange(minOf(from, payload.size), to)
        }

        override fun read(buf: ByteArray, timeoutMs: Int): Int {
            val p = pending ?: return -1
            pending = null
            p.copyInto(buf)
            return p.size
        }
    }

    @Test fun sessionListsPresets() {
        val dev = FakeDevice(stream(ByteArray(40) { 7 }, 126, { "Tone $it" }))
        val presets = HxSession(dev, sleep = {}).listPresets(HxModel.HX_STOMP)
        assertEquals(126, presets.size)
        assertEquals("Tone 42", presets[42].name)
        // handshake (5) + open presets + open stream + at least one chunk request
        assertTrue(dev.written.size > 8)
        assertEquals(0x06, dev.written[5][9].toInt())
        assertEquals(0x07, dev.written[6][9].toInt())
        assertEquals(0x08, dev.written[7][9].toInt())
        assertArrayEquals(bytes(0x38, 0x11, 0x00, 0x00), dev.written[7].copyOfRange(12, 16))
    }
}
