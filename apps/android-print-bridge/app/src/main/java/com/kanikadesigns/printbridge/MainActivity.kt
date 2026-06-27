package com.kanikadesigns.printbridge

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
<<<<<<< HEAD
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
=======
import android.text.InputType
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
>>>>>>> ffbb103 (again subscribing)
import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.data.LabelSize
import com.kanikadesigns.printbridge.data.PrinterLanguage
import com.kanikadesigns.printbridge.data.SettingsStore
import com.kanikadesigns.printbridge.network.BackendClient
import com.kanikadesigns.printbridge.printer.TcpPrinterClient
import com.kanikadesigns.printbridge.service.PrintBridgeService
<<<<<<< HEAD
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val notificationPermissionLauncher = registerForActivityResult(
=======
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    private lateinit var settingsStore: SettingsStore
    private lateinit var backendUrl: EditText
    private lateinit var token: EditText
    private lateinit var deviceId: EditText
    private lateinit var printerIp: EditText
    private lateinit var printerPort: EditText
    private lateinit var pollSeconds: EditText
    private lateinit var direction: EditText
    private lateinit var languageSpinner: Spinner
    private lateinit var labelSpinner: Spinner
    private lateinit var autoBoot: CheckBox
    private lateinit var statusText: TextView
    private var statusJob: Job? = null

    private val notificationPermission = registerForActivityResult(
>>>>>>> ffbb103 (again subscribing)
        ActivityResultContracts.RequestPermission(),
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
<<<<<<< HEAD
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
=======
        settingsStore = SettingsStore(this)
        requestNotificationPermissionIfNeeded()
        buildUi()
        loadSettings(settingsStore.read())
        startStatusRefresh()
    }

    override fun onDestroy() {
        statusJob?.cancel()
        super.onDestroy()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }

        root.addView(title("Kanika Print Bridge"))
        statusText = TextView(this).apply {
            text = "Ready"
            textSize = 15f
            setPadding(0, dp(8), 0, dp(12))
        }
        root.addView(statusText)

        backendUrl = field("Backend URL")
        token = field("PRINT_AGENT_TOKEN", password = true)
        deviceId = field("Device ID")
        printerIp = field("Printer IP")
        printerPort = field("Printer Port", number = true)
        pollSeconds = field("Poll Interval Seconds", number = true)
        direction = field("Direction 0 or 1", number = true)
        listOf(backendUrl, token, deviceId, printerIp, printerPort, pollSeconds, direction).forEach(root::addView)

        root.addView(label("Printer Language"))
        languageSpinner = spinner(PrinterLanguage.entries.map { it.name })
        root.addView(languageSpinner)

        root.addView(label("Label Size"))
        labelSpinner = spinner(LabelSize.entries.map { it.wireValue })
        root.addView(labelSpinner)

        autoBoot = CheckBox(this).apply { text = "Try to restart bridge after phone reboot" }
        root.addView(autoBoot)

        root.addView(row(button("Save settings") { saveSettings(); showStatus("Settings saved") }))
        root.addView(row(
            button("Test backend") { runAction { if (BackendClient(currentSettings()).testBackend()) "Backend reachable" else "Backend test failed" } },
            button("Test printer") {
                runAction {
                    val settings = currentSettings()
                    if (TcpPrinterClient().testConnection(settings.printerIp, settings.printerPort)) {
                        "Printer TCP connection OK"
                    } else {
                        "Printer connection failed"
                    }
                }
            },
        ))
        root.addView(row(
            button("Print test label") {
                runAction {
                    saveSettings()
                    val jobId = BackendClient(currentSettings()).createBackendTestLabel()
                    PrintBridgeService.start(this)
                    "Test job created: $jobId"
                }
            },
            button("Retry failed job") {
                runAction {
                    saveSettings()
                    BackendClient(currentSettings()).retryOldestFailedJob()?.let { "Retried failed job: $it" }
                        ?: "No retryable failed job"
                }
            },
        ))
        root.addView(row(
            button("Start bridge") {
                saveSettings()
                PrintBridgeService.start(this)
                showStatus("Bridge starting")
            },
            button("Stop bridge") {
                PrintBridgeService.stop(this)
                showStatus("Bridge stopping")
            },
        ))
        root.addView(row(button("Battery settings") { openBatterySettings() }))
        root.addView(helpText())

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun loadSettings(settings: BridgeSettings) {
        backendUrl.setText(settings.backendUrl)
        token.setText(settings.printAgentToken)
        deviceId.setText(settings.deviceId)
        printerIp.setText(settings.printerIp)
        printerPort.setText(settings.printerPort.toString())
        pollSeconds.setText(settings.pollIntervalSeconds.toString())
        direction.setText(settings.direction.toString())
        autoBoot.isChecked = settings.autoStartAfterBoot
        selectSpinner(languageSpinner, settings.printerLanguage.name)
        selectSpinner(labelSpinner, settings.labelSize.wireValue)
    }

    private fun currentSettings(): BridgeSettings {
        return BridgeSettings(
            backendUrl = backendUrl.text.toString().trim().trimEnd('/'),
            printAgentToken = token.text.toString().trim(),
            deviceId = deviceId.text.toString().trim(),
            printerIp = printerIp.text.toString().trim(),
            printerPort = printerPort.text.toString().toIntOrNull() ?: 9100,
            printerLanguage = PrinterLanguage.from(languageSpinner.selectedItem?.toString().orEmpty()),
            labelSize = LabelSize.from(labelSpinner.selectedItem?.toString().orEmpty()),
            pollIntervalSeconds = pollSeconds.text.toString().toIntOrNull() ?: 3,
            direction = direction.text.toString().toIntOrNull()?.coerceIn(0, 1) ?: 1,
            autoStartAfterBoot = autoBoot.isChecked,
        )
    }

    private fun saveSettings() {
        settingsStore.save(currentSettings())
    }

    private fun startStatusRefresh() {
        statusJob = lifecycleScope.launch {
            while (isActive) {
                val runtime = settingsStore.readLastStatus()
                val lines = buildList {
                    add("Service: ${if (runtime.running) "Running" else "Stopped"}")
                    if (runtime.lastJob.isNotBlank()) add("Last job: ${runtime.lastJob}")
                    if (runtime.lastError.isNotBlank()) add("Last error: ${runtime.lastError}")
                }
                statusText.text = lines.joinToString("\n")
                delay(2_000)
            }
        }
    }

    private fun runAction(action: suspend () -> String) {
        lifecycleScope.launch {
            val message = runCatching { action() }.getOrElse { it.message ?: "Action failed" }
            showStatus(message)
        }
    }

    private fun showStatus(message: String) {
        statusText.text = message
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun openBatterySettings() {
        val requestIntent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:$packageName")
        }
        runCatching { startActivity(requestIntent) }.onFailure {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun title(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 22f
        setPadding(0, 0, 0, dp(12))
    }

    private fun label(text: String): TextView = TextView(this).apply {
        this.text = text
        textSize = 13f
        setPadding(0, dp(8), 0, dp(2))
    }

    private fun field(hint: String, password: Boolean = false, number: Boolean = false): EditText {
        return EditText(this).apply {
            this.hint = hint
            setSingleLine(true)
            inputType = when {
                password -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                number -> InputType.TYPE_CLASS_NUMBER
                else -> InputType.TYPE_CLASS_TEXT
            }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
    }

    private fun spinner(values: List<String>): Spinner {
        return Spinner(this).apply {
            adapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_dropdown_item, values)
            onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: AdapterView<*>?, view: android.view.View?, position: Int, id: Long) = Unit
                override fun onNothingSelected(parent: AdapterView<*>?) = Unit
            }
        }
    }

    private fun row(vararg children: Button): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            children.forEach { child ->
                addView(child, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                    setMargins(dp(4), dp(4), dp(4), dp(4))
                })
            }
        }
    }

    private fun button(text: String, onClick: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            setOnClickListener { onClick() }
        }
    }

    private fun helpText(): TextView = TextView(this).apply {
        text = """
            Phone setup:
            1. Keep phone and printer on the same Wi-Fi.
            2. Disable battery optimization for this app.
            3. Keep notifications enabled.
            4. Keep phone plugged in during shop hours.
            5. If test label is reversed, switch Direction 0/1.
        """.trimIndent()
        setPadding(0, dp(16), 0, 0)
    }

    private fun selectSpinner(spinner: Spinner, value: String) {
        val adapter = spinner.adapter
        for (index in 0 until adapter.count) {
            if (adapter.getItem(index) == value) {
                spinner.setSelection(index)
                return
            }
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
>>>>>>> ffbb103 (again subscribing)
}
