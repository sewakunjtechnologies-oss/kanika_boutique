'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api, apiErrorMessage } from '@/lib/api';

interface PrinterStatus {
  bridgeOnline: boolean;
  heartbeats: Array<{
    deviceId: string;
    printerName?: string;
    labelProfile?: string;
    printJobBatchSize?: number;
    dryRun?: boolean;
    lastHeartbeatAt?: string;
  }>;
  pendingJobs: number;
  failedJobs: number;
  lastSuccessfulPrint: {
    id: string;
    printedAt: string | null;
    claimedBy: string | null;
  } | null;
}

export default function PrinterPage(): React.ReactElement {
  const [status, setStatus] = useState<PrinterStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);

  async function load(): Promise<void> {
    const result = await api.get<PrinterStatus>('/api/printer/status');
    setStatus(result);
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, []);

  async function printTestLabel(): Promise<void> {
    setBusy(true);
    try {
      await api.post('/api/printer/test-label-request');
      toast.success('Test label queued');
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not queue test label'));
    } finally {
      setBusy(false);
    }
  }

  async function cancelPendingTestLabels(): Promise<void> {
    setCancelBusy(true);
    try {
      const result = await api.post<{ ok: boolean; cancelled: number }>('/api/printer/test-labels/cancel-pending');
      toast.success(`Cancelled ${result.cancelled} pending test label${result.cancelled === 1 ? '' : 's'}`);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Could not cancel pending test labels'));
    } finally {
      setCancelBusy(false);
    }
  }

  const heartbeat = status?.heartbeats[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Printer</h1>
          <p className="text-sm text-muted-foreground">Shop laptop bridge and label queue</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={cancelPendingTestLabels} disabled={cancelBusy}>
            {cancelBusy ? 'Cancelling...' : 'Cancel Pending Tests'}
          </Button>
          <Button onClick={printTestLabel} disabled={busy}>
            {busy ? 'Queueing...' : 'Print Test Label'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatusCard title="Bridge" value={status?.bridgeOnline ? 'Online' : 'Offline'} />
        <StatusCard title="Pending jobs" value={String(status?.pendingJobs ?? 0)} />
        <StatusCard title="Failed jobs" value={String(status?.failedJobs ?? 0)} />
        <StatusCard title="Last print" value={formatDate(status?.lastSuccessfulPrint?.printedAt)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Bridge Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <Info label="Device" value={heartbeat?.deviceId ?? '-'} />
          <Info label="Printer" value={heartbeat?.printerName ?? '-'} />
          <Info label="Label profile" value={heartbeat?.labelProfile ?? '-'} />
          <Info label="Batch size" value={heartbeat?.printJobBatchSize ? String(heartbeat.printJobBatchSize) : '-'} />
          <Info label="Dry run" value={heartbeat ? (heartbeat.dryRun ? 'Yes' : 'No') : '-'} />
          <Info label="Last heartbeat" value={formatDate(heartbeat?.lastHeartbeatAt)} />
          <Info label="Last printed by" value={status?.lastSuccessfulPrint?.claimedBy ?? '-'} />
        </CardContent>
      </Card>
    </div>
  );
}

function StatusCard({ title, value }: { title: string; value: string }): React.ReactElement {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-2xl font-semibold">{value}</CardContent>
    </Card>
  );
}

function Info({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-words font-medium">{value}</div>
    </div>
  );
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
