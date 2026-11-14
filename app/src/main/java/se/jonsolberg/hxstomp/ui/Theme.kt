/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val LedRed = Color(0xFFFF4A3D)
val LedGreen = Color(0xFF4CC26A)

private val scheme = darkColorScheme(
    primary = Color(0xFFE8E6E1),
    onPrimary = Color(0xFF151618),
    primaryContainer = Color(0xFF3A3C41),
    onPrimaryContainer = Color(0xFFF2F1EE),
    secondary = Color(0xFFFF6A4D),
    onSecondary = Color(0xFF1A0E0B),
    secondaryContainer = Color(0xFF5A2219),
    onSecondaryContainer = Color(0xFFFFDAD2),
    background = Color(0xFF0F1012),
    onBackground = Color(0xFFE6E4E0),
    surface = Color(0xFF151619),
    onSurface = Color(0xFFE6E4E0),
    surfaceVariant = Color(0xFF23252A),
    onSurfaceVariant = Color(0xFFAEABA5),
    surfaceContainer = Color(0xFF1B1C20),
    surfaceContainerHigh = Color(0xFF222429),
    surfaceContainerHighest = Color(0xFF2A2C31),
    outline = Color(0xFF4F5258),
    error = Color(0xFFFF6B5E),
)

@Composable
fun StompTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}
