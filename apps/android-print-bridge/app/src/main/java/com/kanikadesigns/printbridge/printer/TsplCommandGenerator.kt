package com.kanikadesigns.printbridge.printer

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.network.PrintJobDto
import com.kanikadesigns.printbridge.network.PrintJobType
import java.nio.charset.Charset
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Builds raw TSPL for the 4BARCODE 4B-2054TG (203 DPI, 4x3 in / 812x609 dots).
 *
 * Readability rules (must stay in sync with the backend payload + tests):
 *  - title uses TSPL font "4", IDs / customer / products / totals use font "3",
 *    secondary details use font "2". Font "1" is never used for real content.
 *  - the final amount is the most prominent line (font "4").
 *  - every label fits inside safe margins; a flowing y-cursor prevents overlap.
 *  - the barcode renders its own human-readable text once (no duplicate TEXT).
 *  - delivery / totals come straight from the backend payload; nothing is
 *    recalculated here.
 */
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

    /** OFFLINE_CUSTOMER_SLIP — manual receipt. Never prints a delivery address. */
    fun generateManualReceipt(payload: JsonObject, settings: BridgeSettings): String {
        val receiptId = payload.str("receiptId", "MR-UNKNOWN")
        val items = lineItems(payload)
        val total = payload.money("total", payload.money("amount", 0.0))
        return buildLabel(settings) {
            header("KANIKA DESIGNS", "MANUAL RECEIPT")
            idRow("Receipt", receiptId)
            twoColumn(Font.BODY, "Date: ${formatDateTime(payload.str("createdAt"))}", "Pay: ${payload.str("paymentMethod", "-").fitText(12)}")
            row(Font.HEADING, "Customer: ${payload.str("customerName", "Walk-in customer").ifBlankText("Walk-in customer").fitText(32)}")
            row(Font.BODY, "Phone: ${payload.str("phoneMasked", payload.str("maskedPhone", "-")).fitText(22)}")
            divider()
            itemRows(items, maxLines = 4)
            divider()
            totalsRow(
                subtotal = payload.money("subtotal", 0.0),
                delivery = payload.money("delivery", payload.money("deliveryCharge", 0.0)),
                discount = payload.money("discount", 0.0),
            )
            grandTotalRow("TOTAL", total)
            barcode(payload.str("barcodeValue", receiptId))
        }
    }

    /** ORDER_LABEL — paid online order. Includes the compact delivery address. */
    fun generateOnlineOrderLabel(payload: JsonObject, settings: BridgeSettings): String {
        val orderId = payload.str("orderId", "KD-UNKNOWN")
        val items = lineItems(payload)
        val grandTotal = payload.money("grandTotal", payload.money("amount", 0.0))
        val statusBadge = payload.str("paymentStatus", "PAID").ifBlankText("PAID").uppercase()
        val compactAddress = listOf(
            payload.str("addressLine1", payload.str("addressLine")),
            payload.str("addressLine2"),
        ).filter { it.isNotBlank() }.joinToString(", ").ifBlank { "Not provided" }
        val cityState = listOf(payload.str("city"), payload.str("state"))
            .filter { it.isNotBlank() }.joinToString(", ")

        return buildLabel(settings) {
            header("KANIKA DESIGNS", statusBadge)
            idRow("Order", orderId)
            twoColumn(
                Font.HEADING,
                "Date: ${formatDateTime(payload.str("createdAt"))}",
                "Status: ${statusBadge.fitText(12)}",
            )
            row(Font.HEADING, "Customer: ${payload.str("customerName", "-").fitText(30)}")
            twoColumn(
                Font.HEADING,
                "Phone: ${payload.str("phoneMasked", payload.str("maskedPhone", "-")).fitText(16)}",
                "Pin: ${payload.str("pincode", "-").fitText(10)}",
            )
            // The delivery address is what actually gets the parcel to the
            // customer, so it prints at the readable heading font and WRAPS across
            // up to two lines instead of being truncated to a single line.
            addressBlock("Addr: ", compactAddress, Font.HEADING, maxLines = 2)
            if (cityState.isNotBlank()) {
                row(Font.HEADING, cityState.fitText(44))
            }
            divider()
            itemRows(items, maxLines = 3)
            divider()
            totalsRow(
                subtotal = payload.money("subtotal", 0.0),
                delivery = payload.money("deliveryCharge", payload.money("delivery", 0.0)),
                discount = payload.money("discount", 0.0),
            )
            grandTotalRow("TOTAL", grandTotal)
            row(Font.BODY, "Payment: ${payload.str("paymentType", "UPI").fitText(10)} / ${statusBadge.fitText(10)}")
            barcode(payload.str("barcodeValue", orderId))
        }
    }

    fun generateReturnSlip(payload: JsonObject, settings: BridgeSettings): String {
        val returnId = payload.str("returnId", "RET-UNKNOWN")
        val items = lineItems(payload)
        return buildLabel(settings) {
            header("KANIKA DESIGNS", "RETURN")
            idRow("Return", returnId)
            twoColumn(Font.BODY, "Receipt: ${payload.str("receiptId", "-").fitText(20)}", "Date: ${formatDateTime(payload.str("createdAt"))}")
            row(Font.HEADING, "Customer: ${payload.str("customerName", "Walk-in customer").fitText(32)}")
            divider()
            itemRows(items, maxLines = 4)
            divider()
            grandTotalRow("REFUND", payload.money("refundAmount", 0.0))
            row(Font.BODY, "Mode: ${payload.str("refundMethod", "-").fitText(16)}")
            barcode(payload.str("barcodeValue", returnId))
        }
    }

    fun generateTestLabel(payload: JsonObject, settings: BridgeSettings): String {
        val fallbackJobId = payload.str("orderId", "KD-TEST-1001").ifBlankText("KD-TEST-1001")
        val barcodeValue = payload.str("barcodeValue", fallbackJobId).ifBlankText(fallbackJobId)
        val printerName = payload.str("printerName", "4BARCODE 4B-2054TG").ifBlankText("4BARCODE 4B-2054TG")
        val labelSize = settings.labelSize

        fun StringBuilder.text(x: Int, y: Int, font: String, value: String) {
            appendLine("TEXT $x,$y,\"$font\",0,1,1,\"${value.tsplSafe()}\"")
        }

        return buildString {
            appendLine("SIZE ${labelSize.widthMm} mm,${labelSize.heightMm} mm")
            appendLine("GAP 3 mm,0 mm")
            appendLine("DIRECTION ${settings.direction}")
            appendLine("REFERENCE 0,0")
            appendLine("CLS")
            text(35, 30, "4", "KANIKA PRINT TEST")
            appendLine("BAR 35,85,740,3")
            text(35, 115, "3", "Printer: ${printerName.fitText(37)}")
            text(35, 160, "3", "Label: ${labelSize.wireValue}")
            text(300, 160, "3", "Direction: ${settings.direction}")
            text(35, 220, "4", "Job: ${barcodeValue.fitText(24)}")
            text(35, 285, "3", "If sideways, switch Direction 0/1.")
            appendLine("BARCODE 180,390,\"128\",95,0,0,2,2,\"${barcodeValue.tsplSafe()}\"")
            text(265, 505, "3", barcodeValue.fitText(28))
            appendLine("PRINT 1")
        }
    }

    private fun buildLabel(settings: BridgeSettings, block: LabelBuilder.() -> Unit): String {
        val builder = LabelBuilder(settings)
        builder.preamble()
        builder.block()
        builder.finish()
        return builder.toString()
    }

    private fun lineItems(payload: JsonObject): List<JsonObject> {
        val array: JsonArray? = payload.getAsJsonArray("items")
        val items = array?.mapNotNull { if (it.isJsonObject) it.asJsonObject else null }.orEmpty()
        if (items.isNotEmpty()) return items
        // Fall back to the flat top-level single-item fields when no items array.
        if (payload.has("productName") || payload.has("sku")) {
            val fallback = JsonObject()
            fallback.addProperty("name", payload.str("productName"))
            fallback.addProperty("sku", payload.str("sku"))
            fallback.addProperty("size", payload.str("size"))
            fallback.addProperty("quantity", payload.int("quantity", 1))
            fallback.addProperty("amount", payload.money("amount", 0.0))
            return listOf(fallback)
        }
        return emptyList()
    }
}

/**
 * TSPL built-in bitmap fonts. Font "1" is intentionally excluded so it is never
 * used for real content. `charWidth` is the approximate printed glyph width in
 * dots, used for centering and column fitting; `lineHeight` includes row spacing.
 */
enum class Font(val tsplFont: String, val xMul: Int, val yMul: Int, val charWidth: Int, val lineHeight: Int) {
    TITLE("4", 1, 1, 24, 40),
    GRAND("4", 1, 1, 24, 44),
    HEADING("3", 1, 1, 16, 32),
    BODY("2", 1, 1, 12, 26),
}

private class LabelBuilder(settings: BridgeSettings) {
    private val sb = StringBuilder()
    private val direction = settings.direction
    private val labelSize = settings.labelSize
    private val width = labelSize.widthDots
    private val height = labelSize.heightDots

    private val leftMargin = 28
    private val rightMargin = 28
    private val topMargin = 24
    private val bottomMargin = 30
    private val contentRight = width - rightMargin

    // Reserve the bottom band for the barcode + its human-readable text so
    // content rows can never push it off the label.
    private val barcodeHeight = 70
    private val barcodeTop = height - bottomMargin - barcodeHeight - 30
    private val contentLimit = barcodeTop - 10

    private var cursorY = topMargin

    fun preamble() {
        sb.appendLine("SIZE ${labelSize.widthMm} mm,${labelSize.heightMm} mm")
        sb.appendLine("GAP 3 mm,0 mm")
        sb.appendLine("DIRECTION $direction")
        sb.appendLine("REFERENCE 0,0")
        sb.appendLine("CLS")
    }

    fun header(title: String, badge: String) {
        text(leftMargin, cursorY, title.fitText(18), Font.TITLE)
        val safeBadge = badge.fitText(14)
        val badgeWidth = safeBadge.length * Font.HEADING.charWidth
        val badgeX = max(leftMargin, contentRight - badgeWidth)
        text(badgeX, cursorY + 6, safeBadge, Font.HEADING)
        cursorY += Font.TITLE.lineHeight
        line(leftMargin, cursorY, contentRight, 3)
        cursorY += 10
    }

    /** Stable identifier line (font "3"). */
    fun idRow(label: String, id: String) {
        row(Font.HEADING, "$label ID: ${id.fitText(28)}")
    }

    fun row(font: Font, value: String) {
        if (cursorY + font.lineHeight > contentLimit) return
        text(leftMargin, cursorY, value, font)
        cursorY += font.lineHeight
    }

    fun twoColumn(font: Font, left: String, right: String) {
        if (cursorY + font.lineHeight > contentLimit) return
        text(leftMargin, cursorY, left, font)
        val rightWidth = right.length * font.charWidth
        val rightX = max(leftMargin + left.length * font.charWidth + 12, contentRight - rightWidth)
        text(rightX, cursorY, right, font)
        cursorY += font.lineHeight
    }

    /**
     * Prints a delivery address at [font], word-wrapped across up to [maxLines]
     * lines so a long address is never silently collapsed to one truncated line.
     * The first line carries [prefix] (e.g. "Addr: "); every emitted line is
     * width-fitted to the label, and any overflow past [maxLines] ends the last
     * line with a trailing dot. Each line goes through [row], so the same
     * bottom-of-label guard that protects totals/barcode applies here too.
     */
    fun addressBlock(prefix: String, address: String, font: Font, maxLines: Int) {
        val maxChars = ((contentRight - leftMargin) / font.charWidth).coerceAtLeast(8)
        wrapWords(address, maxChars, prefix.length, maxLines).forEachIndexed { index, lineText ->
            row(font, if (index == 0) "$prefix$lineText" else lineText)
        }
    }

    /**
     * Greedy word-wrap into at most [maxLines] lines. Line 0 reserves
     * [firstIndent] glyphs for a caller prefix; every returned line is guaranteed
     * to fit [maxChars] glyphs (a single over-long word is hard-cut). If words
     * remain after [maxLines], the last line ends with a dot so nothing overflows.
     */
    private fun wrapWords(text: String, maxChars: Int, firstIndent: Int, maxLines: Int): List<String> {
        val words = text.replace(Regex("\\s+"), " ").trim().split(" ").filter { it.isNotEmpty() }
        if (words.isEmpty()) return listOf("")
        val allLines = mutableListOf<String>()
        var current = StringBuilder()
        for (word in words) {
            val capacity = (if (allLines.isEmpty()) maxChars - firstIndent else maxChars).coerceAtLeast(1)
            val candidate = if (current.isEmpty()) word else "$current $word"
            when {
                candidate.length <= capacity -> current = StringBuilder(candidate)
                current.isEmpty() -> allLines.add(word.fitText(capacity))
                else -> {
                    allLines.add(current.toString())
                    current = StringBuilder(word)
                }
            }
        }
        if (current.isNotEmpty()) allLines.add(current.toString())
        if (allLines.size <= maxLines) return allLines.ifEmpty { listOf("") }

        val kept = allLines.take(maxLines).toMutableList()
        val lastCapacity = (if (maxLines <= 1) maxChars - firstIndent else maxChars).coerceAtLeast(1)
        val lastIndex = kept.lastIndex
        kept[lastIndex] = (kept[lastIndex] + " .").fitText(lastCapacity)
        return kept
    }

    fun divider() {
        if (cursorY + 8 > contentLimit) return
        line(leftMargin, cursorY, contentRight, 2)
        cursorY += 10
    }

    /**
     * Compact, per-item lines that keep the product name and SKU as separate
     * fields. Caps at [maxLines]; any remaining items collapse into a summary so
     * totals and the barcode always stay on the label.
     */
    fun itemRows(items: List<JsonObject>, maxLines: Int) {
        if (items.isEmpty()) {
            row(Font.BODY, "No items listed")
            return
        }
        val shown = if (items.size > maxLines) maxLines - 1 else items.size
        items.take(shown).forEachIndexed { index, item ->
            row(Font.BODY, itemLine(index + 1, item))
        }
        val remaining = items.size - shown
        if (remaining > 0) {
            val remainingQty = items.drop(shown).sumOf { it.int("quantity", 1) }
            row(Font.BODY, "+ $remaining more item(s), $remainingQty pc")
        }
    }

    private fun itemLine(index: Int, item: JsonObject): String {
        val name = item.str("name").ifBlankText("Unnamed product").fitText(18)
        val sku = item.str("sku").ifBlankText("-").fitText(10)
        val size = item.str("size").ifBlankText("-").fitText(6)
        val qty = item.int("quantity", 1)
        val amount = item.money("amount", item.money("unitPrice", 0.0) * qty)
        return "$index. $name | $sku | $size | Q$qty | Rs.${amount.roundToInt()}"
    }

    fun totalsRow(subtotal: Double, delivery: Double, discount: Double) {
        row(Font.BODY, "Sub Rs.${subtotal.roundToInt()}   Del Rs.${delivery.roundToInt()}   Disc Rs.${discount.roundToInt()}")
    }

    /** Most prominent line on the label (font "4"). */
    fun grandTotalRow(label: String, amount: Double) {
        if (cursorY + Font.GRAND.lineHeight > contentLimit) {
            cursorY = contentLimit - Font.GRAND.lineHeight
        }
        text(leftMargin, cursorY, "$label  Rs.${amount.roundToInt()}", Font.GRAND)
        cursorY += Font.GRAND.lineHeight
    }

    /**
     * One Code128 barcode anchored in the reserved bottom band. The printer
     * renders the human-readable value itself (parameter = 1), so we never print
     * a duplicate TEXT line for it.
     */
    fun barcode(value: String) {
        val safe = value.tsplSafe()
        val estimatedWidth = safe.length * 22 + 40
        val x = max(leftMargin, (width - estimatedWidth) / 2)
        sb.appendLine("BARCODE $x,$barcodeTop,\"128\",$barcodeHeight,1,0,2,2,\"$safe\"")
    }

    private fun text(x: Int, y: Int, value: String, font: Font) {
        sb.appendLine("TEXT $x,$y,\"${font.tsplFont}\",0,${font.xMul},${font.yMul},\"${value.tsplSafe()}\"")
    }

    private fun line(x1: Int, y1: Int, x2: Int, thickness: Int) {
        sb.appendLine("BAR $x1,$y1,${x2 - x1},$thickness")
    }

    fun finish() {
        sb.appendLine("PRINT 1,1")
    }

    override fun toString(): String = sb.toString()
}

private fun JsonObject.str(key: String, fallback: String = ""): String {
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

private fun String.ifBlankText(fallback: String): String = ifBlank { fallback }

/** Collapse whitespace/newlines and truncate to [max] glyphs with a trailing dot. */
private fun String.fitText(max: Int): String {
    val normalized = replace(Regex("\\s+"), " ").trim()
    if (normalized.length <= max) return normalized
    if (max <= 1) return normalized.take(max)
    return normalized.take(max - 1) + "."
}

/** ISO timestamp -> "YYYY-MM-DD HH:MM"; returns input (trimmed) if unparseable. */
private fun formatDateTime(value: String): String {
    if (value.isBlank()) return "-"
    val parts = value.split("T")
    val date = parts.getOrNull(0).orEmpty()
    val time = parts.getOrNull(1).orEmpty().take(5)
    return listOf(date, time).filter { it.isNotBlank() }.joinToString(" ").ifBlank { value.take(16) }
}

/** Strip non-ASCII (incl. newlines), neutralize quotes/dashes, swap the rupee sign for "Rs". */
private fun String.tsplSafe(): String {
    return replace('₹', 'R')
        .replace("—", "-")
        .replace("–", "-")
        .replace("\"", "'")
        .replace("\n", " ")
        .replace("\r", " ")
        .replace(Regex("[^\\x20-\\x7E]"), "")
}
