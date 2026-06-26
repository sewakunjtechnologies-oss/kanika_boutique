package com.kanikadesigns.printbridge

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.menuAnchor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.data.LabelSize
import com.kanikadesigns.printbridge.data.PrinterLanguage
import com.kanikadesigns.printbridge.data.SettingsStore
import com.kanikadesigns.printbridge.network.BackendClient
import com.kanikadesigns.printbridge.printer.TcpPrinterClient
import com.kanikadesigns.printbridge.service.PrintBridgeService
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            MaterialTheme {
                BridgeScreen()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BridgeScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val settingsStore = remember { SettingsStore(context) }
    var settings by remember { mutableStateOf(settingsStore.read()) }
    var message by remember { mutableStateOf("Ready") }
    var runtimeStatus by remember { mutableStateOf(settingsStore.readLastStatus()) }

    fun launchAction(action: suspend () -> String) {
        scope.launch {
            message = runCatching { action() }.getOrElse { it.message ?: "Action failed" }
        }
    }

    LaunchedEffect(Unit) {
        while (true) {
            runtimeStatus = settingsStore.readLastStatus()
            delay(2_000)
        }
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Kanika Print Bridge") }) },
    ) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            StatusCard(
                running = runtimeStatus.running,
                message = message,
                lastJob = runtimeStatus.lastJob,
                lastError = runtimeStatus.lastError,
            )

            SettingsFields(
                settings = settings,
                onChange = { settings = it },
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = {
                        settingsStore.save(settings)
                        message = "Settings saved"
                    },
                ) { Text("Save settings") }
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = {
                        launchAction {
                            settingsStore.save(settings)
                            if (BackendClient(settings).testBackend()) "Backend reachable" else "Backend test failed"
                        }
                    },
                ) { Text("Test backend") }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = {
                        launchAction {
                            if (TcpPrinterClient().testConnection(settings.printerIp, settings.printerPort)) {
                                "Printer TCP connection OK"
                            } else {
                                "Printer connection failed"
                            }
                        }
                    },
                ) { Text("Test printer") }
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = {
                        launchAction {
                            settingsStore.save(settings)
                            val jobId = BackendClient(settings).createBackendTestLabel()
                            PrintBridgeService.start(context)
                            "Test job created: $jobId"
                        }
                    },
                ) { Text("Print test label") }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = {
                        settingsStore.save(settings)
                        PrintBridgeService.start(context)
                        message = "Bridge starting"
                    },
                ) { Text("Start bridge") }
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = {
                        PrintBridgeService.stop(context)
                        message = "Bridge stopping"
                    },
                ) { Text("Stop bridge") }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                Button(
                    modifier = Modifier.weight(1f),
                    onClick = {
                        launchAction {
                            settingsStore.save(settings)
                            val jobId = BackendClient(settings).retryOldestFailedJob()
                            jobId?.let { "Retried failed job: $it" } ?: "No retryable failed job"
                        }
                    },
                ) { Text("Retry failed job") }
                TextButton(
                    modifier = Modifier.weight(1f),
                    onClick = {
                        val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                            data = Uri.parse("package:${context.packageName}")
                        }
                        runCatching { context.startActivity(intent) }.onFailure {
                            context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                        }
                    },
                ) { Text("Battery settings") }
            }

            HelpCard()
            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}

@Composable
private fun StatusCard(running: Boolean, message: String, lastJob: String, lastError: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Service: ${if (running) "Running" else "Stopped"}", style = MaterialTheme.typography.titleMedium)
            Text("Status: $message")
            if (lastJob.isNotBlank()) Text("Last job: $lastJob")
            if (lastError.isNotBlank()) Text("Last error: $lastError", color = MaterialTheme.colorScheme.error)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsFields(settings: BridgeSettings, onChange: (BridgeSettings) -> Unit) {
    var labelDropdownOpen by remember { mutableStateOf(false) }
    var languageDropdownOpen by remember { mutableStateOf(false) }

    OutlinedTextField(
        value = settings.backendUrl,
        onValueChange = { onChange(settings.copy(backendUrl = it)) },
        label = { Text("Backend URL") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    OutlinedTextField(
        value = settings.printAgentToken,
        onValueChange = { onChange(settings.copy(printAgentToken = it)) },
        label = { Text("PRINT_AGENT_TOKEN") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        visualTransformation = PasswordVisualTransformation(),
    )
    OutlinedTextField(
        value = settings.deviceId,
        onValueChange = { onChange(settings.copy(deviceId = it)) },
        label = { Text("Device ID") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = settings.printerIp,
            onValueChange = { onChange(settings.copy(printerIp = it)) },
            label = { Text("Printer IP") },
            modifier = Modifier.weight(1f),
            singleLine = true,
        )
        OutlinedTextField(
            value = settings.printerPort.toString(),
            onValueChange = { onChange(settings.copy(printerPort = it.toIntOrNull() ?: settings.printerPort)) },
            label = { Text("Port") },
            modifier = Modifier.weight(0.6f),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            singleLine = true,
        )
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        ExposedDropdownMenuBox(
            expanded = languageDropdownOpen,
            onExpandedChange = { languageDropdownOpen = !languageDropdownOpen },
            modifier = Modifier.weight(1f),
        ) {
            OutlinedTextField(
                value = settings.printerLanguage.name,
                onValueChange = {},
                readOnly = true,
                label = { Text("Language") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = languageDropdownOpen) },
                modifier = Modifier.menuAnchor().fillMaxWidth(),
            )
            ExposedDropdownMenu(expanded = languageDropdownOpen, onDismissRequest = { languageDropdownOpen = false }) {
                PrinterLanguage.entries.forEach {
                    DropdownMenuItem(
                        text = { Text(it.name) },
                        onClick = {
                            languageDropdownOpen = false
                            onChange(settings.copy(printerLanguage = it))
                        },
                    )
                }
            }
        }

        ExposedDropdownMenuBox(
            expanded = labelDropdownOpen,
            onExpandedChange = { labelDropdownOpen = !labelDropdownOpen },
            modifier = Modifier.weight(1f),
        ) {
            OutlinedTextField(
                value = settings.labelSize.wireValue,
                onValueChange = {},
                readOnly = true,
                label = { Text("Label size") },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = labelDropdownOpen) },
                modifier = Modifier.menuAnchor().fillMaxWidth(),
            )
            ExposedDropdownMenu(expanded = labelDropdownOpen, onDismissRequest = { labelDropdownOpen = false }) {
                LabelSize.entries.forEach {
                    DropdownMenuItem(
                        text = { Text(it.wireValue) },
                        onClick = {
                            labelDropdownOpen = false
                            onChange(settings.copy(labelSize = it))
                        },
                    )
                }
            }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = settings.pollIntervalSeconds.toString(),
            onValueChange = { onChange(settings.copy(pollIntervalSeconds = it.toIntOrNull() ?: settings.pollIntervalSeconds)) },
            label = { Text("Poll seconds") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.weight(1f),
            singleLine = true,
        )
        OutlinedTextField(
            value = settings.direction.toString(),
            onValueChange = {
                val value = it.toIntOrNull()
                if (value == 0 || value == 1) onChange(settings.copy(direction = value))
            },
            label = { Text("Direction 0/1") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.weight(1f),
            singleLine = true,
        )
    }
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Checkbox(
            checked = settings.autoStartAfterBoot,
            onCheckedChange = { onChange(settings.copy(autoStartAfterBoot = it)) },
        )
        Text("Try to restart bridge after phone reboot")
    }
}

@Composable
private fun HelpCard() {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Phone setup checklist", style = MaterialTheme.typography.titleMedium)
            Text("1. Keep phone and printer on the same Wi-Fi.")
            Text("2. Disable battery optimization for this app.")
            Text("3. Allow notifications and background data.")
            Text("4. Keep the phone plugged in during shop hours.")
            Text("5. If a label prints reversed/sideways, switch Direction 0/1 and print test label again.")
        }
    }
}
