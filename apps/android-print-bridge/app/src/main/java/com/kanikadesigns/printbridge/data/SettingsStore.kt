package com.kanikadesigns.printbridge.data

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class SettingsStore(context: Context) {
    private val appContext = context.applicationContext
    private val prefs: SharedPreferences = appContext.getSharedPreferences("kanika_bridge_settings", Context.MODE_PRIVATE)
<<<<<<< HEAD
    private val securePrefs: SharedPreferences = createSecurePrefs(appContext)

    fun read(): BridgeSettings {
        return BridgeSettings(
            backendUrl = prefs.getString(KEY_BACKEND_URL, BridgeSettings().backendUrl) ?: BridgeSettings().backendUrl,
            printAgentToken = securePrefs.getString(KEY_PRINT_AGENT_TOKEN, "") ?: "",
            deviceId = prefs.getString(KEY_DEVICE_ID, BridgeSettings().deviceId) ?: BridgeSettings().deviceId,
            printerIp = prefs.getString(KEY_PRINTER_IP, "") ?: "",
            printerPort = prefs.getInt(KEY_PRINTER_PORT, BridgeSettings().printerPort),
            printerLanguage = PrinterLanguage.from(prefs.getString(KEY_PRINTER_LANGUAGE, PrinterLanguage.TSPL.name) ?: PrinterLanguage.TSPL.name),
            labelSize = LabelSize.from(prefs.getString(KEY_LABEL_SIZE, LabelSize.FOUR_BY_THREE.wireValue) ?: LabelSize.FOUR_BY_THREE.wireValue),
            pollIntervalSeconds = prefs.getInt(KEY_POLL_INTERVAL_SECONDS, BridgeSettings().pollIntervalSeconds),
            direction = prefs.getInt(KEY_DIRECTION, BridgeSettings().direction),
=======
    private val securePrefs: SharedPreferences = encryptedPreferences(appContext)

    fun read(): BridgeSettings {
        val defaults = BridgeSettings()
        return BridgeSettings(
            backendUrl = prefs.getString(KEY_BACKEND_URL, defaults.backendUrl) ?: defaults.backendUrl,
            printAgentToken = securePrefs.getString(KEY_PRINT_AGENT_TOKEN, "") ?: "",
            deviceId = prefs.getString(KEY_DEVICE_ID, defaults.deviceId) ?: defaults.deviceId,
            printerIp = prefs.getString(KEY_PRINTER_IP, "") ?: "",
            printerPort = prefs.getInt(KEY_PRINTER_PORT, defaults.printerPort),
            printerLanguage = PrinterLanguage.from(prefs.getString(KEY_PRINTER_LANGUAGE, PrinterLanguage.TSPL.name) ?: PrinterLanguage.TSPL.name),
            labelSize = LabelSize.from(prefs.getString(KEY_LABEL_SIZE, LabelSize.FOUR_BY_THREE.wireValue) ?: LabelSize.FOUR_BY_THREE.wireValue),
            pollIntervalSeconds = prefs.getInt(KEY_POLL_INTERVAL_SECONDS, defaults.pollIntervalSeconds),
            direction = prefs.getInt(KEY_DIRECTION, defaults.direction),
>>>>>>> ffbb103 (again subscribing)
            autoStartAfterBoot = prefs.getBoolean(KEY_AUTO_START_AFTER_BOOT, false),
        )
    }

    fun save(settings: BridgeSettings) {
        prefs.edit {
            putString(KEY_BACKEND_URL, settings.backendUrl.trim().trimEnd('/'))
            putString(KEY_DEVICE_ID, settings.deviceId.trim())
            putString(KEY_PRINTER_IP, settings.printerIp.trim())
            putInt(KEY_PRINTER_PORT, settings.printerPort)
            putString(KEY_PRINTER_LANGUAGE, settings.printerLanguage.name)
            putString(KEY_LABEL_SIZE, settings.labelSize.wireValue)
            putInt(KEY_POLL_INTERVAL_SECONDS, settings.pollIntervalSeconds)
            putInt(KEY_DIRECTION, settings.direction)
            putBoolean(KEY_AUTO_START_AFTER_BOOT, settings.autoStartAfterBoot)
        }
        securePrefs.edit {
            putString(KEY_PRINT_AGENT_TOKEN, settings.printAgentToken.trim())
        }
    }

    fun setServiceWanted(wanted: Boolean) {
        prefs.edit { putBoolean(KEY_SERVICE_WANTED, wanted) }
    }

    fun serviceWanted(): Boolean = prefs.getBoolean(KEY_SERVICE_WANTED, false)

    fun saveLastStatus(status: BridgeRuntimeStatus) {
        prefs.edit {
<<<<<<< HEAD
            putString(KEY_LAST_JOB, status.lastJob)
            putString(KEY_LAST_ERROR, status.lastError)
            putBoolean(KEY_SERVICE_RUNNING, status.running)
=======
            putBoolean(KEY_SERVICE_RUNNING, status.running)
            putString(KEY_LAST_JOB, status.lastJob)
            putString(KEY_LAST_ERROR, status.lastError)
>>>>>>> ffbb103 (again subscribing)
        }
    }

    fun readLastStatus(): BridgeRuntimeStatus {
        return BridgeRuntimeStatus(
            running = prefs.getBoolean(KEY_SERVICE_RUNNING, false),
            lastJob = prefs.getString(KEY_LAST_JOB, "") ?: "",
            lastError = prefs.getString(KEY_LAST_ERROR, "") ?: "",
        )
    }

<<<<<<< HEAD
    private fun createSecurePrefs(context: Context): SharedPreferences {
=======
    private fun encryptedPreferences(context: Context): SharedPreferences {
>>>>>>> ffbb103 (again subscribing)
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        return EncryptedSharedPreferences.create(
            context,
            "kanika_secure_settings",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    companion object {
        private const val KEY_BACKEND_URL = "backendUrl"
        private const val KEY_PRINT_AGENT_TOKEN = "printAgentToken"
        private const val KEY_DEVICE_ID = "deviceId"
        private const val KEY_PRINTER_IP = "printerIp"
        private const val KEY_PRINTER_PORT = "printerPort"
        private const val KEY_PRINTER_LANGUAGE = "printerLanguage"
        private const val KEY_LABEL_SIZE = "labelSize"
        private const val KEY_POLL_INTERVAL_SECONDS = "pollIntervalSeconds"
        private const val KEY_DIRECTION = "direction"
        private const val KEY_AUTO_START_AFTER_BOOT = "autoStartAfterBoot"
        private const val KEY_SERVICE_WANTED = "serviceWanted"
        private const val KEY_SERVICE_RUNNING = "serviceRunning"
        private const val KEY_LAST_JOB = "lastJob"
        private const val KEY_LAST_ERROR = "lastError"
    }
}

data class BridgeRuntimeStatus(
    val running: Boolean = false,
    val lastJob: String = "",
    val lastError: String = "",
)
