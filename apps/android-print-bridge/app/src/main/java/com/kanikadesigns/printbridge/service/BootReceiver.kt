package com.kanikadesigns.printbridge.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.kanikadesigns.printbridge.data.SettingsStore

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val store = SettingsStore(context)
        val settings = store.read()
        if (!store.serviceWanted() || !settings.autoStartAfterBoot) {
            NotificationHelper.showBootPrompt(context)
            return
        }

        runCatching {
            PrintBridgeService.start(context)
        }.onFailure {
            NotificationHelper.showBootPrompt(context)
        }
    }
}
