package com.kanikadesigns.printbridge.network

<<<<<<< HEAD
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

@Serializable
=======
import com.google.gson.JsonObject
import com.google.gson.annotations.SerializedName

>>>>>>> ffbb103 (again subscribing)
data class PrintJobResponse(
    val job: PrintJobDto? = null,
)

<<<<<<< HEAD
@Serializable
=======
>>>>>>> ffbb103 (again subscribing)
data class PrintJobDto(
    val id: String,
    val type: PrintJobType,
    val status: PrintJobStatus,
    val payload: JsonObject,
    val attempts: Int = 0,
    val createdAt: String = "",
)

<<<<<<< HEAD
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
=======
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

>>>>>>> ffbb103 (again subscribing)
data class DeviceRequest(
    val deviceId: String,
)

<<<<<<< HEAD
@Serializable
=======
>>>>>>> ffbb103 (again subscribing)
data class HeartbeatRequest(
    val deviceId: String,
    val printerName: String,
    val labelSize: String,
    val printJobBatchSize: Int = 1,
    val dryRun: Boolean = false,
)

<<<<<<< HEAD
@Serializable
=======
>>>>>>> ffbb103 (again subscribing)
data class FailedRequest(
    val deviceId: String,
    val error: String,
)

<<<<<<< HEAD
@Serializable
=======
>>>>>>> ffbb103 (again subscribing)
data class TestLabelResponse(
    val job: CreatedPrintJob,
)

<<<<<<< HEAD
@Serializable
=======
data class RetryFailedJobResponse(
    val ok: Boolean,
    val job: CreatedPrintJob? = null,
)

>>>>>>> ffbb103 (again subscribing)
data class CreatedPrintJob(
    val id: String,
    val status: String,
    val type: String,
)
<<<<<<< HEAD

@Serializable
data class RetryFailedJobResponse(
    val ok: Boolean,
    val job: CreatedPrintJob? = null,
)
=======
>>>>>>> ffbb103 (again subscribing)
