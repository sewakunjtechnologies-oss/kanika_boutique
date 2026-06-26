package com.kanikadesigns.printbridge.network

import com.kanikadesigns.printbridge.data.BridgeSettings
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class BackendClient(
    private val settings: BridgeSettings,
    private val client: OkHttpClient = defaultHttpClient(),
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val baseUrl = settings.backendUrl.trim().trimEnd('/')

    suspend fun testBackend(): Boolean {
        val request = Request.Builder()
            .url("$baseUrl/health")
            .get()
            .build()
        return runCatching {
            executeWithRetry(request).use { response -> response.isSuccessful }
        }.getOrDefault(false)
    }

    suspend fun sendHeartbeat() {
        val body = HeartbeatRequest(
            deviceId = settings.deviceId,
            printerName = "TSPL TCP ${settings.printerIp}:${settings.printerPort}",
            labelSize = settings.labelSize.wireValue,
        )
        postNoResponse("/api/print-agent/heartbeat", json.encodeToString(body))
    }

    suspend fun fetchNextJob(): PrintJobDto? {
        val request = authorizedRequest("/api/print-agent/jobs/next")
            .get()
            .build()
        return executeWithRetry(request).use { response ->
            if (!response.isSuccessful) throw IOException("fetchNextJob failed: HTTP ${response.code}")
            val body = response.body?.string().orEmpty()
            json.decodeFromString<PrintJobResponse>(body).job
        }
    }

    suspend fun markPrinting(jobId: String) {
        postNoResponse("/api/print-agent/jobs/$jobId/printing", json.encodeToString(DeviceRequest(settings.deviceId)))
    }

    suspend fun markPrinted(jobId: String) {
        postNoResponse("/api/print-agent/jobs/$jobId/printed", json.encodeToString(DeviceRequest(settings.deviceId)))
    }

    suspend fun markFailed(jobId: String, error: String) {
        postNoResponse(
            "/api/print-agent/jobs/$jobId/failed",
            json.encodeToString(FailedRequest(settings.deviceId, error.take(1000))),
        )
    }

    suspend fun createBackendTestLabel(): String {
        val request = authorizedRequest("/api/printer/test-label")
            .post(json.encodeToString(DeviceRequest(settings.deviceId)).toRequestBody(jsonMediaType))
            .build()
        return executeWithRetry(request).use { response ->
            if (!response.isSuccessful) throw IOException("create test label failed: HTTP ${response.code}")
            val body = response.body?.string().orEmpty()
            json.decodeFromString<TestLabelResponse>(body).job.id
        }
    }

    suspend fun retryOldestFailedJob(): String? {
        val request = authorizedRequest("/api/print-agent/jobs/retry-failed")
            .post(json.encodeToString(DeviceRequest(settings.deviceId)).toRequestBody(jsonMediaType))
            .build()
        return executeWithRetry(request).use { response ->
            if (!response.isSuccessful) throw IOException("retry failed job failed: HTTP ${response.code}")
            val body = response.body?.string().orEmpty()
            json.decodeFromString<RetryFailedJobResponse>(body).job?.id
        }
    }

    private suspend fun postNoResponse(path: String, jsonBody: String) {
        val request = authorizedRequest(path)
            .post(jsonBody.toRequestBody(jsonMediaType))
            .build()
        executeWithRetry(request).use { response ->
            if (!response.isSuccessful) throw IOException("$path failed: HTTP ${response.code}")
        }
    }

    private fun authorizedRequest(path: String): Request.Builder {
        return Request.Builder()
            .url("$baseUrl$path")
            .header("Authorization", "Bearer ${settings.printAgentToken}")
            .header("x-device-id", settings.deviceId)
            .header("Content-Type", "application/json")
    }

    private suspend fun executeWithRetry(request: Request): okhttp3.Response {
        var lastError: IOException? = null
        repeat(3) { attempt ->
            try {
                return withTimeout(20_000) {
                    withContext(Dispatchers.IO) {
                        client.newCall(request).execute()
                    }
                }
            } catch (err: IOException) {
                lastError = err
                delay((500L shl attempt).coerceAtMost(2_000L))
            }
        }
        throw lastError ?: IOException("backend request failed")
    }

    companion object {
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .build()
    }
}
