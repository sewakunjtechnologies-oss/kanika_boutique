package com.kanikadesigns.printbridge.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.kanikadesigns.printbridge.data.BridgeRuntimeStatus
import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.data.PrintedJobStore
import com.kanikadesigns.printbridge.data.SettingsStore
import com.kanikadesigns.printbridge.network.BackendClient
import com.kanikadesigns.printbridge.network.PrintJobDto
import com.kanikadesigns.printbridge.printer.PrinterCommandGenerator
import com.kanikadesigns.printbridge.printer.TcpPrinterClient
import com.kanikadesigns.printbridge.printer.TsplCommandGenerator
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class PrintBridgeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loopJob: Job? = null
    private lateinit var settingsStore: SettingsStore
    private lateinit var printedJobStore: PrintedJobStore

    override fun onCreate() {
        super.onCreate()
        settingsStore = SettingsStore(this)
        printedJobStore = PrintedJobStore(this)
        NotificationHelper.ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            settingsStore.setServiceWanted(false)
            stopSelf()
            return START_NOT_STICKY
        }
        startBridgeLoop()
        return START_STICKY
    }

    override fun onDestroy() {
        loopJob?.cancel()
        settingsStore.saveLastStatus(settingsStore.readLastStatus().copy(running = false))
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startBridgeLoop() {
        val settings = settingsStore.read()
        settingsStore.setServiceWanted(true)
        startForeground(
            NotificationHelper.SERVICE_NOTIFICATION_ID,
            NotificationHelper.serviceNotification(this, "Kanika Print Bridge running", "Starting printer bridge..."),
        )
        if (!settings.isConfigured) {
            updateStatus("Configuration incomplete", lastError = "Fill backend, token, device ID and printer IP.")
            stopSelf()
            return
        }
        if (loopJob?.isActive == true) return

        loopJob = scope.launch {
            val backend = BackendClient(settings)
            val tcpPrinter = TcpPrinterClient()
            val generator = TsplCommandGenerator()
            var lastHeartbeatAt = 0L

            while (isActive) {
                try {
                    val now = System.currentTimeMillis()
                    if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
                        backend.sendHeartbeat()
                        lastHeartbeatAt = now
                    }

                    val job = backend.fetchNextJob()
                    if (job == null) {
                        updateStatus("Bridge running", "No pending print jobs.")
                    } else {
                        processJob(job, backend, tcpPrinter, generator, settings)
                    }
                } catch (err: CancellationException) {
                    throw err
                } catch (err: Exception) {
                    updateStatus("Bridge running", "Retrying after error.", err.message ?: "Unknown error")
                }
                delay(settings.pollIntervalSeconds.coerceAtLeast(1) * 1000L)
            }
        }
    }

    private suspend fun processJob(
        job: PrintJobDto,
        backend: BackendClient,
        tcpPrinter: TcpPrinterClient,
        generator: PrinterCommandGenerator,
        settings: BridgeSettings,
    ) {
        if (printedJobStore.isCompleted(job.id)) {
            backend.markPrinted(job.id)
            updateStatus("Duplicate job skipped", "Already printed locally: ${job.id}")
            return
        }

        try {
            updateStatus("Printing job ${job.id}", "Type: ${job.type}")
            backend.markPrinting(job.id)
            val command = generator.generate(job, settings)
            tcpPrinter.sendRawCommand(settings.printerIp, settings.printerPort, command)
            printedJobStore.markPrinted(job.id)
            backend.markPrinted(job.id)
            updateStatus("Last job printed", "${job.type} ${job.id}")
        } catch (err: Exception) {
            val message = err.message ?: "Print failed"
            runCatching { backend.markFailed(job.id, message) }
            updateStatus("Print failed", "Job ${job.id}", message)
        }
    }

    private fun updateStatus(title: String, detail: String = "", lastError: String = "") {
        settingsStore.saveLastStatus(
            BridgeRuntimeStatus(
                running = true,
                lastJob = detail,
                lastError = lastError,
            ),
        )
        val notification = NotificationHelper.serviceNotification(
            this,
            "Kanika Print Bridge running",
            listOf(title, detail, lastError).filter { it.isNotBlank() }.joinToString("\n"),
        )
        runCatching {
            NotificationManagerCompat.from(this).notify(NotificationHelper.SERVICE_NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val ACTION_STOP = "com.kanikadesigns.printbridge.STOP"
        private const val HEARTBEAT_INTERVAL_MS = 30_000L

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, PrintBridgeService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, PrintBridgeService::class.java).setAction(ACTION_STOP))
        }
    }
}
