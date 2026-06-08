/* eslint-disable no-console */
/**
 * Local end-to-end test for the webhook pipeline.
 *
 * Usage:
 *   npm run sample -w @kda/backend -- <scenario> [customerNumber]
 *
 * Scenarios:
 *   hi           — inbound customer text "hi"
 *   available    — inbound customer text "available?"
 *   text         — inbound customer text "kya yeh available hai"
 *   image        — inbound customer image (no real media id)
 *   duplicate    — same text message delivered twice in one webhook body
 *   button       — inbound interactive button reply
 *   echo         — owner manual reply (smb_message_echoes) → triggers humanTakeover
 *   contact_sync — smb_app_state_sync with one contact
 *   history      — small history dump
 *
 * The script signs the body with META_APP_SECRET from .env so the backend's
 * signature verification passes — no ngrok / Meta account needed.
 */
import { env } from '../src/config/env';
import { signPayload } from '../src/whatsapp/signatureVerification';
import type {
  HistoryValue,
  MessagesValue,
  SmbAppStateSyncValue,
  SmbMessageEchoesValue,
  WebhookPayload,
} from '../src/whatsapp/types';

const SCENARIO = (process.argv[2] ?? 'text') as Scenario;
const CUSTOMER = process.argv[3] ?? '919876543210';
const OWNER = env.META_PHONE_NUMBER_ID || '15555550000';

type Scenario =
  | 'hi'
  | 'available'
  | 'text'
  | 'image'
  | 'duplicate'
  | 'button'
  | 'echo'
  | 'contact_sync'
  | 'history';

function metadata() {
  return {
    display_phone_number: OWNER,
    phone_number_id: OWNER,
  };
}

function envelope(field: string, value: object): WebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: env.META_WABA_ID || 'WABA_TEST',
        changes: [{ field, value: value as never }],
      },
    ],
  };
}

function build(): WebhookPayload {
  const ts = Math.floor(Date.now() / 1000).toString();
  const uniq = Date.now().toString(36);

  switch (SCENARIO) {
    case 'hi':
    case 'available':
    case 'text': {
      const body =
        SCENARIO === 'hi'
          ? 'hi'
          : SCENARIO === 'available'
            ? 'available?'
            : 'kya yeh available hai';
      const v: MessagesValue = {
        messaging_product: 'whatsapp',
        metadata: metadata(),
        contacts: [{ wa_id: CUSTOMER, profile: { name: 'Test Customer' } }],
        messages: [
          {
            id: `wamid.TEST_TEXT_${uniq}`,
            from: CUSTOMER,
            timestamp: ts,
            type: 'text',
            text: { body },
          },
        ],
      };
      return envelope('messages', v);
    }
    case 'duplicate': {
      const id = `wamid.TEST_DUPLICATE_${uniq}`;
      const v: MessagesValue = {
        messaging_product: 'whatsapp',
        metadata: metadata(),
        contacts: [{ wa_id: CUSTOMER, profile: { name: 'Test Customer' } }],
        messages: [
          {
            id,
            from: CUSTOMER,
            timestamp: ts,
            type: 'text',
            text: { body: 'hi' },
          },
          {
            id,
            from: CUSTOMER,
            timestamp: ts,
            type: 'text',
            text: { body: 'hi' },
          },
        ],
      };
      return envelope('messages', v);
    }
    case 'image': {
      const v: MessagesValue = {
        messaging_product: 'whatsapp',
        metadata: metadata(),
        contacts: [{ wa_id: CUSTOMER, profile: { name: 'Test Customer' } }],
        messages: [
          {
            id: `wamid.TEST_IMAGE_${uniq}`,
            from: CUSTOMER,
            timestamp: ts,
            type: 'image',
            image: {
              id: 'FAKE_MEDIA_ID',
              mime_type: 'image/jpeg',
              caption: 'is this available?',
            },
          },
        ],
      };
      return envelope('messages', v);
    }
    case 'button': {
      const v: MessagesValue = {
        messaging_product: 'whatsapp',
        metadata: metadata(),
        contacts: [{ wa_id: CUSTOMER, profile: { name: 'Test Customer' } }],
        messages: [
          {
            id: `wamid.TEST_BTN_${uniq}`,
            from: CUSTOMER,
            timestamp: ts,
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'size_M', title: 'M' },
            },
          },
        ],
      };
      return envelope('messages', v);
    }
    case 'echo': {
      const v: SmbMessageEchoesValue = {
        messaging_product: 'whatsapp',
        metadata: metadata(),
        message_echoes: [
          {
            id: `wamid.TEST_ECHO_${uniq}`,
            from: OWNER,
            to: CUSTOMER,
            timestamp: ts,
            type: 'text',
            text: { body: 'haan haan available hai, kal bhejti hun' },
          },
        ],
      };
      return envelope('smb_message_echoes', v);
    }
    case 'contact_sync': {
      const v: SmbAppStateSyncValue = {
        messaging_product: 'whatsapp',
        metadata: metadata(),
        state_sync: [
          {
            type: 'contact',
            action: 'add',
            contact: { phone_number: CUSTOMER, full_name: 'Test Customer From Sync' },
          },
        ],
      };
      return envelope('smb_app_state_sync', v);
    }
    case 'history': {
      const v: HistoryValue = {
        messaging_product: 'whatsapp',
        metadata: metadata(),
        history: [
          {
            threads: [
              {
                id: CUSTOMER,
                contact: { name: 'History Customer' },
                messages: [
                  {
                    id: `wamid.TEST_HIST_A_${uniq}`,
                    from: CUSTOMER,
                    timestamp: (Math.floor(Date.now() / 1000) - 86400).toString(),
                    type: 'text',
                    text: { body: 'hi' },
                  },
                  {
                    id: `wamid.TEST_HIST_B_${uniq}`,
                    from: OWNER,
                    to: CUSTOMER,
                    timestamp: (Math.floor(Date.now() / 1000) - 86000).toString(),
                    type: 'text',
                    text: { body: 'hello!' },
                    from_me: true,
                  } as never,
                ],
              },
            ],
          },
        ],
      };
      return envelope('history', v);
    }
    default:
      throw new Error(`unknown scenario: ${SCENARIO}`);
  }
}

async function main(): Promise<void> {
  if (!env.META_APP_SECRET) {
    console.error('META_APP_SECRET is empty in .env. Set any string there for local testing.');
    process.exit(1);
  }

  const payload = build();
  const body = JSON.stringify(payload);
  const sig = signPayload(body, env.META_APP_SECRET);
  const url = `${env.PUBLIC_BACKEND_URL}/webhook/whatsapp`;

  console.log(`→ POST ${url}`);
  console.log(`  scenario: ${SCENARIO}  customer: ${CUSTOMER}  bytes: ${body.length}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': sig,
    },
    body,
  });
  console.log(`← ${res.status} ${res.statusText}`);
  if (!res.ok) {
    console.log(await res.text());
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
