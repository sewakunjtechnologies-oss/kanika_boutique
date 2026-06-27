package com.kanikadesigns.printbridge.printer

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.net.Socket

class TcpPrinterClient(
    private val connectTimeoutMs: Int = 5_000,
) {
    suspend fun testConnection(host: String, port: Int): Boolean = withContext(Dispatchers.IO) {
        runCatching {
            Socket().use { socket ->
                socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
                socket.isConnected
            }
        }.getOrDefault(false)
    }

    suspend fun sendRawCommand(host: String, port: Int, bytes: ByteArray) = withContext(Dispatchers.IO) {
        Socket().use { socket ->
            socket.tcpNoDelay = true
            socket.soTimeout = connectTimeoutMs
            socket.connect(InetSocketAddress(host, port), connectTimeoutMs)
<<<<<<< HEAD
            socket.getOutputStream().use { out ->
                out.write(bytes)
                out.flush()
=======
            socket.getOutputStream().use { output ->
                output.write(bytes)
                output.flush()
>>>>>>> ffbb103 (again subscribing)
            }
        }
    }
}
