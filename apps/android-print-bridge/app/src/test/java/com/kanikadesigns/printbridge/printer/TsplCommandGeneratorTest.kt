package com.kanikadesigns.printbridge.printer

import com.google.gson.JsonObject
import com.kanikadesigns.printbridge.data.BridgeSettings
import com.kanikadesigns.printbridge.data.LabelSize
import com.kanikadesigns.printbridge.network.PrintJobDto
import com.kanikadesigns.printbridge.network.PrintJobStatus
import com.kanikadesigns.printbridge.network.PrintJobType
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class TsplCommandGeneratorTest {
    private val generator = TsplCommandGenerator()

    @Test
    fun manualReceiptContainsNoAddressFields() {
        val commands = generator.generateManualReceipt(manualReceiptPayload(), BridgeSettings()).lowercase()

        assertTrue(commands.contains("receipt"))
        assertFalse(commands.contains("address:"))
        assertFalse(commands.contains("pincode"))
        assertFalse(commands.contains("city:"))
        assertFalse(commands.contains("state:"))
    }

    @Test
    fun onlineOrderContainsAddressAndPincode() {
        val commands = generator.generateOnlineOrderLabel(onlineOrderPayload(), BridgeSettings()).lowercase()

        assertTrue(commands.contains("address: h.no. 25"))
        assertTrue(commands.contains("pin: 131001"))
        assertTrue(commands.contains("total: rs.2470"))
        assertTrue(commands.contains("sub:2270 del:200 disc:0"))
    }

    @Test
    fun labelSizesEmitCorrectTsplSize() {
        val fourByThree = generator.generateTestLabel(JsonObject(), BridgeSettings(labelSize = LabelSize.FOUR_BY_THREE))
        val fourByFour = generator.generateTestLabel(JsonObject(), BridgeSettings(labelSize = LabelSize.FOUR_BY_FOUR))

        assertTrue(fourByThree.contains("SIZE 101.6 mm,76.2 mm"))
        assertTrue(fourByFour.contains("SIZE 101.6 mm,101.6 mm"))
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

    private fun manualReceiptPayload() = JsonObject().apply {
        addProperty("templateVersion", "manual-receipt-v1")
        addProperty("receiptId", "MR-2026-0001")
        addProperty("customerName", "Priya Sharma")
        addProperty("phoneMasked", "98XXXXXX21")
        addProperty("paymentMethod", "CASH")
        addProperty("total", 1860)
        add("items", com.google.gson.JsonArray().apply {
            add(JsonObject().apply {
                addProperty("name", "Three-piece Kurti")
                addProperty("sku", "three-piece-kurtis-mq6b1e77")
                addProperty("size", "38")
                addProperty("quantity", 1)
            })
        })
        addProperty("barcodeValue", "MR-2026-0001")
    }

    private fun onlineOrderPayload() = JsonObject().apply {
        addProperty("templateVersion", "online-order-label-v1")
        addProperty("orderId", "KD-1001")
        addProperty("customerName", "Priya Sharma")
        addProperty("phoneMasked", "98XXXXXX21")
        addProperty("addressLine1", "H.No. 25")
        addProperty("addressLine2", "Sector 14")
        addProperty("city", "Sonipat")
        addProperty("state", "Haryana")
        addProperty("pincode", "131001")
        addProperty("productName", "Pure Cotton Suit")
        addProperty("sku", "KD-PCS-101")
        addProperty("size", "40")
        addProperty("quantity", 1)
        addProperty("amount", 2270)
        addProperty("subtotal", 2270)
        addProperty("deliveryCharge", 200)
        addProperty("discount", 0)
        addProperty("grandTotal", 2470)
        addProperty("paymentType", "UPI")
        addProperty("paymentStatus", "PAID")
        addProperty("barcodeValue", "KD-1001")
    }
}
