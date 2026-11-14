/*
 * HX Stomp Control
 * Copyright (C) 2026 Jon Solberg
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
package se.jonsolberg.hxstomp.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import se.jonsolberg.hxstomp.StompViewModel
import se.jonsolberg.hxstomp.UiState
import se.jonsolberg.hxstomp.usb.HxModel
import se.jonsolberg.hxstomp.usb.Preset

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(vm: StompViewModel, onConnect: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    var showLog by rememberSaveable { mutableStateOf(false) }

    if (showLog) {
        BackHandler { showLog = false }
        LogScreen(state.log, onClose = { showLog = false }, onClear = vm::clearLog)
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("HX Stomp Control", fontWeight = FontWeight.SemiBold)
                        Text(
                            state.status,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { showLog = true }) { Icon(Icons.Default.Info, "USB log") }
                    IconButton(
                        onClick = { if (state.connected) vm.refresh() else onConnect() },
                        enabled = !state.busy,
                    ) { Icon(Icons.Default.Refresh, "Reload presets") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            else Spacer(Modifier.height(4.dp))

            state.error?.let {
                Surface(
                    color = MaterialTheme.colorScheme.secondaryContainer,
                    shape = RoundedCornerShape(10.dp),
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(it, color = MaterialTheme.colorScheme.onSecondaryContainer)
                        Text(
                            "Tap ⓘ for the USB log – sharing it helps fix problems.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                        )
                    }
                }
            }

            val model = state.model
            if (model == null || state.presets.isEmpty()) {
                EmptyState(state, onConnect)
            } else {
                PresetList(model, state.presets, state.selected, enabled = state.connected && !state.busy, onSelect = vm::select)
            }
        }
    }
}

@Composable
private fun EmptyState(state: UiState, onConnect: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            if (state.connected) "No presets read yet." else "Connect the pedal's USB port to this phone with a USB-C to USB-B cable or an OTG adapter.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(20.dp))
        Button(onClick = onConnect, enabled = !state.busy) {
            Text(if (state.connected) "Read presets" else "Connect")
        }
    }
}

@Composable
private fun PresetList(
    model: HxModel,
    presets: List<Preset>,
    selected: Int?,
    enabled: Boolean,
    onSelect: (Int) -> Unit,
) {
    var filter by rememberSaveable { mutableStateOf("") }
    val shown = remember(presets, filter) {
        if (filter.isBlank()) presets
        else presets.filter { it.name.contains(filter, ignoreCase = true) || model.label(it.slot).contains(filter, ignoreCase = true) }
    }
    val banks = remember(shown) { shown.groupBy { it.slot / model.presetsPerBank }.toList() }

    Column {
        OutlinedTextField(
            value = filter,
            onValueChange = { filter = it },
            singleLine = true,
            placeholder = { Text("Search presets") },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        )
        LazyColumn(contentPadding = PaddingValues(12.dp, 4.dp, 12.dp, 24.dp)) {
            items(banks, key = { it.first }) { (bank, list) ->
                BankCard(model, bank, list, selected, enabled, onSelect)
                Spacer(Modifier.height(8.dp))
            }
        }
    }
}

@Composable
private fun BankCard(
    model: HxModel,
    bank: Int,
    presets: List<Preset>,
    selected: Int?,
    enabled: Boolean,
    onSelect: (Int) -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(12.dp)) {
        Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Text(
                "BANK %02d".format(bank + model.firstBank),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 14.dp, top = 6.dp, bottom = 2.dp),
            )
            presets.forEach { p ->
                val isSel = p.slot == selected
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (isSel) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainer)
                        .clickable(enabled = enabled) { onSelect(p.slot) }
                        .padding(horizontal = 14.dp, vertical = 11.dp),
                ) {
                    Box(
                        Modifier.size(9.dp).clip(CircleShape)
                            .background(if (isSel) LedRed else MaterialTheme.colorScheme.surfaceVariant)
                            .border(1.dp, MaterialTheme.colorScheme.outline, CircleShape),
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(
                        model.label(p.slot),
                        fontFamily = FontFamily.Monospace,
                        fontWeight = FontWeight.Bold,
                        color = if (isSel) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.width(48.dp),
                    )
                    Text(
                        p.name.ifBlank { "New Preset" },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontWeight = if (isSel) FontWeight.SemiBold else FontWeight.Normal,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LogScreen(log: List<String>, onClose: () -> Unit, onClear: () -> Unit) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    LaunchedEffect(log.size) { if (log.isNotEmpty()) listState.scrollToItem(log.size - 1) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("USB log") },
                navigationIcon = { IconButton(onClick = onClose) { Icon(Icons.Default.Close, "Close") } },
                actions = {
                    IconButton(onClick = onClear) { Icon(Icons.Default.Delete, "Clear log") }
                    IconButton(onClick = {
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_SUBJECT, "HX Stomp Control USB log")
                            putExtra(Intent.EXTRA_TEXT, log.joinToString("\n"))
                        }
                        context.startActivity(Intent.createChooser(send, "Share log"))
                    }) { Icon(Icons.Default.Share, "Share log") }
                },
            )
        },
    ) { pad ->
        if (log.isEmpty()) {
            Box(Modifier.padding(pad).fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("Nothing logged yet.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(state = listState, modifier = Modifier.padding(pad).fillMaxSize().padding(horizontal = 8.dp)) {
                items(log) {
                    Text(it, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp)
                }
            }
        }
    }
}
