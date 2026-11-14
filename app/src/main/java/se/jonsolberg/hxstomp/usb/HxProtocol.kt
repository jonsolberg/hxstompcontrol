/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Packet layouts follow the black-box protocol documentation of the OpenHX
 * project (https://github.com/allansomensi/openhx, MIT License,
 * Copyright (c) 2026 Allan Somensi). See THIRD_PARTY_NOTICES.md.
 */
package se.jonsolberg.hxstomp.usb

/** A Line 6 device this app knows how to talk to. */
data class HxModel(
    val name: String,
    val productId: Int,
    val presetCount: Int,
    val setlistCount: Int,
    /** First bank number shown on the device (HX Stomp starts at 00, the others at 01). */
    val firstBank: Int,
    val presetsPerBank: Int,
) {
    /** Preset label as shown on the device, e.g. "00A" or "32D". */
    fun label(slot: Int): String {
        val bank = slot / presetsPerBank + firstBank
        val letter = 'A' + slot % presetsPerBank
        return "%02d%c".format(bank, letter)
    }

    companion object {
        const val VENDOR_ID = 0x0E41

        val HX_STOMP = HxModel("HX Stomp", 0x4246, 126, 1, firstBank = 0, presetsPerBank = 3)
        val HX_STOMP_XL = HxModel("HX Stomp XL", 0x4253, 128, 1, firstBank = 1, presetsPerBank = 4)
        val HELIX_FLOOR = HxModel("Helix Floor", 0x4248, 128, 8, firstBank = 1, presetsPerBank = 4)

        val ALL = listOf(HX_STOMP, HX_STOMP_XL, HELIX_FLOOR)

        fun byProductId(pid: Int) = ALL.firstOrNull { it.productId == pid }
    }
}

data class Preset(val slot: Int, val name: String)

/** Builds request packets and parses replies. Pure functions, no I/O. */
object HxProtocol {
    const val EP_OUT = 0x01
    const val EP_IN = 0x81
    const val READ_SIZE = 512
    const val TIMEOUT_MS = 2000
    const val DRAIN_TIMEOUT_MS = 50

    /** A preset-stream reply shorter than this is the last one. */
    const val FULL_CHUNK = 272
    const val HEADER = 16
    const val FIRST_APP_SEQ = 0x06
    const val FIRST_CHUNK_OFFSET = 0x1138L

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    /** The five packets that open a session; each is followed by one (ignored) read. */
    val HANDSHAKE: List<ByteArray> = listOf(
        bytes(
            0x0C, 0x00, 0x00, 0x28, 0x01, 0x10, 0xEF, 0x03, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0x21,
            0x00, 0x10, 0x00, 0x00,
        ),
        bytes(
            0x11, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, 0x02, 0x00, 0x04, 0x00, 0x10, 0x00, 0x00,
            0x01, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
        ),
        bytes(0x08, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, 0x03, 0x00, 0x08, 0x09, 0x10, 0x00, 0x00),
        bytes(
            0x1A, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, 0x04, 0x00, 0x04, 0x09, 0x10, 0x00, 0x00,
            0x01, 0x00, 0x02, 0x00, 0x0A, 0x00, 0x00, 0x00, 0x83, 0x66, 0xCD, 0x03, 0xE8, 0x64, 0xCC, 0xFE,
            0x65, 0x80, 0x00, 0x00,
        ),
        bytes(0x08, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, 0x05, 0x00, 0x08, 0x1A, 0x10, 0x00, 0x00),
    )

    /** OPEN_PRESETS – `{102: 1001, 100: 0, 101: nil}`; the reply is the setlist table. */
    fun openPresets(seq: Int) = bytes(
        0x19, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, seq and 0xFF, 0x00, 0x04, 0x1A, 0x10, 0x00, 0x00,
        0x01, 0x00, 0x02, 0x00, 0x09, 0x00, 0x00, 0x00, 0x83, 0x66, 0xCD, 0x03, 0xE9, 0x64, 0x00, 0x65,
        0xC0, 0x00, 0x00, 0x00,
    )

    /** OPEN_STREAM – `{102: 1002, 100: 1, 101: {107: setlist, 101: 2}}`; reply is chunk #0. */
    fun openStream(seq: Int, setlist: Int): ByteArray {
        require(setlist in 0..127)
        return bytes(
            0x1D, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, seq and 0xFF, 0x00, 0x0C, 0x38, 0x10, 0x00, 0x00,
            0x01, 0x00, 0x02, 0x00, 0x0D, 0x00, 0x00, 0x00, 0x83, 0x66, 0xCD, 0x03, 0xEA, 0x64, 0x01, 0x65,
            0x82, 0x6B, setlist, 0x65, 0x02, 0x00, 0x00, 0x00,
        )
    }

    /** Requests the next page of the preset stream. */
    fun chunkRequest(seq: Int, offset: Long): ByteArray = bytes(
        0x08, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, seq and 0xFF, 0x00, 0x08,
        (offset and 0xFF).toInt(), ((offset shr 8) and 0xFF).toInt(),
        ((offset shr 16) and 0xFF).toInt(), ((offset shr 24) and 0xFF).toInt(),
    )

    /** SELECT_PRESET – `{102: 1010, 100: 20, 101: {107: setlist, 108: slot}}`. */
    fun selectPreset(seq: Int, setlist: Int, slot: Int): ByteArray {
        require(setlist in 0..127 && slot in 0..127)
        return bytes(
            0x1D, 0x00, 0x00, 0x18, 0x01, 0x10, 0xEF, 0x03, 0x00, seq and 0xFF, 0x00, 0x04, 0x1A, 0x10, 0x00, 0x00,
            0x01, 0x00, 0x02, 0x00, 0x0D, 0x00, 0x00, 0x00, 0x83, 0x66, 0xCD, 0x03, 0xF2, 0x64, 0x14, 0x65,
            0x82, 0x6B, setlist, 0x6C, slot, 0x00, 0x00, 0x00,
        )
    }

    class ProtocolException(msg: String) : Exception(msg)

    /**
     * Parses the reassembled preset stream: find the `array16` marker holding
     * [presetCount] entries, then read `{index: {109: name, …}}` for each.
     */
    fun parsePresetStream(stream: ByteArray, presetCount: Int, setlist: Int = 0): List<Preset> {
        val marker = byteArrayOf(0xDC.toByte(), (presetCount shr 8).toByte(), presetCount.toByte())
        val start = indexOf(stream, marker)
        if (start < 0) throw ProtocolException("Preset list not found in the data from the device (${stream.size} bytes)")

        val root = try {
            MsgPackReader(stream, start).read()
        } catch (e: MsgPackReader.FormatException) {
            throw ProtocolException("Could not decode the preset list: ${e.message}")
        }
        val items = root as? List<*> ?: throw ProtocolException("Preset list is not an array")
        val base = setlist.toLong() * presetCount

        return items.mapIndexed { i, item ->
            val outer = item.asMap()?.firstOrNull()
                ?: throw ProtocolException("Preset entry $i is not a map")
            val index = (outer.first as? Long) ?: throw ProtocolException("Preset entry $i has no index")
            val slot = index - base
            if (slot < 0 || slot >= presetCount) throw ProtocolException("Preset index $index is outside setlist $setlist")
            val name = (outer.second.mapGet(109) as? String)
                ?.trimEnd('\u0000')?.trimEnd() ?: ""
            Preset(slot.toInt(), name)
        }.sortedBy { it.slot }
    }

    fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
            return i
        }
        return -1
    }

    fun hex(data: ByteArray, len: Int = data.size): String =
        (0 until len).joinToString(" ") { "%02X".format(data[it]) }
}
