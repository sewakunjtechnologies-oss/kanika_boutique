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

    /**
     * Regression for ORD-2026-0007: a Free-Size order with a long customer name
     * and a long Panipat delivery address, rendered at the enlarged fonts, must
     * still produce valid TSPL with every coordinate inside the 4x3 canvas — and
     * the long address must WRAP across lines rather than being truncated away.
     */
    @Test
    fun orderLabelFreeSizeLongNameLongAddressStaysInBounds() {
        val payload = JsonObject().apply {
            addProperty("orderId", "ORD-2026-0007")
            addProperty("customerName", "Madhavendra Pratap Singh Chauhan")
            addProperty("phoneMasked", "98XXXXXX21")
            addProperty("createdAt", "2026-07-11T10:20:00.000Z")
            addProperty("addressLine1", "House No 145 Near Devi Mandir Model Town Sector 12")
            addProperty("addressLine2", "Huda Colony Assandh Road Behind Bus Stand")
            addProperty("city", "Panipat")
            addProperty("state", "Haryana")
            addProperty("pincode", "132103")
            addProperty("subtotal", 1499)
            addProperty("deliveryCharge", 0)
            addProperty("discount", 0)
            addProperty("grandTotal", 1499)
            addProperty("paymentStatus", "PAID")
            add("items", JsonArray().apply {
                add(item("Unstitched Cotton Suit Piece With A Very Long Product Name", "UN-201", "Free Size", 1, 1499))
            })
            addProperty("barcodeValue", "ORD-2026-0007")
        }

        val commands = generator.generateOnlineOrderLabel(payload, BridgeSettings(labelSize = LabelSize.FOUR_BY_THREE))

        assertOrderLabelWellFormedAndInBounds(commands, LabelSize.FOUR_BY_THREE)

        // The long address wraps: exactly one prefixed "Addr:" line, and a later
        // word of the address survives on a continuation line (not truncated off).
        assertEquals(1, commands.lineSequence().count { it.startsWith("TEXT") && it.contains("\"Addr: ") })
        assertTrue(commands.contains("Assandh"))
        assertTrue(commands.contains("Huda"))

        // Free Size renders (never the numeric backing size), plus one barcode/print.
        assertTrue(commands.contains("Free"))
        assertEquals(1, commands.lineSequence().count { it.startsWith("BARCODE ") })
        assertEquals(1, commands.lineSequence().count { it.startsWith("PRINT ") })
    }

    @Test
    fun orderLabelStaysInBoundsWithMaximalContent() {
        val payload = onlineOrderPayload()
        payload.addProperty("customerName", "Madhavendra Pratap Singh Chauhan Of Panipat District")
        payload.addProperty("addressLine1", "House No 145 Near Devi Mandir Model Town Sector 12 Huda Colony")
        payload.addProperty("addressLine2", "Assandh Road Behind Old Bus Stand Second Floor Back Gali 7")
        payload.addProperty("paymentStatus", "PARTIALLY PAID")
        payload.add("items", JsonArray().apply {
            add(item("Unstitched Cotton Suit One", "UN-201", "Free Size", 1, 1499))
            add(item("Unstitched Cotton Suit Two", "UN-202", "Free Size", 2, 1499))
            add(item("Unstitched Cotton Suit Three", "UN-203", "Free Size", 3, 1499))
            add(item("Unstitched Cotton Suit Four", "UN-204", "Free Size", 4, 1499))
        })
        listOf(LabelSize.FOUR_BY_THREE, LabelSize.FOUR_BY_FOUR).forEach { size ->
            val commands = generator.generateOnlineOrderLabel(payload, BridgeSettings(labelSize = size))
            assertOrderLabelWellFormedAndInBounds(commands, size)
        }
    }

    @Test
    fun labelSizesEmitCorrectTsplSize() {
        val fourByThree = generator.generateTestLabel(JsonObject(), BridgeSettings(labelSize = LabelSize.FOUR_BY_THREE))
        val fourByFour = generator.generateTestLabel(JsonObject(), BridgeSettings(labelSize = LabelSize.FOUR_BY_FOUR))

        assertTrue(fourByThree.contains("SIZE 101.6 mm,76.2 mm"))
        assertTrue(fourByFour.contains("SIZE 101.6 mm,101.6 mm"))
    }

    @Test
    fun testLabelUsesReadableFontsAndOnePrintCommand() {
        val commands = generator.generateTestLabel(
            testLabelPayload(),
            BridgeSettings(labelSize = LabelSize.FOUR_BY_THREE, direction = 1),
        )

        assertTrue(commands.contains("SIZE 101.6 mm,76.2 mm"))
        assertTrue(commands.contains("GAP 3 mm,0 mm"))
        assertTrue(commands.contains("DIRECTION 1"))
        assertTrue(commands.contains("TEXT 35,30,\"4\",0,1,1,\"KANIKA PRINT TEST\""))
        assertTrue(commands.contains("TEXT 35,115,\"3\",0,1,1,\"Printer: 4BARCODE 4B-2054TG\""))
        assertTrue(commands.contains("TEXT 35,160,\"3\",0,1,1,\"Label: 4x3\""))
        assertTrue(commands.contains("TEXT 300,160,\"3\",0,1,1,\"Direction: 1\""))
        assertTrue(commands.contains("TEXT 35,220,\"4\",0,1,1,\"Job: KD-TEST-1001\""))
        assertTrue(commands.contains("TEXT 35,285,\"3\",0,1,1,\"If sideways, switch Direction 0/1.\""))

        assertTrue(commands.lineSequence().none { it.startsWith("TEXT") && it.contains(",\"1\",") })
        assertTrue(commands.lineSequence().none { it.startsWith("TEXT") && it.contains(",\"2\",") })
        assertEquals(1, commands.lineSequence().count { it == "PRINT 1" })
        assertEquals(1, commands.lineSequence().count { it.startsWith("PRINT ") })
    }

    @Test
    fun testLabelBarcodeUsesSeparateReadableText() {
        val commands = generator.generateTestLabel(testLabelPayload(), BridgeSettings())

        assertEquals(1, commands.lineSequence().count { it.startsWith("BARCODE ") })
        assertTrue(commands.contains("BARCODE 180,390,\"128\",95,0,0,2,2,\"KD-TEST-1001\""))
        assertTrue(commands.contains("TEXT 265,505,\"3\",0,1,1,\"KD-TEST-1001\""))
    }

    @Test
    fun testLabelEscapesTextFields() {
        val payload = JsonObject().apply {
            addProperty("printerName", "4\"BARCODE\n4B-2054TG")
            addProperty("orderId", "KD-TEST-1001")
            addProperty("barcodeValue", "KD-\"TEST\"\n1001")
        }
        val commands = generator.generateTestLabel(payload, BridgeSettings())

        assertTrue(commands.contains("Printer: 4'BARCODE 4B-2054TG"))
        assertTrue(commands.contains("Job: KD-'TEST' 1001"))
        assertTrue(commands.contains("BARCODE 180,390,\"128\",95,0,0,2,2,\"KD-'TEST' 1001\""))
        assertFalse(commands.lineSequence().any { it.startsWith("TEXT") && it.substringAfterLast(',').contains('\n') })
    }

    @Test
    fun testLabelCoordinatesFitFourByThreeCanvas() {
        val commands = generator.generateTestLabel(testLabelPayload(), BridgeSettings(labelSize = LabelSize.FOUR_BY_THREE))
        val canvasWidth = LabelSize.FOUR_BY_THREE.widthDots
        val canvasHeight = LabelSize.FOUR_BY_THREE.heightDots
        val textRegex = Regex("""^TEXT (\d+),(\d+),"(\d)",0,1,1,"(.*)"$""")
        val barRegex = Regex("""^BAR (\d+),(\d+),(\d+),(\d+)$""")
        val barcodeRegex = Regex("""^BARCODE (\d+),(\d+),"128",(\d+),0,0,2,2,".*"$""")

        commands.lineSequence().forEach { line ->
            textRegex.matchEntire(line)?.let { match ->
                val x = match.groupValues[1].toInt()
                val y = match.groupValues[2].toInt()
                val font = match.groupValues[3]
                val value = match.groupValues[4]
                val charWidth = if (font == "4") 24 else 16
                val lineHeight = if (font == "4") 40 else 32
                assertTrue(line, x + value.length * charWidth <= canvasWidth)
                assertTrue(line, y + lineHeight <= canvasHeight)
            }

            barRegex.matchEntire(line)?.let { match ->
                val x = match.groupValues[1].toInt()
                val y = match.groupValues[2].toInt()
                val width = match.groupValues[3].toInt()
                val height = match.groupValues[4].toInt()
                assertTrue(line, x + width <= canvasWidth)
                assertTrue(line, y + height <= canvasHeight)
            }

            barcodeRegex.matchEntire(line)?.let { match ->
                val x = match.groupValues[1].toInt()
                val y = match.groupValues[2].toInt()
                val height = match.groupValues[3].toInt()
                assertTrue(line, x in 0..canvasWidth)
                assertTrue(line, y + height <= canvasHeight)
            }
        }
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

    /**
     * Asserts the generated label is well-formed TSPL and every drawing command
     * sits inside the [size] canvas: no malformed commands, no negative or
     * off-canvas coordinates, no font "1". Char widths / line heights mirror the
     * Font enum used by the renderer (font "4"=24/44, "3"=16/32, "2"=12/26).
     */
    private fun assertOrderLabelWellFormedAndInBounds(commands: String, size: LabelSize) {
        val w = size.widthDots
        val h = size.heightDots
        val textRegex = Regex("""^TEXT (\d+),(\d+),"(\d)",0,1,1,"(.*)"$""")
        val barRegex = Regex("""^BAR (\d+),(\d+),(\d+),(\d+)$""")
        val barcodeRegex = Regex("""^BARCODE (\d+),(\d+),"128",(\d+),\d,0,2,2,".*"$""")
        var sawText = false
        commands.lineSequence().forEach { line ->
            when {
                line.startsWith("TEXT") -> {
                    val m = textRegex.matchEntire(line)
                    assertTrue("malformed TEXT: $line", m != null)
                    val x = m!!.groupValues[1].toInt()
                    val y = m.groupValues[2].toInt()
                    val font = m.groupValues[3]
                    val charWidth = when (font) { "4" -> 24; "3" -> 16; else -> 12 }
                    val lineHeight = when (font) { "4" -> 44; "3" -> 32; else -> 26 }
                    assertFalse("font 1 used: $line", font == "1")
                    assertTrue("x<0: $line", x >= 0)
                    assertTrue("y<0: $line", y >= 0)
                    assertTrue("x overflow: $line", x + m.groupValues[4].length * charWidth <= w)
                    assertTrue("y overflow: $line", y + lineHeight <= h)
                    sawText = true
                }
                line.startsWith("BARCODE") -> {
                    val m = barcodeRegex.matchEntire(line)
                    assertTrue("malformed BARCODE: $line", m != null)
                    val x = m!!.groupValues[1].toInt()
                    val y = m.groupValues[2].toInt()
                    val barcodeHeight = m.groupValues[3].toInt()
                    assertTrue("barcode x oob: $line", x in 0..w)
                    assertTrue("barcode y overflow: $line", y + barcodeHeight <= h)
                }
                line.startsWith("BAR ") -> {
                    val m = barRegex.matchEntire(line)
                    assertTrue("malformed BAR: $line", m != null)
                    assertTrue("bar x overflow: $line", m!!.groupValues[1].toInt() + m.groupValues[3].toInt() <= w)
                    assertTrue("bar y overflow: $line", m.groupValues[2].toInt() + m.groupValues[4].toInt() <= h)
                }
            }
        }
        assertTrue("no text emitted", sawText)
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

    private fun testLabelPayload() = JsonObject().apply {
        addProperty("printerName", "4BARCODE 4B-2054TG")
        addProperty("orderId", "KD-TEST-1001")
        addProperty("barcodeValue", "KD-TEST-1001")
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
