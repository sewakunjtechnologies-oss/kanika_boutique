package com.kanikadesigns.printbridge.network

import com.google.gson.JsonObject
import com.google.gson.annotations.SerializedName

data class PrintJobResponse(
    val job: PrintJobDto? = null,
)

data class PrintJobDto(
    val id: String,
    val type: PrintJobType,
    val status: PrintJobStatus,
    val payload: JsonObject,
    val attempts: Int = 0,
    val createdAt: String = "",
)

enum class PrintJobType {
    @SerializedName("ORDER_LABEL")
    ORDER_LABEL,

    @SerializedName("OFFLINE_CUSTOMER_SLIP")
    OFFLINE_CUSTOMER_SLIP,

    @SerializedName("OFFLINE_RETURN_SLIP")
    OFFLINE_RETURN_SLIP,

    @SerializedName("PRODUCT_BARCODE")
    PRODUCT_BARCODE,

    @SerializedName("TEST_LABEL")
    TEST_LABEL,
}

enum class PrintJobStatus {
    @SerializedName("PENDING")
    PENDING,

    @SerializedName("CLAIMED")
    CLAIMED,

    @SerializedName("PRINTING")
    PRINTING,

    @SerializedName("PRINTED")
    PRINTED,

    @SerializedName("DRY_RUN_COMPLETED")
    DRY_RUN_COMPLETED,

    @SerializedName("FAILED")
    FAILED,

    @SerializedName("CANCELLED")
    CANCELLED,
}

data class DeviceRequest(
    val deviceId: String,
)

data class HeartbeatRequest(
    val deviceId: String,
    val printerName: String,
    val labelSize: String,
    val printJobBatchSize: Int = 1,
    val dryRun: Boolean = false,
)

data class FailedRequest(
    val deviceId: String,
    val error: String,
)

data class TestLabelResponse(
    val job: CreatedPrintJob,
)

data class RetryFailedJobResponse(
    val ok: Boolean,
    val job: CreatedPrintJob? = null,
)

data class CreatedPrintJob(
    val id: String,
    val status: String,
    val type: String,
)
