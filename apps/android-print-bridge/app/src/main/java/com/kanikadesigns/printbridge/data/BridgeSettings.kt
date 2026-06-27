package com.kanikadesigns.printbridge.data

<<<<<<< HEAD
enum class LabelSize(val wireValue: String, val widthDots: Int, val heightDots: Int, val widthMm: String, val heightMm: String) {
=======
enum class LabelSize(
    val wireValue: String,
    val widthDots: Int,
    val heightDots: Int,
    val widthMm: String,
    val heightMm: String,
) {
>>>>>>> ffbb103 (again subscribing)
    FOUR_BY_THREE("4x3", 812, 609, "101.6", "76.2"),
    FOUR_BY_FOUR("4x4", 812, 812, "101.6", "101.6");

    companion object {
        fun from(value: String): LabelSize = entries.firstOrNull { it.wireValue == value } ?: FOUR_BY_THREE
    }
}

enum class PrinterLanguage {
    TSPL;

    companion object {
        fun from(value: String): PrinterLanguage = entries.firstOrNull { it.name == value.uppercase() } ?: TSPL
    }
}

data class BridgeSettings(
    val backendUrl: String = "https://kanika-boutique.onrender.com",
    val printAgentToken: String = "",
    val deviceId: String = "kanika-shop-android-01",
    val printerIp: String = "",
    val printerPort: Int = 9100,
    val printerLanguage: PrinterLanguage = PrinterLanguage.TSPL,
    val labelSize: LabelSize = LabelSize.FOUR_BY_THREE,
    val pollIntervalSeconds: Int = 3,
    val direction: Int = 1,
    val autoStartAfterBoot: Boolean = false,
) {
    val isConfigured: Boolean
        get() = backendUrl.isNotBlank() &&
            printAgentToken.isNotBlank() &&
            deviceId.isNotBlank() &&
            printerIp.isNotBlank() &&
            printerPort in 1..65535 &&
            pollIntervalSeconds >= 1 &&
            direction in 0..1
}
