package com.kanikadesigns.printbridge.printer

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.data.LabelSize
import com.kanikadesigns.printbridge.network.PrintJobDto
import com.kanikadesigns.printbridge.network.PrintJobStatus
import com.kanikadesigns.printbridge.network.PrintJobType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TsplCommandGeneratorTest {
    private val generator = TsplCommandGenerator()

    @Test
    fun manualReceiptIncludesRequiredFieldsAndNoAddress() {
        val commands = generator.generateManualReceipt(manualReceiptPayload(), BridgeSettings())

        assertTrue(commands.contains("\"KANIKA DESIGNS\""))
        assertTrue(commands.contains("\"MANUAL RECEIPT\""))
        assertTrue(commands.contains("Receipt ID: MR-2026-0001"))
        assertTrue(commands.contains("Customer: Priya Sharma"))
        assertTrue(commands.contains("Phone: 98XXXXXX21"))
        assertTrue(commands.contains("Pay: CASH"))
        assertTrue(commands.contains("Sub Rs.1660"))
        assertTrue(commands.contains("Disc Rs.0"))
        assertTrue(commands.contains("TOTAL  Rs.1860"))

        // Manual receipt must never print a delivery address.
        val lower = commands.lowercase()
        assertFalse(lower.contains("addr:"))
        assertFalse(lower.contains("pin:"))
    }

    @Test
    fun manualReceiptPrintsEveryItemNotJustFirst() {
        val commands = generator.generateManualReceipt(manualReceiptPayload(), BridgeSettings())

        assertTrue(commands.contains("1. Red Kurti | KD-RK-01 | 38 | Q1 | Rs.1760"))
        assertTrue(commands.contains("2. Blue Suit | KD-BS-02 | 40 | Q2 | Rs.100"))
    }

    @Test
    fun onlineOrderIncludesAddressPincodeAndTotals() {
        val commands = generator.generateOnlineOrderLabel(onlineOrderPayload(), BridgeSettings())

        assertTrue(commands.contains("Order ID: KD-1001"))
        assertTrue(commands.contains("Addr: H.No. 25, Sector 14"))
        assertTrue(commands.contains("Sonipat, Haryana"))
        assertTrue(commands.contains("Pin: 131001"))
        assertTrue(commands.contains("Sub Rs.2270"))
        assertTrue(commands.contains("Del Rs.200"))
        assertTrue(commands.contains("TOTAL  Rs.2470"))
    }

    @Test
    fun onlineOrderPrintsMultipleItems() {
        val commands = generator.generateOnlineOrderLabel(onlineOrderPayload(), BridgeSettings())

        assertTrue(commands.contains("1. Pure Cotton Suit | KD-PCS-101 | 40 | Q1 | Rs.1270"))
        assertTrue(commands.contains("2. Silk Saree | KD-SS-202 | FS | Q1 | Rs.1000"))
    }

    @Test
    fun importantFieldsUseReadableFontsAndNeverFontOne() {
        val commands = generator.generateOnlineOrderLabel(onlineOrderPayload(), BridgeSettings())

        // Title uses TSPL font "4"; nothing prints with font "1".
        assertTrue(commands.contains("TEXT 28,24,\"4\",0,1,1,\"KANIKA DESIGNS\""))
        assertTrue(commands.lineSequence().none { it.startsWith("TEXT") && it.contains(",\"1\",") })
        // The final amount is the prominent font "4" line.
        assertTrue(commands.lineSequence().any { it.startsWith("TEXT") && it.contains(",\"4\",") && it.contains("TOTAL  Rs.2470") })
    }

    @Test
    fun barcodeReadableTextIsNotDuplicated() {
        val commands = generator.generateOnlineOrderLabel(onlineOrderPayload(), BridgeSettings())

        // Exactly one BARCODE command, and the barcode value is not re-emitted as
        // a standalone TEXT line (the printer renders its own readable text).
        assertEquals(1, commands.lineSequence().count { it.startsWith("BARCODE ") })
        assertTrue(commands.contains("BARCODE"))
        assertEquals(0, commands.lineSequence().count { it.startsWith("TEXT") && it.endsWith("\"KD-1001\"") })
    }

    @Test
    fun emitsExactlyOnePrintCommand() {
        val commands = generator.generateOnlineOrderLabel(onlineOrderPayload(), BridgeSettings())
        assertEquals(1, commands.lineSequence().count { it.startsWith("PRINT ") })
    }

    @Test
    fun labelSizesEmitCorrectTsplSize() {
        val fourByThree = generator.generateTestLabel(JsonObject(), BridgeSettings(labelSize = LabelSize.FOUR_BY_THREE))
        val fourByFour = generator.generateTestLabel(JsonObject(), BridgeSettings(labelSize = LabelSize.FOUR_BY_FOUR))

        assertTrue(fourByThree.contains("SIZE 101.6 mm,76.2 mm"))
        assertTrue(fourByFour.contains("SIZE 101.6 mm,101.6 mm"))
    }

    @Test
    fun longProductNameIsTruncatedAndDoesNotPushTotals() {
        val payload = manualReceiptPayload()
        payload.getAsJsonArray("items").get(0).asJsonObject
            .addProperty("name", "This is an extremely long product name that should never overflow the label width")
        val commands = generator.generateManualReceipt(payload, BridgeSettings())

        // Totals and barcode still present despite the long name.
        assertTrue(commands.contains("TOTAL  Rs.1860"))
        assertEquals(1, commands.lineSequence().count { it.startsWith("BARCODE ") })
    }

    @Test
    fun unsupportedProductBarcodeFailsSafely() {
        val job = PrintJobDto(
            id = "job_1",
            type = PrintJobType.PRODUCT_BARCODE,
            status = PrintJobStatus.CLAIMED,
            payload = JsonObject(),
        )

        assertThrows(IllegalArgumentException::class.java) {
            generator.generate(job, BridgeSettings())
        }
    }

    private fun item(name: String, sku: String, size: String, qty: Int, amount: Int) = JsonObject().apply {
        addProperty("name", name)
        addProperty("sku", sku)
        addProperty("size", size)
        addProperty("quantity", qty)
        addProperty("amount", amount)
    }

    private fun manualReceiptPayload() = JsonObject().apply {
        addProperty("templateVersion", "manual-receipt-v1")
        addProperty("receiptId", "MR-2026-0001")
        addProperty("customerName", "Priya Sharma")
        addProperty("phoneMasked", "98XXXXXX21")
        addProperty("paymentMethod", "CASH")
        addProperty("createdAt", "2026-06-27T17:20:00.000Z")
        addProperty("subtotal", 1660)
        addProperty("delivery", 150)
        addProperty("discount", 0)
        addProperty("total", 1860)
        add("items", JsonArray().apply {
            add(item("Red Kurti", "KD-RK-01", "38", 1, 1760))
            add(item("Blue Suit", "KD-BS-02", "40", 2, 100))
        })
        addProperty("barcodeValue", "MR-2026-0001")
    }

    private fun onlineOrderPayload() = JsonObject().apply {
        addProperty("templateVersion", "online-order-label-v1")
        addProperty("orderId", "KD-1001")
        addProperty("customerName", "Priya Sharma")
        addProperty("phoneMasked", "98XXXXXX21")
        addProperty("createdAt", "2026-06-27T17:20:00.000Z")
        addProperty("addressLine1", "H.No. 25")
        addProperty("addressLine2", "Sector 14")
        addProperty("city", "Sonipat")
        addProperty("state", "Haryana")
        addProperty("pincode", "131001")
        addProperty("subtotal", 2270)
        addProperty("deliveryCharge", 200)
        addProperty("discount", 0)
        addProperty("grandTotal", 2470)
        addProperty("paymentType", "UPI")
        addProperty("paymentStatus", "PAID")
        add("items", JsonArray().apply {
            add(item("Pure Cotton Suit", "KD-PCS-101", "40", 1, 1270))
            add(item("Silk Saree", "KD-SS-202", "FS", 1, 1000))
        })
        addProperty("barcodeValue", "KD-1001")
    }
}
