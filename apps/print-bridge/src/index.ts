import { bridgeEnv } from './config';
import { getNextJob, heartbeat, markFailed, markPrinted, markPrinting } from './backendClient';
import { printPdf, renderJobPdf } from './printer';

let busy = false;

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const job = await getNextJob();
    if (!job) return;

    try {
      const pdfPath = await renderJobPdf(job);
      await markPrinting(job.id);
      await printPdf(pdfPath);
      await markPrinted(job.id);
      // eslint-disable-next-line no-console
      console.log(`Printed job ${job.id} (${bridgeEnv.PRINT_DRY_RUN ? 'dry-run PDF only' : bridgeEnv.PRINTER_NAME})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown print error';
      await markFailed(job.id, message).catch(() => undefined);
      // eslint-disable-next-line no-console
      console.error(`Print job ${job.id} failed: ${message}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Bridge poll failed:', err instanceof Error ? err.message : err);
  } finally {
    busy = false;
  }
}

async function sendHeartbeat(): Promise<void> {
  try {
    await heartbeat();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Heartbeat failed:', err instanceof Error ? err.message : err);
  }
}

export async function startBridge(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    `Kanika print bridge started. device=${bridgeEnv.DEVICE_ID} printer="${bridgeEnv.PRINTER_NAME}" profile=${bridgeEnv.LABEL_PROFILE} dryRun=${bridgeEnv.PRINT_DRY_RUN}`,
  );
  await sendHeartbeat();
  setInterval(() => void sendHeartbeat(), bridgeEnv.HEARTBEAT_INTERVAL_MS);
  setInterval(() => void tick(), bridgeEnv.POLL_INTERVAL_MS);
}

void startBridge();
