'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Bell, BellRing, Check, ExternalLink, Volume2, VolumeX, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getDashboardSocket } from '@/lib/socket';
import { createPingPlayer, type PingPlayer } from '@/lib/escalation-audio';
import {
  conversationPath,
  fetchEscalations,
  markEscalationHandled,
  reasonLabel,
  type EscalationEvent,
  type EscalationRow,
} from '@/lib/escalations';

// "Needs Attention" — the always-on escalation queue. Persistent badge + list (so a
// missed alert is never lost), plus a live ping + toast while the dashboard is open.
export function NeedsAttention(): React.ReactElement {
  const [items, setItems] = useState<EscalationRow[]>([]);
  const [open, setOpen] = useState(false);
  const [muted, setMutedState] = useState(false);
  const playerRef = useRef<PingPlayer | null>(null);

  if (playerRef.current === null && typeof window !== 'undefined') {
    playerRef.current = createPingPlayer();
  }

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchEscalations();
      setItems(res.items);
    } catch {
      /* badge/list just won't update; never crash the shell */
    }
  }, []);

  // Initial load (badge count visible the moment the owner opens the app).
  useEffect(() => {
    void reload();
  }, [reload]);

  // iOS audio unlock: prime the player on the FIRST user gesture, then remove.
  useEffect(() => {
    const unlock = (): void => playerRef.current?.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);

  // Live escalations: ping (best-effort) + visible toast + refresh the queue.
  useEffect(() => {
    const socket = getDashboardSocket();
    const onEscalation = (evt: EscalationEvent): void => {
      playerRef.current?.ping(); // no-op if muted/blocked — visual still fires
      toast.warning('⚠️ Customer photo needs manual review', {
        description: `${reasonLabel(evt.reason)} · ${evt.customerMasked}`,
      });
      void reload();
    };
    socket.on('escalation_created', onEscalation);
    return () => {
      socket.off('escalation_created', onEscalation);
    };
  }, [reload]);

  // Persistent unread signal in the tab title, even if the live toast was missed.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = items.length > 0 ? `(${items.length}) ${base}` : base;
  }, [items.length]);

  const handleMarkHandled = useCallback(async (id: string): Promise<void> => {
    setItems((prev) => prev.filter((i) => i.id !== id)); // optimistic
    try {
      await markEscalationHandled(id);
    } catch {
      void reload(); // re-sync on failure
    }
  }, [reload]);

  const toggleMute = useCallback((): void => {
    setMutedState((prev) => {
      const next = !prev;
      playerRef.current?.setMuted(next);
      return next;
    });
  }, []);

  const count = items.length;

  return (
    <div className="fixed right-3 top-3 z-50">
      <Button
        type="button"
        variant={count > 0 ? 'default' : 'outline'}
        size="sm"
        className="relative gap-2 shadow-sm"
        onClick={() => setOpen((o) => !o)}
        aria-label="Needs attention"
      >
        {count > 0 ? <BellRing className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
        <span className="hidden sm:inline">Needs attention</span>
        {count > 0 && (
          <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
            {count}
          </span>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(92vw,22rem)] overflow-hidden rounded-lg border bg-white shadow-lg">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-semibold">Needs attention {count > 0 ? `(${count})` : ''}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={toggleMute}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label={muted ? 'Unmute alert sound' : 'Mute alert sound'}
                title={muted ? 'Unmute alert sound' : 'Mute alert sound'}
              >
                {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded p-1 text-muted-foreground hover:bg-muted"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {count === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">All caught up 🎉</p>
            ) : (
              items.map((item) => (
                <div key={item.id} className="flex gap-3 border-b px-3 py-2 last:border-b-0">
                  {item.metadata.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.metadata.imageUrl}
                      alt=""
                      className="h-12 w-12 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                      no img
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{reasonLabel(item.metadata.reason)}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.metadata.customerMasked} · {new Date(item.createdAt).toLocaleString()}
                    </p>
                    <div className="mt-1 flex items-center gap-3">
                      <Link
                        href={conversationPath(item.entityId)}
                        className={cn('inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline')}
                        onClick={() => setOpen(false)}
                      >
                        <ExternalLink className="h-3 w-3" /> Open conversation
                      </Link>
                      <button
                        type="button"
                        onClick={() => void handleMarkHandled(item.id)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:underline"
                      >
                        <Check className="h-3 w-3" /> Mark handled
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
