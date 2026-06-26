package com.kanikadesigns.printbridge.printer

import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.network.PrintJobDto

interface PrinterCommandGenerator {
    fun generate(job: PrintJobDto, settings: BridgeSettings): ByteArray
}
