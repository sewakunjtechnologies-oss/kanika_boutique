/* eslint-disable no-console */
/**
 * Send a real WhatsApp message via Meta Cloud API.
 *
 * Requires `META_ACCESS_TOKEN` + `META_PHONE_NUMBER_ID` set in .env.
 *
 * Usage:
 *   npm run send-test -w @kda/backend -- text     <to> [body...]
 *   npm run send-test -w @kda/backend -- buttons  <to>
 *   npm run send-test -w @kda/backend -- list     <to>
 *   npm run send-test -w @kda/backend -- image    <to> <publicImageUrl> [caption]
 *   npm run send-test -w @kda/backend -- template <to> <templateName> <langCode>
 *   npm run send-test -w @kda/backend -- download <mediaId>
 *
 * The recipient must have messaged the business number within the last 24h
 * (or you must use a template-only flow).
 */
import {
  downloadMedia,
  sendImage,
  sendInteractiveButtons,
  sendInteractiveList,
  sendTemplate,
  sendText,
} from '../src/whatsapp/client';

const [, , kind, ...rest] = process.argv;

async function main(): Promise<void> {
  if (!kind) usage();

  switch (kind) {
    case 'text': {
      const [to, ...body] = rest;
      if (!to) usage();
      const text = body.join(' ') || 'Hello from the boutique bot 👋';
      const r = await sendText(to, text);
      console.log(r);
      return;
    }
    case 'buttons': {
      const [to] = rest;
      if (!to) usage();
      const r = await sendInteractiveButtons(to, 'What size do you want?', [
        { id: 'size_S', title: 'S' },
        { id: 'size_M', title: 'M' },
        { id: 'size_L', title: 'L' },
      ]);
      console.log(r);
      return;
    }
    case 'list': {
      const [to] = rest;
      if (!to) usage();
      const r = await sendInteractiveList(to, 'Pick a product', 'Browse catalog', [
        {
          title: 'Suits',
          rows: [
            { id: 'p_anar_pink', title: 'Anarkali Pink', description: '₹2,499' },
            { id: 'p_anar_blue', title: 'Anarkali Blue', description: '₹2,499' },
          ],
        },
        {
          title: 'Lehengas',
          rows: [{ id: 'p_lehga_red', title: 'Red Lehenga', description: '₹4,999' }],
        },
      ]);
      console.log(r);
      return;
    }
    case 'image': {
      const [to, link, ...caption] = rest;
      if (!to || !link) usage();
      const r = await sendImage(to, { link }, caption.join(' ') || undefined);
      console.log(r);
      return;
    }
    case 'template': {
      const [to, name, lang] = rest;
      if (!to || !name || !lang) usage();
      const r = await sendTemplate(to, name, lang);
      console.log(r);
      return;
    }
    case 'download': {
      const [mediaId] = rest;
      if (!mediaId) usage();
      const r = await downloadMedia(mediaId);
      console.log(r);
      return;
    }
    default:
      usage();
  }
}

function usage(): never {
  console.error(
    [
      'Usage:',
      '  send-test text     <to> [body...]',
      '  send-test buttons  <to>',
      '  send-test list     <to>',
      '  send-test image    <to> <publicImageUrl> [caption]',
      '  send-test template <to> <templateName> <langCode>',
      '  send-test download <mediaId>',
    ].join('\n'),
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
