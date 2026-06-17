import axios from 'axios';
import { bridgeEnv } from './config';

export interface PrintJobDto {
  id: string;
  type: 'ORDER_LABEL' | 'TEST_LABEL' | 'OFFLINE_CUSTOMER_SLIP' | 'PRODUCT_BARCODE';
  status: string;
  payload: unknown;
  attempts: number;
  createdAt: string;
}

const api = axios.create({
  baseURL: bridgeEnv.BACKEND_URL.replace(/\/$/, ''),
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${bridgeEnv.PRINT_AGENT_TOKEN}`,
    'x-device-id': bridgeEnv.DEVICE_ID,
  },
});

export async function heartbeat(): Promise<void> {
  await api.post('/api/print-agent/heartbeat', {
    deviceId: bridgeEnv.DEVICE_ID,
    printerName: bridgeEnv.PRINTER_NAME,
    labelProfile: bridgeEnv.LABEL_PROFILE,
    printOrientation: bridgeEnv.PRINT_ORIENTATION,
    printRotation: bridgeEnv.PRINT_ROTATION,
    dryRun: bridgeEnv.PRINT_DRY_RUN,
  });
}

export async function getNextJob(): Promise<PrintJobDto | null> {
  const res = await api.get<{ job: PrintJobDto | null }>('/api/print-agent/jobs/next');
  return res.data.job;
}

export async function markPrinting(jobId: string): Promise<void> {
  await api.post(`/api/print-agent/jobs/${jobId}/printing`, { deviceId: bridgeEnv.DEVICE_ID });
}

export async function markPrinted(jobId: string): Promise<void> {
  await api.post(`/api/print-agent/jobs/${jobId}/printed`, { deviceId: bridgeEnv.DEVICE_ID });
}

export async function markFailed(jobId: string, error: string): Promise<void> {
  await api.post(`/api/print-agent/jobs/${jobId}/failed`, {
    deviceId: bridgeEnv.DEVICE_ID,
    error,
  });
}

export async function createBackendTestLabel(): Promise<string> {
  const res = await api.post<{ job: { id: string } }>('/api/printer/test-label', {
    deviceId: bridgeEnv.DEVICE_ID,
  });
  return res.data.job.id;
}

export async function backendReachable(): Promise<boolean> {
  try {
    const res = await axios.get(`${bridgeEnv.BACKEND_URL.replace(/\/$/, '')}/health`, { timeout: 10000 });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}
