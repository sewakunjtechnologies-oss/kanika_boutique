import { prisma } from '@kda/db';
import { env } from '../config/env';

export interface BusinessSettings {
  businessName: string;
  upiId: string;
  shippingFee: number;
  workingHoursStart: string;
  workingHoursEnd: string;
  greetingTemplate: string;
  awayTemplate: string;
  orderConfirmationTemplate: string;
  paymentRejectionTemplate: string;
}

export async function getBusinessSettings(): Promise<BusinessSettings> {
  const rows = await prisma.setting.findMany({
    where: {
      key: {
        in: [
          'business_name',
          'upi_id',
          'shipping_fee',
          'working_hours_start',
          'working_hours_end',
          'greeting_template',
          'away_template',
          'order_confirmation_template',
          'payment_rejection_template',
        ],
      },
    },
  });
  const map = new Map(rows.map((row) => [row.key, row.value]));
  return {
    businessName: setting(map, 'business_name', env.BUSINESS_NAME),
    upiId: setting(map, 'upi_id', env.UPI_ID),
    shippingFee: positiveNumber(setting(map, 'shipping_fee', String(env.DEFAULT_SHIPPING_FEE)), env.DEFAULT_SHIPPING_FEE),
    workingHoursStart: setting(map, 'working_hours_start', '10:00'),
    workingHoursEnd: setting(map, 'working_hours_end', '20:00'),
    greetingTemplate: setting(
      map,
      'greeting_template',
      'Welcome to {{business_name}}! Send a product photo or pick an option below.',
    ),
    awayTemplate: setting(
      map,
      'away_template',
      "We're not online right now. Please leave your message and we'll respond during business hours.",
    ),
    orderConfirmationTemplate: setting(
      map,
      'order_confirmation_template',
      'Order #{{order_number}} confirmed! Dispatch in 24 hours.',
    ),
    paymentRejectionTemplate: setting(
      map,
      'payment_rejection_template',
      "We couldn't verify your payment. Please send a clearer screenshot of the UTR and amount.",
    ),
  };
}

export function renderSettingTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => String(values[key] ?? ''));
}

function setting(map: Map<string, string>, key: string, fallback: string): string {
  const value = map.get(key)?.trim();
  return value ? value : fallback;
}

function positiveNumber(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
