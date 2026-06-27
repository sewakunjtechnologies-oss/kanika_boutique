package com.kanikadesigns.printbridge.printer

<<<<<<< HEAD
import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.network.PrintJobDto
import com.kanikadesigns.printbridge.network.PrintJobType
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
=======
import com.google.gson.JsonObject
import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.network.PrintJobDto
import com.kanikadesigns.printbridge.network.PrintJobType
>>>>>>> ffbb103 (again subscribing)
import java.nio.charset.Charset
import kotlin.math.roundToInt

class TsplCommandGenerator : PrinterCommandGenerator {
    override fun generate(job: PrintJobDto, settings: BridgeSettings): ByteArray {
        val commands = when (job.type) {
            PrintJobType.OFFLINE_CUSTOMER_SLIP -> generateManualReceipt(job.payload, settings)
            PrintJobType.ORDER_LABEL -> generateOnlineOrderLabel(job.payload, settings)
            PrintJobType.OFFLINE_RETURN_SLIP -> generateReturnSlip(job.payload, settings)
            PrintJobType.TEST_LABEL -> generateTestLabel(job.payload, settings)
            PrintJobType.PRODUCT_BARCODE -> throw IllegalArgumentException("PRODUCT_BARCODE is not supported by Android TSPL bridge yet")
        }
        return commands.toByteArray(Charset.forName("US-ASCII"))
    }

    fun generateManualReceipt(payload: JsonObject, settings: BridgeSettings): String {
        val item = firstItem(payload)
        val receiptId = payload.str("receiptId", "MR-UNKNOWN")
        val total = payload.money("total", payload.money("amount", 0.0))
        return buildLabel(settings) {
            header("KANIKA DESIGNS", "RECEIPT")
            text(24, 86, "Receipt ID: ${receiptId.fit(26)}", FontSize.MEDIUM, bold = true)
            text(24, 126, "Customer: ${payload.str("customerName", "Walk-in").fit(34)}")
            text(24, 154, "Phone: ${payload.str("phoneMasked", "").fit(18)}")
            text(390, 154, "Payment: ${payload.str("paymentMethod", "-").fit(12)}")
<<<<<<< HEAD
            text(24, 194, "Product: ${item.str("name", payload.str("productName", "Item")).fit(34)}", FontSize.SMALL)
=======
            text(24, 194, "Product: ${item.str("name", payload.str("productName", "Item")).fit(34)}")
>>>>>>> ffbb103 (again subscribing)
            text(24, 222, "SKU: ${item.str("sku", payload.str("sku", "-")).fit(18)}")
            text(300, 222, "Size: ${item.str("size", payload.str("size", "-")).fit(8)}")
            text(500, 222, "Qty: ${item.int("quantity", payload.int("quantity", 1))}")
            text(24, 272, "Amount: Rs.${total.roundToInt()}", FontSize.LARGE, bold = true)
<<<<<<< HEAD
            barcode(126, receiptId)
=======
            barcode(receiptId)
>>>>>>> ffbb103 (again subscribing)
            text(0, bottomBarcodeTextY(), receiptId.fit(28), FontSize.TINY, center = true)
        }
    }

    fun generateOnlineOrderLabel(payload: JsonObject, settings: BridgeSettings): String {
        val orderId = payload.str("orderId", "KD-UNKNOWN")
<<<<<<< HEAD
=======
        val item = firstItem(payload)
        val subtotal = payload.money("subtotal", 0.0)
        val delivery = payload.money("deliveryCharge", 0.0)
        val discount = payload.money("discount", 0.0)
        val grandTotal = payload.money("grandTotal", payload.money("amount", 0.0))
>>>>>>> ffbb103 (again subscribing)
        val compactAddress = listOf(
            payload.str("addressLine1"),
            payload.str("addressLine2"),
            payload.str("city"),
            payload.str("state"),
        ).filter { it.isNotBlank() }.joinToString(", ").ifBlank { "Not provided" }

        return buildLabel(settings) {
            header("KANIKA DESIGNS", payload.str("paymentStatus", "PAID").ifBlank { "PAID" })
            text(24, 86, "Order ID: ${orderId.fit(28)}", FontSize.MEDIUM, bold = true)
            text(24, 126, "Customer: ${payload.str("customerName", "").fit(34)}")
            text(24, 154, "Phone: ${payload.str("phoneMasked", payload.str("maskedPhone", "")).fit(18)}")
            text(390, 154, "Pin: ${payload.str("pincode", "-").fit(10)}")
            text(24, 194, "Address: ${compactAddress.fit(56)}")
<<<<<<< HEAD
            text(24, 226, "Product: ${payload.str("productName", "Item").fit(34)}")
            text(24, 254, "SKU: ${payload.str("sku", "-").fit(18)}")
            text(300, 254, "Size: ${payload.str("size", "-").fit(8)}")
            text(500, 254, "Qty: ${payload.int("quantity", 1)}")
            text(24, 298, "Amount: Rs.${payload.money("amount", 0.0).roundToInt()}", FontSize.LARGE, bold = true)
            text(390, 302, "Payment: ${payload.str("paymentType", "UPI").fit(12)}")
            barcode(126, payload.str("barcodeValue", orderId))
=======
            text(24, 226, "Product: ${item.str("name", payload.str("productName", "Item")).fit(34)}")
            text(24, 254, "SKU: ${item.str("sku", payload.str("sku", "-")).fit(18)}")
            text(300, 254, "Size: ${item.str("size", payload.str("size", "-")).fit(8)}")
            text(500, 254, "Qty: ${payload.int("quantity", item.int("quantity", 1))}")
            text(24, 294, "Total: Rs.${grandTotal.roundToInt()}", FontSize.LARGE, bold = true)
            text(390, 298, "Payment: ${payload.str("paymentType", "UPI").fit(12)}")
            text(24, 330, "Sub:${subtotal.roundToInt()} Del:${delivery.roundToInt()} Disc:${discount.roundToInt()}", FontSize.TINY)
            barcode(payload.str("barcodeValue", orderId))
>>>>>>> ffbb103 (again subscribing)
            text(0, bottomBarcodeTextY(), orderId.fit(28), FontSize.TINY, center = true)
        }
    }

    fun generateReturnSlip(payload: JsonObject, settings: BridgeSettings): String {
        val item = firstItem(payload)
        val returnId = payload.str("returnId", "RET-UNKNOWN")
        return buildLabel(settings) {
            header("KANIKA DESIGNS", "RETURN")
            text(24, 86, "Return ID: ${returnId.fit(28)}", FontSize.MEDIUM, bold = true)
            text(24, 126, "Receipt: ${payload.str("receiptId", "-").fit(24)}")
            text(24, 154, "Customer: ${payload.str("customerName", "Walk-in").fit(34)}")
            text(24, 194, "Product: ${item.str("name", "Returned item").fit(34)}")
            text(24, 222, "SKU: ${item.str("sku", "-").fit(18)}")
            text(300, 222, "Size: ${item.str("size", "-").fit(8)}")
            text(500, 222, "Qty: ${item.int("quantity", 1)}")
            text(24, 272, "Refund: Rs.${payload.money("refundAmount", 0.0).roundToInt()}", FontSize.LARGE, bold = true)
            text(390, 276, "Mode: ${payload.str("refundMethod", "-").fit(12)}")
<<<<<<< HEAD
            barcode(126, returnId)
=======
            barcode(returnId)
>>>>>>> ffbb103 (again subscribing)
            text(0, bottomBarcodeTextY(), returnId.fit(28), FontSize.TINY, center = true)
        }
    }

    fun generateTestLabel(payload: JsonObject, settings: BridgeSettings): String {
        val orderId = payload.str("orderId", "KD-TEST-1001")
        return buildLabel(settings) {
            header("KANIKA DESIGNS", "TEST")
            text(24, 86, "Android TCP TSPL Test", FontSize.MEDIUM, bold = true)
            text(24, 126, "Printer: 4BARCODE 4B-2054TG")
            text(24, 154, "Label: ${settings.labelSize.wireValue} Direction: ${settings.direction}")
            text(24, 194, "Backend job: ${payload.str("barcodeValue", orderId).fit(30)}")
            text(24, 254, "If this is sideways, switch DIRECTION 0/1.")
<<<<<<< HEAD
            barcode(126, payload.str("barcodeValue", orderId))
=======
            barcode(payload.str("barcodeValue", orderId))
>>>>>>> ffbb103 (again subscribing)
            text(0, bottomBarcodeTextY(), orderId.fit(28), FontSize.TINY, center = true)
        }
    }

    private fun buildLabel(settings: BridgeSettings, block: LabelBuilder.() -> Unit): String {
        val builder = LabelBuilder(settings)
        builder.preamble()
        builder.block()
        builder.finish()
        return builder.toString()
    }

    private fun firstItem(payload: JsonObject): JsonObject {
<<<<<<< HEAD
        val items = payload["items"] as? JsonArray
        return items?.firstOrNull()?.jsonObject ?: JsonObject(emptyMap())
=======
        val items = payload.getAsJsonArray("items")
        return items?.firstOrNull()?.asJsonObject ?: JsonObject()
>>>>>>> ffbb103 (again subscribing)
    }
}

private class LabelBuilder(private val settings: BridgeSettings) {
    private val sb = StringBuilder()
    private val width = settings.labelSize.widthDots
    private val height = settings.labelSize.heightDots

    fun preamble() {
        sb.appendLine("SIZE ${settings.labelSize.widthMm} mm,${settings.labelSize.heightMm} mm")
        sb.appendLine("GAP 3 mm,0 mm")
        sb.appendLine("DIRECTION ${settings.direction}")
        sb.appendLine("REFERENCE 0,0")
        sb.appendLine("CLS")
    }

    fun header(title: String, badge: String) {
        text(24, 24, title.fit(22), FontSize.BRAND, bold = true)
        box(width - 184, 18, width - 24, 62, 3)
        text(width - 168, 30, badge.fit(10), FontSize.SMALL, bold = true)
        line(24, 72, width - 24, 72, 3)
    }

    fun text(
        x: Int,
        y: Int,
        value: String,
        size: FontSize = FontSize.SMALL,
        bold: Boolean = false,
        center: Boolean = false,
    ) {
        val textX = if (center) ((width - (value.length * size.approxWidthDots)) / 2).coerceAtLeast(0) else x
        val font = if (bold) "0" else "1"
        sb.appendLine("TEXT $textX,$y,\"$font\",0,${size.xMul},${size.yMul},\"${value.tsplSafe()}\"")
    }

<<<<<<< HEAD
    fun barcode(y: Int, value: String) {
        val barcodeY = (height - 136).coerceAtLeast(y)
=======
    fun barcode(value: String) {
        val barcodeY = (height - 136).coerceAtLeast(126)
>>>>>>> ffbb103 (again subscribing)
        sb.appendLine("BARCODE 118,$barcodeY,\"128\",72,1,0,2,2,\"${value.tsplSafe()}\"")
    }

    fun bottomBarcodeTextY(): Int = (height - 42).coerceAtLeast(520)

    fun line(x1: Int, y1: Int, x2: Int, y2: Int, thickness: Int) {
        sb.appendLine("BAR $x1,$y1,${x2 - x1},$thickness")
    }

    fun box(x1: Int, y1: Int, x2: Int, y2: Int, thickness: Int) {
        sb.appendLine("BOX $x1,$y1,$x2,$y2,$thickness")
    }

    fun finish() {
        sb.appendLine("PRINT 1,1")
    }

    override fun toString(): String = sb.toString()
}

enum class FontSize(val xMul: Int, val yMul: Int, val approxWidthDots: Int) {
    TINY(1, 1, 8),
    SMALL(1, 1, 10),
    MEDIUM(1, 2, 11),
    LARGE(2, 2, 18),
    BRAND(2, 2, 18),
}

private fun JsonObject.str(key: String, fallback: String = ""): String {
<<<<<<< HEAD
    val element: JsonElement = this[key] ?: return fallback
    return (element as? JsonPrimitive)?.contentOrNullSafe() ?: fallback
}

private fun JsonObject.int(key: String, fallback: Int): Int {
    val element = this[key] ?: return fallback
    return element.jsonPrimitive.intOrNull ?: fallback
}

private fun JsonObject.money(key: String, fallback: Double): Double {
    val element = this[key] ?: return fallback
    return element.jsonPrimitive.doubleOrNull ?: fallback
}

private fun JsonPrimitive.contentOrNullSafe(): String? = runCatching { content }.getOrNull()

=======
    val element = get(key) ?: return fallback
    return if (element.isJsonPrimitive) element.asString ?: fallback else fallback
}

private fun JsonObject.int(key: String, fallback: Int): Int {
    val element = get(key) ?: return fallback
    return runCatching { element.asInt }.getOrDefault(fallback)
}

private fun JsonObject.money(key: String, fallback: Double): Double {
    val element = get(key) ?: return fallback
    return runCatching { element.asDouble }.getOrDefault(fallback)
}

>>>>>>> ffbb103 (again subscribing)
private fun String.fit(max: Int): String {
    val normalized = replace(Regex("\\s+"), " ").trim()
    if (normalized.length <= max) return normalized
    if (max <= 1) return normalized.take(max)
    return normalized.take(max - 1) + "."
}

private fun String.tsplSafe(): String {
    return replace('₹', 'R')
        .replace("—", "-")
        .replace("–", "-")
        .replace("\"", "'")
        .replace(Regex("[^\\x20-\\x7E]"), "")
}
