import { bridgeEnv } from './config';
import { getNextJob, heartbeat, markDryRunCompleted, markFailed, markPrinted, markPrinting } from './backendClient';
import { printRenderedHtml, renderJobHtmlFile } from './printer';

let busy = false;

export async function processNextJob(): Promise<'idle' | 'completed' | 'failed'> {
  if (busy) return 'idle';
  busy = true;
  try {
    const job = await getNextJob();
    if (!job) return 'idle';

    try {
      const rendered = await renderJobHtmlFile(job);
      await markPrinting(job.id);
      await printRenderedHtml(rendered);
      if (bridgeEnv.PRINT_DRY_RUN) {
        await markDryRunCompleted(job.id);
      } else {
        await markPrinted(job.id);
      }
      // eslint-disable-next-line no-console
      console.log(
        bridgeEnv.PRINT_DRY_RUN
          ? `Dry-run completed for job ${job.id}; no physical print was sent.`
          : `Printed job ${job.id} (${bridgeEnv.PRINTER_NAME})`,
      );
      return 'completed';
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown print error';
      await markFailed(job.id, message).catch(() => undefined);
      // eslint-disable-next-line no-console
      console.error(`Print job ${job.id} failed: ${message}`);
      return 'failed';
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Bridge poll failed:', err instanceof Error ? err.message : err);
    return 'failed';
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
    `Kanika print bridge started. device=${bridgeEnv.DEVICE_ID} printer="${bridgeEnv.PRINTER_NAME}" labelSize=${bridgeEnv.LABEL_SIZE} batchSize=${bridgeEnv.PRINT_JOB_BATCH_SIZE} dryRun=${bridgeEnv.PRINT_DRY_RUN}`,
  );
  await sendHeartbeat();
  setInterval(() => void sendHeartbeat(), bridgeEnv.HEARTBEAT_INTERVAL_MS);
  setInterval(() => void processNextJob(), bridgeEnv.POLL_INTERVAL_MS);
}

if (require.main === module) {
  void startBridge();
}
