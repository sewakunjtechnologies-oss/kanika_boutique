import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => {
  class FakeKnownError extends Error {
    code: string;
    constructor(code: string) {
      super('unique');
      this.code = code;
    }
  }
  return {
    FakeKnownError,
    handleInbound: vi.fn(async (..._args: unknown[]) => {}),
    messageCreate: vi.fn(async (..._args: unknown[]): Promise<{ id: string }> => ({ id: 'm1' })),
  };
});
const FakeKnownError = h.FakeKnownError;

vi.mock('@kda/db', () => ({
  prisma: {
    customer: { upsert: vi.fn(async () => ({ id: 'cust1', createdAt: new Date() })) },
    conversation: {
      findFirst: vi.fn(async () => ({ id: 'conv1' })),
      create: vi.fn(async () => ({ id: 'conv1' })),
      update: vi.fn(async () => ({})),
    },
    message: { create: (...args: unknown[]) => h.messageCreate(...args) },
  },
  MessageDirection: { INBOUND: 'INBOUND', OUTBOUND_OWNER_MANUAL: 'OUTBOUND_OWNER_MANUAL' },
  MessageType: {
    TEXT: 'TEXT',
    IMAGE: 'IMAGE',
    AUDIO: 'AUDIO',
    VIDEO: 'VIDEO',
    DOCUMENT: 'DOCUMENT',
    INTERACTIVE_BUTTON: 'INTERACTIVE_BUTTON',
    UNKNOWN: 'UNKNOWN',
  },
  Prisma: { PrismaClientKnownRequestError: h.FakeKnownError },
}));

vi.mock('../chatbot/orchestrator', () => ({ handleInboundMessage: (...args: unknown[]) => h.handleInbound(...args) }));
vi.mock('../realtime/io', () => ({ emitToDashboard: vi.fn() }));
vi.mock('../queues/connection', () => ({
  redisConnection: { set: vi.fn(async () => 'OK'), get: vi.fn(async () => 'token'), del: vi.fn(async () => 1) },
}));

import { processWebhookEvent } from './messageProcessor';

function messagesPayload(msg: unknown) {
  return { entry: [{ changes: [{ field: 'messages', value: { messages: [msg], contacts: [] } }] }] };
}
function echoesPayload(echo: unknown) {
  return { entry: [{ changes: [{ field: 'smb_message_echoes', value: { message_echoes: [echo] } }] }] };
}

beforeEach(() => {
  h.handleInbound.mockClear();
  h.messageCreate.mockReset().mockResolvedValue({ id: 'm1' });
});
afterEach(() => vi.clearAllMocks());

describe('webhook routing safety', () => {
  test('normal customer message reaches the orchestrator', async () => {
    await processWebhookEvent(
      messagesPayload({ from: '919999999999', id: 'wamid.1', timestamp: '1', type: 'text', text: { body: 'hi' } }) as never,
    );
    expect(h.handleInbound).toHaveBeenCalledTimes(1);
  });

  test('14: duplicate webhook (same message id) is ignored — orchestrator not called', async () => {
    h.messageCreate.mockRejectedValueOnce(new FakeKnownError('P2002'));
    await processWebhookEvent(
      messagesPayload({ from: '919999999999', id: 'wamid.dup', timestamp: '1', type: 'text', text: { body: 'hi' } }) as never,
    );
    expect(h.handleInbound).not.toHaveBeenCalled();
  });

  test('15: smb_message_echoes (owner reply) never starts matching or a reply', async () => {
    await processWebhookEvent(
      echoesPayload({ to: '919999999999', id: 'wamid.echo', timestamp: '1', type: 'text', text: { body: 'owner reply' } }) as never,
    );
    expect(h.handleInbound).not.toHaveBeenCalled();
  });
});
