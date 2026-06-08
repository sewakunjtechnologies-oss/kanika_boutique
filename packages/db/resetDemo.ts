/**
 * Demo reset — wipes all transactional data so you can run a demo from scratch,
 * while KEEPING the catalog (products + variants), the admin login, and settings.
 *
 * What it deletes: stock movements, order items, orders, messages, conversations,
 * and customers. What it keeps: products, product variants (stock reset to full),
 * admin users, and settings (business name, UPI, templates).
 *
 * Safety: refuses to run unless you pass --yes (or CONFIRM_DEMO_RESET=yes), and
 * never runs when NODE_ENV=production.
 *
 * Run:  npm run db:reset:demo -- --yes
 */
/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Stock each size is reset to after the wipe (matches seedProducts STOCK_PER_SIZE).
const STOCK_PER_SIZE = 10;

function confirmed(): boolean {
  return process.argv.includes('--yes') || process.env.CONFIRM_DEMO_RESET === 'yes';
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run demo reset with NODE_ENV=production.');
  }
  if (!confirmed()) {
    console.log(
      'Demo reset will DELETE all orders, conversations, messages, and customers ' +
        '(products, admin, and settings are kept).\n' +
        'Re-run with --yes to confirm:  npm run db:reset:demo -- --yes',
    );
    return;
  }

  console.log('Resetting demo data...');

  // Delete in FK-safe order. Orders must go before customers (Customer.orders is
  // onDelete: Restrict); conversations/messages cascade from customer but we
  // delete them explicitly so the counts are clear.
  const stockMovements = await prisma.stockMovement.deleteMany({});
  const orderItems = await prisma.orderItem.deleteMany({});
  const orders = await prisma.order.deleteMany({});
  const messages = await prisma.message.deleteMany({});
  const conversations = await prisma.conversation.deleteMany({});
  const customers = await prisma.customer.deleteMany({});

  // Reset stock so every catalog size is available again for the demo.
  const variants = await prisma.productVariant.updateMany({ data: { stock: STOCK_PER_SIZE } });

  // Reset per-customer rollups are gone with the customers; nothing else to clear.
  console.log('  ✓ stock movements deleted:', stockMovements.count);
  console.log('  ✓ order items deleted:    ', orderItems.count);
  console.log('  ✓ orders deleted:         ', orders.count);
  console.log('  ✓ messages deleted:       ', messages.count);
  console.log('  ✓ conversations deleted:  ', conversations.count);
  console.log('  ✓ customers deleted:      ', customers.count);
  console.log(`  ✓ variant stock reset to ${STOCK_PER_SIZE} on`, variants.count, 'variants');

  const [products, admins] = await Promise.all([prisma.product.count(), prisma.adminUser.count()]);
  console.log(`Kept: ${products} products, ${admins} admin user(s), and all settings.`);
  console.log('Demo reset complete. Fresh slate ready.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
