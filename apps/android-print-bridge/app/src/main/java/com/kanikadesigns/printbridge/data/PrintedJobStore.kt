package com.kanikadesigns.printbridge.data

import android.content.Context
import androidx.core.content.edit
<<<<<<< HEAD
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class PrintedJobStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("kanika_printed_jobs", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }
=======
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

class PrintedJobStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("kanika_printed_jobs", Context.MODE_PRIVATE)
    private val gson = Gson()
    private val listType = object : TypeToken<List<LocalJobStatus>>() {}.type
>>>>>>> ffbb103 (again subscribing)

    fun isCompleted(jobId: String): Boolean {
        return readAll().any { it.jobId == jobId && it.status == "PRINTED" }
    }

    fun markPrinted(jobId: String) {
<<<<<<< HEAD
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
=======
        val updated = (readAll().filterNot { it.jobId == jobId } + LocalJobStatus(jobId, "PRINTED", System.currentTimeMillis()))
            .sortedByDescending { it.timestamp }
            .take(MAX_HISTORY)
        prefs.edit { putString(KEY_HISTORY, gson.toJson(updated)) }
    }

    private fun readAll(): List<LocalJobStatus> {
        val raw = prefs.getString(KEY_HISTORY, "[]") ?: "[]"
        return runCatching { gson.fromJson<List<LocalJobStatus>>(raw, listType) }.getOrDefault(emptyList())
>>>>>>> ffbb103 (again subscribing)
    }

    companion object {
        private const val KEY_HISTORY = "history"
        private const val MAX_HISTORY = 500
    }
}

<<<<<<< HEAD
@Serializable
=======
>>>>>>> ffbb103 (again subscribing)
data class LocalJobStatus(
    val jobId: String,
    val status: String,
    val timestamp: Long,
)
