package com.kanikadesigns.printbridge.network

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
data class PrintJobResponse(
    val job: PrintJobDto? = null,
)

@Serializable
data class PrintJobDto(
    val id: String,
    val type: PrintJobType,
    val status: PrintJobStatus,
    val payload: JsonObject,
    val attempts: Int = 0,
    val createdAt: String = "",
)

@Serializable
enum class PrintJobType {
    @SerialName("ORDER_LABEL")
    ORDER_LABEL,

    @SerialName("OFFLINE_CUSTOMER_SLIP")
    OFFLINE_CUSTOMER_SLIP,

    @SerialName("OFFLINE_RETURN_SLIP")
    OFFLINE_RETURN_SLIP,

    @SerialName("PRODUCT_BARCODE")
    PRODUCT_BARCODE,

    @SerialName("TEST_LABEL")
    TEST_LABEL,
}

@Serializable
enum class PrintJobStatus {
    @SerialName("PENDING")
    PENDING,

    @SerialName("CLAIMED")
    CLAIMED,

    @SerialName("PRINTING")
    PRINTING,

    @SerialName("PRINTED")
    PRINTED,

    @SerialName("DRY_RUN_COMPLETED")
    DRY_RUN_COMPLETED,

    @SerialName("FAILED")
    FAILED,

    @SerialName("CANCELLED")
    CANCELLED,
}

@Serializable
data class DeviceRequest(
    val deviceId: String,
)

@Serializable
data class HeartbeatRequest(
    val deviceId: String,
    val printerName: String,
    val labelSize: String,
    val printJobBatchSize: Int = 1,
    val dryRun: Boolean = false,
)

@Serializable
data class FailedRequest(
    val deviceId: String,
    val error: String,
)

@Serializable
data class TestLabelResponse(
    val job: CreatedPrintJob,
)

@Serializable
data class CreatedPrintJob(
    val id: String,
    val status: String,
    val type: String,
)

@Serializable
data class RetryFailedJobResponse(
    val ok: Boolean,
    val job: CreatedPrintJob? = null,
)
