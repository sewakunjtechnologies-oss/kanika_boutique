package com.kanikadesigns.printbridge

import android.app.Application
import com.kanikadesigns.printbridge.service.NotificationHelper

class KanikaPrintBridgeApp : Application() {
    override fun onCreate() {
        super.onCreate()
        NotificationHelper.ensureChannels(this)
    }
}
