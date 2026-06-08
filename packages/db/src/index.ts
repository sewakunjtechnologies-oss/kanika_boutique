import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __kdaPrisma: PrismaClient | undefined;
}

// Singleton across hot reloads in dev so we don't exhaust connections.
export const prisma: PrismaClient =
  global.__kdaPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__kdaPrisma = prisma;
}

export * from '@prisma/client';
