package com.kanikadesigns.printbridge

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
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
import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.data.LabelSize
import com.kanikadesigns.printbridge.data.PrinterLanguage
import com.kanikadesigns.printbridge.data.SettingsStore
import com.kanikadesigns.printbridge.network.BackendClient
import com.kanikadesigns.printbridge.printer.TcpPrinterClient
import com.kanikadesigns.printbridge.service.PrintBridgeService
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
        ActivityResultContracts.RequestPermission(),
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
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
}
