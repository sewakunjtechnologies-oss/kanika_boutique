# Kanika Print Bridge Android App

Android phone based local print agent for Kanika Boutique.

The app replaces the shop-laptop bridge for physical printing. It polls the Render backend for `PrintJob` records, generates TSPL RAW commands, and sends them directly to the 4BARCODE 4B-2054TG printer over TCP/Wi-Fi.

## Backend Contract

Reuses the existing backend routes protected by `PRINT_AGENT_TOKEN`:

- `POST /api/print-agent/heartbeat`
- `GET /api/print-agent/jobs/next`
- `POST /api/print-agent/jobs/:id/printing`
- `POST /api/print-agent/jobs/:id/printed`
- `POST /api/print-agent/jobs/:id/failed`
- `POST /api/print-agent/jobs/retry-failed`
- `POST /api/printer/test-label`

The Android app sends:

```http
Authorization: Bearer <PRINT_AGENT_TOKEN>
x-device-id: kanika-shop-android-01
```

Do not put `PRINT_AGENT_TOKEN` in source control. Enter it only in the app settings screen.

## Android Project

- Package: `com.kanikadesigns.printbridge`
- minSdk: 26
- targetSdk: 36
- Language: Kotlin
- UI: Jetpack Compose Material 3
- Networking: OkHttp + Kotlin serialization
- Background runtime: foreground service
- Local secret storage: EncryptedSharedPreferences
- Printer output: TSPL RAW over TCP port 9100

## Phone Settings

Default app settings:

```text
BACKEND_URL=https://kanika-boutique.onrender.com
DEVICE_ID=kanika-shop-android-01
PRINTER_PORT=9100
PRINTER_LANGUAGE=TSPL
LABEL_SIZE=4x3
POLL_INTERVAL_SECONDS=3
DIRECTION=1
```

Fill these on the phone:

- `PRINT_AGENT_TOKEN`
- `PRINTER_IP`

## Build APK

Open `apps/android-print-bridge` in Android Studio and run:

```bash
./gradlew :app:assembleDebug
```

APK path:

```text
apps/android-print-bridge/app/build/outputs/apk/debug/app-debug.apk
```

This machine currently has Android SDK 36 but no `gradle` command/wrapper installed, so the APK build should be run from Android Studio or after adding the Gradle wrapper.

## Install

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

On the phone:

1. Open **Kanika Print Bridge**.
2. Enter backend URL, print token, device ID, printer IP and port.
3. Tap **Save settings**.
4. Tap **Test backend**.
5. Tap **Test printer**.
6. Tap **Print test label**.
7. Tap **Start bridge**.

## Required Android Permissions

- Internet/network state
- Foreground service
- Foreground service data sync
- Notifications
- Boot completed
- Request ignore battery optimizations

## Battery Reliability Checklist

On the shop phone:

1. Keep phone on the same Wi-Fi as the printer.
2. Keep phone plugged in during shop hours.
3. Set battery mode to **Unrestricted** for Kanika Print Bridge.
4. Allow background data.
5. Keep notifications enabled.
6. Do not force-stop the app.
7. If the phone reboots, open the app and confirm the service is running.

The app includes a **Battery settings** button to open Android optimization settings.

## Label Direction Test

The printer feed direction must be verified once physically.

1. Set `DIRECTION=1`.
2. Print a test label.
3. If upside down/reversed, set `DIRECTION=0`.
4. Print test label again.

Do not use browser orientation, PDF rotation, Windows landscape, or HTML-to-PDF for the Android path.

## Supported PrintJob Types

- `OFFLINE_CUSTOMER_SLIP` → manual receipt, no address
- `ORDER_LABEL` → online order label, includes compact address and pincode
- `OFFLINE_RETURN_SLIP` → return slip, no address
- `TEST_LABEL` → TSPL test label

`PRODUCT_BARCODE` currently fails safely until physically verified.

## End-to-End Test Checklist

1. Backend `/health` works from phone network.
2. Backend test passes in app.
3. Printer TCP test passes.
4. Dashboard creates a manual receipt.
5. Dashboard prints manual receipt.
6. Android app claims the `OFFLINE_CUSTOMER_SLIP` job.
7. Printer prints one manual receipt label.
8. Backend marks job `PRINTED`.
9. Dashboard creates/approves an online order print job.
10. Android app claims the `ORDER_LABEL` job.
11. Online label includes address and pincode.
12. Manual receipt does not include address.
13. Printer off condition marks job `FAILED`.
14. Retry failed job requeues one failed job.
15. Wi-Fi disconnect does not crash service.
16. Phone locked for 30 minutes keeps service alive.
17. App removed from recent apps does not stop an already-running foreground service on the tested device.
18. Phone reboot prompts or restarts according to Android restrictions.
19. Backend restart is recovered by polling.
20. Printer reconnect is recovered by retry.

## Known Limitations

- TSPL coordinates need one physical calibration on the exact printer/label roll.
- Android may block automatic boot foreground-service start on some devices; the app posts a prompt instead.
- `PRODUCT_BARCODE` is intentionally unsupported until the barcode-only stock/layout is physically tested.
- Physical success cannot be claimed until a real dashboard-created `PrintJob` prints through the Android phone.
