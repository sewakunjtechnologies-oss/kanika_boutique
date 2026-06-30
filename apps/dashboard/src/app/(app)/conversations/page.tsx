'use client';

import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, ImageIcon, MessagesSquare, PauseCircle, PlayCircle, Trash2, User } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn, formatDate } from '@/lib/utils';
import { getDashboardSocket } from '@/lib/socket';

interface ConvSummary {
  id: string;
  state: string;
  intent: string;
  humanTakeover: boolean;
  humanTakeoverUntil: string | null;
  supportNudgeSentAt: string | null;
  supportRequestedAt: string | null;
  contextJson?: ConversationContext;
  lastInboundAt: string;
  customer: { id: string; name: string | null; whatsappNumber: string };
  messages: {
    content: string | null;
    messageType: string;
    direction: 'INBOUND' | 'OUTBOUND_BOT' | 'OUTBOUND_OWNER_MANUAL';
    createdAt: string;
  }[];
}

interface ConversationContext {
  botPausedReason?: string;
  pendingRestart?: unknown;
  attentionRequestedAt?: string;
  teamHelpRequestedAt?: string;
  resolvedAt?: string;
}

interface Message {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND_BOT' | 'OUTBOUND_OWNER_MANUAL';
  messageType: string;
  content: string | null;
  mediaUrl: string | null;
  createdAt: string;
}

export default function ConversationsPage(): React.ReactElement {
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedConv, setSelectedConv] = useState<ConvSummary | null>(null);
  const [reply, setReply] = useState('');

  async function loadConvs(): Promise<void> {
    const r = await api.get<{ conversations: ConvSummary[] }>('/api/conversations');
    setConvs(r.conversations);
  }

  async function loadThread(id: string): Promise<void> {
    const r = await api.get<{ conversation: ConvSummary; messages: Message[] }>(
      `/api/conversations/${id}/messages`,
    );
    setMessages(r.messages);
    setSelectedConv(r.conversation);
  }

  useEffect(() => {
    void loadConvs();
    // Deep-link from the "Needs attention" queue: /conversations?id=<conversationId>.
    if (typeof window !== 'undefined') {
      const id = new URLSearchParams(window.location.search).get('id');
      if (id) setSelectedId(id);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadThread(selectedId);
  }, [selectedId]);

  useEffect(() => {
    const socket = getDashboardSocket();
    const onMessage = (data: { conversationId: string }): void => {
      void loadConvs();
      if (selectedId === data.conversationId) void loadThread(selectedId);
    };
    socket.on('message', onMessage);
    socket.on('takeover_changed', onMessage);
    return () => {
      socket.off('message', onMessage);
      socket.off('takeover_changed', onMessage);
    };
  }, [selectedId]);

  async function resumeBot(): Promise<void> {
    if (!selectedId) return;
    try {
      await api.post(`/api/conversations/${selectedId}/resume-bot`);
      toast.success('Bot resumed');
      await loadConvs();
      await loadThread(selectedId);
    } catch {
      toast.error('Resume failed');
    }
  }

  async function pauseBot(): Promise<void> {
    if (!selectedId) return;
    try {
      await api.post(`/api/conversations/${selectedId}/pause-bot`);
      toast.success('Bot paused');
      await loadConvs();
      await loadThread(selectedId);
    } catch {
      toast.error('Pause failed');
    }
  }

  async function startFromLastImage(): Promise<void> {
    if (!selectedId) return;
    try {
      await api.post(`/api/conversations/${selectedId}/start-new-order-from-last-image`);
      toast.success('Started from last image');
      await loadConvs();
      await loadThread(selectedId);
    } catch {
      toast.error('No usable image found in this conversation');
    }
  }

  async function markResolved(): Promise<void> {
    if (!selectedId) return;
    try {
      await api.post(`/api/conversations/${selectedId}/mark-resolved`);
      toast.success('Conversation resolved');
      await loadConvs();
      setSelectedId(null);
      setSelectedConv(null);
      setMessages([]);
    } catch {
      toast.error('Could not mark resolved');
    }
  }

  async function sendManualReply(): Promise<void> {
    if (!selectedId || !reply.trim()) return;
    try {
      await api.post(`/api/conversations/${selectedId}/manual-reply`, { body: reply });
      setReply('');
      await loadThread(selectedId);
    } catch {
      toast.error('Send failed — check Meta credentials');
    }
  }

  async function deleteConversation(id?: string): Promise<void> {
    const targetId = id ?? selectedId;
    if (!targetId) return;
    if (!confirm('Delete this conversation and all its messages? The customer + their orders stay.'))
      return;
    try {
      await api.delete(`/api/conversations/${targetId}`);
      toast.success('Conversation deleted');
      if (selectedId === targetId) {
        setSelectedId(null);
        setSelectedConv(null);
        setMessages([]);
      }
      await loadConvs();
    } catch {
      toast.error('Delete failed');
    }
  }

  async function sendTemplate(): Promise<void> {
    if (!selectedId) return;
    const templateName = window.prompt(
      'Approved template name (use this to re-engage after the 24h window):',
      'hello_world',
    );
    if (!templateName) return;
    const languageCode = window.prompt('Template language code:', 'en') ?? 'en';
    try {
      await api.post(`/api/conversations/${selectedId}/send-template`, {
        templateName,
        languageCode,
      });
      toast.success('Template sent');
      await loadThread(selectedId);
    } catch {
      toast.error('Template send failed — name/language must match an approved Meta template');
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-6rem)] flex-col gap-4 lg:h-[calc(100vh-3rem)] lg:flex-row">
      <Card className="flex max-h-80 flex-col lg:max-h-none lg:w-80 lg:flex-shrink-0">
        <CardContent className="p-0 flex-1 overflow-auto">
          {convs.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No conversations yet.</div>
          ) : (
            <ul className="divide-y">
              {convs.map((c) => (
                <li
                  key={c.id}
                  className={cn(
                    'p-3 cursor-pointer hover:bg-accent',
                    selectedId === c.id && 'bg-accent',
                  )}
                  onClick={() => setSelectedId(c.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="font-medium text-sm">
                      {c.customer.name ?? c.customer.whatsappNumber}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(c.lastInboundAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground truncate mt-0.5">
                    {c.messages[0]?.content ?? `[${c.messages[0]?.messageType ?? ''}]`}
                  </div>
                  <div className="flex gap-1 mt-1">
                    {c.humanTakeover && (
                      <Badge variant="warning" className="text-[10px]">
                        Human
                      </Badge>
                    )}
                    {Boolean(c.contextJson?.pendingRestart) && (
                      <Badge variant="secondary" className="text-[10px]">
                        Resume pending
                      </Badge>
                    )}
                    {c.contextJson?.teamHelpRequestedAt && (
                      <Badge variant="destructive" className="text-[10px]">
                        Team requested
                      </Badge>
                    )}
                    {c.contextJson?.attentionRequestedAt && (
                      <Badge variant="warning" className="text-[10px]">
                        Needs reply
                      </Badge>
                    )}
                    {c.supportNudgeSentAt && (
                      <Badge variant="secondary" className="text-[10px]">
                        Nudge sent
                      </Badge>
                    )}
                    {c.supportRequestedAt && (
                      <Badge variant="destructive" className="text-[10px]">
                        Support
                      </Badge>
                    )}
                    {c.state !== 'IDLE' && c.state !== 'COMPLETED' && c.state !== 'ABANDONED' && (
                      <Badge variant="secondary" className="text-[10px]">
                        Order in progress
                      </Badge>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="flex min-h-[520px] flex-1 flex-col">
        {!selectedConv ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <MessagesSquare size={48} className="mx-auto mb-2 opacity-50" />
              Select a conversation
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 border-b px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <div className="font-medium">
                  {selectedConv.customer.name ?? selectedConv.customer.whatsappNumber}
                </div>
                <div className="text-xs text-muted-foreground">
                  {selectedConv.customer.whatsappNumber} · state {selectedConv.state}
                  {selectedConv.supportRequestedAt ? ' · support requested' : ''}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={sendTemplate}>
                  Send template
                </Button>
                <Button
                  size="sm"
                  variant={selectedConv.humanTakeover ? 'outline' : 'secondary'}
                  onClick={selectedConv.humanTakeover ? resumeBot : pauseBot}
                >
                  {selectedConv.humanTakeover ? (
                    <>
                      <PlayCircle size={14} className="mr-1" /> Resume bot
                    </>
                  ) : (
                    <>
                      <PauseCircle size={14} className="mr-1" /> Pause bot
                    </>
                  )}
                </Button>
                <Button size="sm" variant="outline" onClick={startFromLastImage}>
                  <ImageIcon size={14} className="mr-1" /> Start from image
                </Button>
                <Button size="sm" variant="outline" onClick={markResolved}>
                  <CheckCircle2 size={14} className="mr-1" /> Resolved
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => void deleteConversation()}
                  title="Delete conversation"
                >
                  <Trash2 size={14} className="text-destructive" />
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-3 bg-muted/20">
              {messages.map((m) => (
                <MessageBubble key={m.id} m={m} />
              ))}
            </div>

            <div className="flex flex-col gap-2 border-t p-3 sm:flex-row">
              <Input
                placeholder="Reply manually…"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void sendManualReply()}
              />
              <Button onClick={sendManualReply} disabled={!reply.trim()}>
                Send
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

function MessageBubble({ m }: { m: Message }): React.ReactElement {
  const isInbound = m.direction === 'INBOUND';
  const isBot = m.direction === 'OUTBOUND_BOT';
  const label = isInbound ? null : isBot ? 'Bot' : 'You (via WA app)';
  const colorClass = isInbound
    ? 'bg-card border'
    : isBot
      ? 'bg-blue-100 dark:bg-blue-950'
      : 'bg-emerald-100 dark:bg-emerald-950';

  return (
    <div className={cn('flex', isInbound ? 'justify-start' : 'justify-end')}>
      <div className={cn('max-w-[86%] rounded-2xl px-4 py-2 text-sm sm:max-w-[70%]', colorClass)}>
        {label && (
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5 flex items-center gap-1">
            {isBot ? <Bot size={10} /> : <User size={10} />}
            {label}
          </div>
        )}
        <div className="break-words">{m.content ?? `[${m.messageType.toLowerCase()}]`}</div>
        <div className="text-[10px] text-muted-foreground mt-1">{formatDate(m.createdAt)}</div>
      </div>
    </div>
  );
}
