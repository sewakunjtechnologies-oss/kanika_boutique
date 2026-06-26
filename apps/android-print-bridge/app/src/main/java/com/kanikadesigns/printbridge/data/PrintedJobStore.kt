package com.kanikadesigns.printbridge.data

import android.content.Context
import androidx.core.content.edit
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class PrintedJobStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("kanika_printed_jobs", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    fun isCompleted(jobId: String): Boolean {
        return readAll().any { it.jobId == jobId && it.status == "PRINTED" }
    }

    fun markPrinted(jobId: String) {
        val now = System.currentTimeMillis()
        val updated = (readAll().filterNot { it.jobId == jobId } + LocalJobStatus(jobId, "PRINTED", now))
            .sortedByDescending { it.timestamp }
            .take(MAX_HISTORY)
        prefs.edit { putString(KEY_HISTORY, json.encodeToString(updated)) }
    }

    fun latest(): LocalJobStatus? = readAll().maxByOrNull { it.timestamp }

    private fun readAll(): List<LocalJobStatus> {
        val raw = prefs.getString(KEY_HISTORY, "[]") ?: "[]"
        return runCatching { json.decodeFromString<List<LocalJobStatus>>(raw) }.getOrDefault(emptyList())
    }

    companion object {
        private const val KEY_HISTORY = "history"
        private const val MAX_HISTORY = 500
    }
}

@Serializable
data class LocalJobStatus(
    val jobId: String,
    val status: String,
    val timestamp: Long,
)
