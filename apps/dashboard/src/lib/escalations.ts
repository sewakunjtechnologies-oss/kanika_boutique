import { api } from './api';

export type EscalationReason = 'NO_MATCH' | 'CUSTOMER_REJECTED' | 'MATCH_TIMEOUT';

export interface EscalationMetadata {
  reason: EscalationReason;
  customerMasked: string;
  imageUrl: string | null;
  conversationLink: string;
}

export interface EscalationRow {
  id: string;
  title: string;
  body: string | null;
  entityId: string | null;
  createdAt: string;
  metadata: EscalationMetadata;
}

export interface EscalationsResponse {
  items: EscalationRow[];
  unreadCount: number;
}

/** Live socket payload for 'escalation_created'. */
export interface EscalationEvent {
  conversationId: string;
  customerMasked: string;
  reason: EscalationReason;
  imageUrl: string | null;
  conversationLink: string;
  at: string;
}

export async function fetchEscalations(): Promise<EscalationsResponse> {
  return api.get<EscalationsResponse>('/api/notifications/escalations');
}

export async function markEscalationHandled(id: string): Promise<void> {
  await api.post(`/api/notifications/${id}/handled`);
}

export function reasonLabel(reason: EscalationReason): string {
  if (reason === 'NO_MATCH') return 'Unmatched photo';
  if (reason === 'CUSTOMER_REJECTED') return 'Customer rejected match';
  return 'Match timed out';
}

/** Local-app path to a conversation (the live link from the backend is absolute). */
export function conversationPath(conversationId: string | null | undefined): string {
  return conversationId ? `/conversations?id=${conversationId}` : '/conversations';
}
