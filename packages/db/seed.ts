/**
 * Seed: creates an admin user + default settings on a fresh database.
 *
 * Run: `npm run db:seed`
 *
 * For production, provide SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD explicitly.
 */
/* eslint-disable no-console */
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_ADMIN = {
  email: process.env.SEED_ADMIN_EMAIL ?? 'admin@boutique.local',
  name: 'Admin',
};

const DEFAULT_SETTINGS: Record<string, string> = {
  business_name: process.env.BUSINESS_NAME ?? 'Kanika Designs',
  upi_id: process.env.UPI_ID ?? 'kanikadesigns@upi',
  shipping_fee: String(process.env.DEFAULT_SHIPPING_FEE ?? '100'),
  working_hours_start: '10:00',
  working_hours_end: '20:00',
  greeting_template: 'Welcome to {{business_name}}! Send a product photo or pick an option below.',
  away_template: "We're not online right now — please leave your message and we'll respond within business hours (10 AM – 8 PM).",
  order_confirmation_template: '✅ Order #{{order_number}} confirmed! Dispatch in 24 hours.',
  payment_rejection_template:
    "We couldn't verify your payment. Please send a clearer screenshot of the UTR and amount.",
};

async function main(): Promise<void> {
  console.log('Seeding database...');

  // Admin user.
  const existing = await prisma.adminUser.findUnique({
    where: { email: DEFAULT_ADMIN.email.toLowerCase() },
  });
  if (existing) {
    console.log(`  • admin user ${DEFAULT_ADMIN.email} already exists, skipping`);
  } else {
    if (!process.env.SEED_ADMIN_PASSWORD) {
      throw new Error('SEED_ADMIN_PASSWORD is required to create the initial admin user.');
    }
    const hash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD, 10);
    await prisma.adminUser.create({
      data: {
        email: DEFAULT_ADMIN.email.toLowerCase(),
        passwordHash: hash,
        name: DEFAULT_ADMIN.name,
        role: 'OWNER',
      },
    });
    console.log(`  ✓ admin user created: ${DEFAULT_ADMIN.email}`);
  }

  // Settings.
  let added = 0;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const result = await prisma.setting.upsert({
      where: { key },
      create: { key, value },
      update: {}, // never overwrite existing settings
    });
    if (result) added += 1;
  }
  console.log(`  ✓ ${added} settings present`);

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
