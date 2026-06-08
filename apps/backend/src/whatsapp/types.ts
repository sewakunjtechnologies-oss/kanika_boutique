// Meta WhatsApp Cloud API webhook payloads (Graph v23.0 + Coexistence extras).
// Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
// Coexistence fields (smb_message_echoes, smb_app_state_sync, history) come from
// https://developers.facebook.com/docs/whatsapp/embedded-signup/coexistence

export type WebhookField =
  | 'messages'
  | 'message_template_status_update'
  | 'smb_message_echoes'
  | 'smb_app_state_sync'
  | 'history'
  | string;

export interface WebhookPayload {
  object: 'whatsapp_business_account' | string;
  entry: WebhookEntry[];
}

export interface WebhookEntry {
  id: string;
  changes: WebhookChange[];
}

export interface WebhookChange {
  field: WebhookField;
  value: WebhookValue;
}

// Union of all known value shapes. Use `field` on the parent change to discriminate.
export type WebhookValue =
  | MessagesValue
  | SmbMessageEchoesValue
  | SmbAppStateSyncValue
  | HistoryValue
  | UnknownValue;

export interface UnknownValue {
  [key: string]: unknown;
}

// =============================================================================
// Common sub-shapes
// =============================================================================

export interface ValueMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

export interface ContactProfile {
  name: string;
}

export interface Contact {
  wa_id: string;
  profile?: ContactProfile;
  user_id?: string;
}

// =============================================================================
// Inbound message types (field: "messages")
// =============================================================================

export type IncomingMessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'location'
  | 'sticker'
  | 'contacts'
  | 'interactive'
  | 'button'
  | 'reaction'
  | 'order'
  | 'system'
  | 'unsupported';

export interface MessagesValue {
  messaging_product: 'whatsapp';
  metadata: ValueMetadata;
  contacts?: Contact[];
  messages?: IncomingMessage[];
  statuses?: MessageStatus[];
  errors?: WhatsAppError[];
}

export interface IncomingMessageBase {
  id: string; // unique whatsapp message id — used for dedup
  from: string; // wa_id of sender
  timestamp: string; // unix seconds, as string
  type: IncomingMessageType;
  context?: { from?: string; id?: string }; // when replying to another message
  errors?: WhatsAppError[];
}

export interface TextMessage extends IncomingMessageBase {
  type: 'text';
  text: { body: string };
}

export interface MediaPayload {
  id: string; // media id — fetch with GET /<media-id>
  mime_type: string;
  sha256?: string;
  caption?: string;
  filename?: string;
}

export interface ImageMessage extends IncomingMessageBase {
  type: 'image';
  image: MediaPayload;
}

export interface AudioMessage extends IncomingMessageBase {
  type: 'audio';
  audio: MediaPayload & { voice?: boolean };
}

export interface VideoMessage extends IncomingMessageBase {
  type: 'video';
  video: MediaPayload;
}

export interface DocumentMessage extends IncomingMessageBase {
  type: 'document';
  document: MediaPayload;
}

export interface StickerMessage extends IncomingMessageBase {
  type: 'sticker';
  sticker: MediaPayload & { animated?: boolean };
}

export interface LocationMessage extends IncomingMessageBase {
  type: 'location';
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
}

export interface InteractiveButtonReply {
  type: 'button_reply';
  button_reply: { id: string; title: string };
}

export interface InteractiveListReply {
  type: 'list_reply';
  list_reply: { id: string; title: string; description?: string };
}

export interface InteractiveMessage extends IncomingMessageBase {
  type: 'interactive';
  interactive: InteractiveButtonReply | InteractiveListReply;
}

export interface ButtonMessage extends IncomingMessageBase {
  type: 'button';
  button: { payload: string; text: string };
}

export interface ReactionMessage extends IncomingMessageBase {
  type: 'reaction';
  reaction: { message_id: string; emoji: string };
}

export interface UnsupportedMessage extends IncomingMessageBase {
  type: 'unsupported' | 'order' | 'system' | 'contacts';
}

export type IncomingMessage =
  | TextMessage
  | ImageMessage
  | AudioMessage
  | VideoMessage
  | DocumentMessage
  | StickerMessage
  | LocationMessage
  | InteractiveMessage
  | ButtonMessage
  | ReactionMessage
  | UnsupportedMessage;

// =============================================================================
// Delivery / read statuses (we log + ignore in v1)
// =============================================================================

export interface MessageStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
  timestamp: string;
  recipient_id: string;
  conversation?: { id: string; origin?: { type: string } };
  pricing?: { billable: boolean; pricing_model: string; category: string };
  errors?: WhatsAppError[];
}

export interface WhatsAppError {
  code: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
}

// =============================================================================
// Coexistence: owner's manual replies echoed back to us (field: "smb_message_echoes")
// Same structure as MessagesValue, but `messages[]` represents outbound owner messages.
// =============================================================================

export interface SmbMessageEchoesValue {
  messaging_product: 'whatsapp';
  metadata: ValueMetadata;
  message_echoes?: SmbEchoMessage[];
}

// `to` is the customer; `from` is the owner's number.
// We intersect with IncomingMessage so the discriminated `type` field narrows correctly.
export type SmbEchoMessage = IncomingMessage & { to: string };

// =============================================================================
// Coexistence: contact / app state sync (field: "smb_app_state_sync")
// Owner's WhatsApp Business app pushes its contact + group list to us.
// =============================================================================

export interface SmbAppStateSyncValue {
  messaging_product: 'whatsapp';
  metadata: ValueMetadata;
  state_sync?: {
    type: 'contact' | 'group' | string;
    contact?: { phone_number: string; full_name?: string; first_name?: string };
    action?: 'add' | 'remove' | 'update' | string;
  }[];
}

// =============================================================================
// Coexistence: one-time history dump (field: "history")
// Sent once when Coexistence is first enabled.
// =============================================================================

export interface HistoryValue {
  messaging_product: 'whatsapp';
  metadata: ValueMetadata;
  history?: HistoryThread[];
}

export interface HistoryThread {
  threads?: {
    id: string; // wa_id of the other party
    contact?: ContactProfile;
    messages?: HistoryMessage[];
  }[];
  // Older payload shape — some accounts get a flat messages array per thread.
  contacts?: Contact[];
  messages?: HistoryMessage[];
}

// History messages may be inbound OR outbound; `from_me` distinguishes.
export type HistoryMessage = IncomingMessage & { from_me?: boolean; to?: string };

// =============================================================================
// Type guards
// =============================================================================

export function isMessagesValue(field: WebhookField, _v: WebhookValue): _v is MessagesValue {
  return field === 'messages';
}

export function isSmbMessageEchoesValue(
  field: WebhookField,
  _v: WebhookValue,
): _v is SmbMessageEchoesValue {
  return field === 'smb_message_echoes';
}

export function isSmbAppStateSyncValue(
  field: WebhookField,
  _v: WebhookValue,
): _v is SmbAppStateSyncValue {
  return field === 'smb_app_state_sync';
}

export function isHistoryValue(field: WebhookField, _v: WebhookValue): _v is HistoryValue {
  return field === 'history';
}
