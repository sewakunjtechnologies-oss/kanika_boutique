import express, { type Request, type Response, type NextFunction } from 'express';
import http from 'node:http';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env, logMetaWarnings } from './config/env';
import { allowedOrigins, normalizeOrigin } from './config/cors';
import { logger } from './logger';
import { createDashboardSessionMiddleware, ensurePersistentSessionCookieHeader } from './auth/session';
import { prisma } from '@kda/db';
import { webhookRouter } from './routes/webhook';
import { authRouter } from './routes/auth';
import { productsRouter } from './routes/products';
import { ordersRouter } from './routes/orders';
import { categoriesRouter } from './routes/categories';
import { manualReceiptsRouter } from './routes/manualReceipts';
import { conversationsRouter } from './routes/conversations';
import { customersRouter } from './routes/customers';
import { settingsRouter } from './routes/settings';
import { uploadsRouter } from './routes/uploads';
import {
  maintenanceQueue,
  scheduleMaintenanceJobs,
  startMaintenanceWorker,
  startWebhookWorker,
  webhookQueue,
} from './queues/messageQueue';
import { redisConnection } from './queues/connection';
import { closeSocketIO, initSocketIO } from './realtime/io';

const app = express();
const server = http.createServer(app);
app.set('trust proxy', 1);

// ===== CORS configuration =====
// allowedOrigins (shared with the Socket.IO server) is normalized + de-duplicated from
// env and always includes the production dashboard origin. One shared corsOptions object
// is reused for the global middleware and the explicit preflight handler so OPTIONS and
// real requests behave identically. Note: in production the dashboard proxies /api/* to
// this backend (Next.js rewrites), so most browser traffic is same-origin and never
// triggers CORS — this allow-list mainly governs the direct Socket.IO connection and any
// direct API calls.
logger.info({ allowedOrigins }, `Allowed CORS origins: ${JSON.stringify(allowedOrigins)}`);

const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // No Origin header → non-browser client (curl, health checks, server-to-server). Allow.
    if (!origin) {
      callback(null, true);
      return;
    }
    if (allowedOrigins.includes(normalizeOrigin(origin))) {
      // Reflects the request origin (never "*"), required when credentials are enabled.
      callback(null, true);
      return;
    }
    logger.warn({ origin }, `CORS blocked origin: ${origin}`);
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// ===== Security headers =====
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow dashboard to load /uploads/* images
    contentSecurityPolicy: false, // dashboard is a separate origin, no CSP needed here
  }),
);

// ===== CORS for dashboard (registered before all routes) =====
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // shared options → preflight returns the same ACAO header

// ===== Logging =====
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

// ===== Cookies =====
app.use(cookieParser());
app.use(ensurePersistentSessionCookieHeader);
app.use(createDashboardSessionMiddleware());

// ===== Body parsing — capture rawBody for webhook signature verification =====
app.use(
  express.json({
    limit: '10mb',
    verify: (req: Request, _res, buf: Buffer): void => {
      req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// ===== Rate limit on auth =====
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/', authLimiter);

// ===== Health =====
app.get('/health', async (_req: Request, res: Response): Promise<void> => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const redisOk = redisConnection.status === 'ready';
    res.json({
      status: redisOk ? 'ok' : 'degraded',
      db: 'up',
      redis: redisOk ? 'up' : redisConnection.status,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'health check failed');
    res.status(503).json({ status: 'degraded', db: 'down' });
  }
});

// ===== Webhook (Meta signs raw body; mounted at root) =====
app.use(webhookRouter);

// ===== API routes — all behind /api =====
// uploadsRouter must come first: its GET /uploads/* is public, and the
// protected routers below use `router.use(requireAuth)` which would otherwise
// intercept every /api/* request and 401 before the path is matched.
app.use('/api', uploadsRouter);
app.use('/api', authRouter);
app.use('/api', categoriesRouter);
app.use('/api', productsRouter);
app.use('/api', ordersRouter);
app.use('/api', manualReceiptsRouter);
app.use('/api', conversationsRouter);
app.use('/api', customersRouter);
app.use('/api', settingsRouter);

// ===== Generic error handler =====
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: Request, res: Response, _next: NextFunction): void => {
  logger.error({ err, url: req.url }, 'unhandled error');
  if (res.headersSent) return;
  res.status(500).json({ error: 'server_error' });
});

// ===== Bootstrap workers + sockets =====
logMetaWarnings((msg) => logger.warn(msg));
if (env.NODE_ENV === 'production') {
  logger.warn('local filesystem uploads are enabled; use persistent disk or object storage for production media');
}
const startEmbeddedWorkers = env.START_EMBEDDED_WORKERS ?? env.NODE_ENV !== 'production';
const worker = startEmbeddedWorkers ? startWebhookWorker() : null;
const maintenanceWorker = startEmbeddedWorkers ? startMaintenanceWorker() : null;
if (startEmbeddedWorkers) {
  void scheduleMaintenanceJobs().catch((err) => {
    logger.error({ err }, 'failed to schedule maintenance jobs');
  });
} else {
  logger.info('embedded workers disabled; start the worker process separately');
}
initSocketIO(server);

server.listen(env.BACKEND_PORT, () => {
  logger.info({ port: env.BACKEND_PORT, env: env.NODE_ENV }, 'backend listening');
});

// ===== Graceful shutdown =====
let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  try {
    await closeSocketIO();
    await worker?.close();
    await maintenanceWorker?.close();
    await webhookQueue.close();
    await maintenanceQueue.close();
    redisConnection.disconnect();
    await prisma.$disconnect();
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
  }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ===== Last-resort error logging =====
// Without these, an unhandled rejection logs to stderr unstructured (or, on
// newer Node, crashes the process). We log structured JSON via pino instead.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: reason instanceof Error ? reason.stack : reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — shutting down');
  void shutdown('uncaughtException');
});
