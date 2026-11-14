/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp.usb

/**
 * Minimal MessagePack decoder – just enough to read the replies of the HX
 * device. Values are decoded into plain Kotlin types:
 *
 *  nil → null, bool → Boolean, ints → Long, floats → Double,
 *  str → String, bin → ByteArray, array → List<Any?>,
 *  map → List<Pair<Any?, Any?>> (keeps order and duplicate keys).
 */
class MsgPackReader(private val data: ByteArray, start: Int = 0) {
    var pos: Int = start
        private set

    class FormatException(msg: String) : Exception(msg)

    private fun u8(): Int {
        if (pos >= data.size) throw FormatException("Unexpected end of data at $pos")
        return data[pos++].toInt() and 0xFF
    }

    private fun be(n: Int): Long {
        var v = 0L
        repeat(n) { v = (v shl 8) or u8().toLong() }
        return v
    }

    private fun bytes(n: Int): ByteArray {
        if (n < 0 || pos + n > data.size) throw FormatException("Length $n runs past end of data")
        val out = data.copyOfRange(pos, pos + n)
        pos += n
        return out
    }

    private fun str(n: Int) = String(bytes(n), Charsets.UTF_8)

    private fun array(n: Int): List<Any?> = List(n) { read() }

    private fun map(n: Int): List<Pair<Any?, Any?>> = List(n) { read() to read() }

    fun read(): Any? {
        val b = u8()
        return when {
            b <= 0x7F -> b.toLong()
            b in 0x80..0x8F -> map(b and 0x0F)
            b in 0x90..0x9F -> array(b and 0x0F)
            b in 0xA0..0xBF -> str(b and 0x1F)
            b >= 0xE0 -> (b - 256).toLong()
            else -> when (b) {
                0xC0 -> null
                0xC2 -> false
                0xC3 -> true
                0xC4 -> bytes(be(1).toInt())
                0xC5 -> bytes(be(2).toInt())
                0xC6 -> bytes(be(4).toInt())
                0xC7 -> { val n = be(1).toInt(); u8(); bytes(n) }   // ext8
                0xC8 -> { val n = be(2).toInt(); u8(); bytes(n) }   // ext16
                0xC9 -> { val n = be(4).toInt(); u8(); bytes(n) }   // ext32
                0xCA -> java.lang.Float.intBitsToFloat(be(4).toInt()).toDouble()
                0xCB -> java.lang.Double.longBitsToDouble(be(8))
                0xCC -> be(1)
                0xCD -> be(2)
                0xCE -> be(4)
                0xCF -> be(8)
                0xD0 -> be(1).toByte().toLong()
                0xD1 -> be(2).toShort().toLong()
                0xD2 -> be(4).toInt().toLong()
                0xD3 -> be(8)
                0xD4 -> { u8(); bytes(1) }                           // fixext1
                0xD5 -> { u8(); bytes(2) }
                0xD6 -> { u8(); bytes(4) }
                0xD7 -> { u8(); bytes(8) }
                0xD8 -> { u8(); bytes(16) }
                0xD9 -> str(be(1).toInt())
                0xDA -> str(be(2).toInt())
                0xDB -> str(be(4).toInt())
                0xDC -> array(be(2).toInt())
                0xDD -> array(be(4).toInt())
                0xDE -> map(be(2).toInt())
                0xDF -> map(be(4).toInt())
                else -> throw FormatException("Unknown MessagePack byte 0x%02X at %d".format(b, pos - 1))
            }
        }
    }
}

/** Looks up an integer key in a decoded map. */
@Suppress("UNCHECKED_CAST")
fun Any?.mapGet(key: Long): Any? =
    (this as? List<*>)?.firstOrNull { (it as? Pair<*, *>)?.first == key }?.let { (it as Pair<*, *>).second }

@Suppress("UNCHECKED_CAST")
fun Any?.asMap(): List<Pair<Any?, Any?>>? =
    (this as? List<*>)?.takeIf { l -> l.all { it is Pair<*, *> } } as List<Pair<Any?, Any?>>?
