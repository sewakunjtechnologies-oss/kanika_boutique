import { Server, type Socket } from 'socket.io';
import type http from 'node:http';
import { logger } from '../logger';
import { env } from '../config/env';
import { verifyAuthToken } from '../auth/jwt';

export const DASHBOARD_NAMESPACE = '/dashboard';

export type DashboardEvent =
  | 'message'
  | 'order_created'
  | 'order_status_changed'
  | 'payment_received'
  | 'takeover_changed'
  | 'inventory_changed'
  | 'support_requested';

let io: Server | null = null;

export function initSocketIO(httpServer: http.Server): Server {
  const dashboardOrigins =
    env.NODE_ENV === 'production'
      ? [env.PUBLIC_DASHBOARD_URL]
      : [env.PUBLIC_DASHBOARD_URL, 'http://localhost:3000', 'http://localhost:3030'];

  io = new Server(httpServer, {
    cors: {
      origin: dashboardOrigins,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  const ns = io.of(DASHBOARD_NAMESPACE);

  // Auth middleware: read JWT from handshake auth or cookie.
  ns.use((socket: Socket, next) => {
    const token =
      (socket.handshake.auth?.token as string | undefined) ??
      extractCookie(socket.handshake.headers.cookie, 'kda_session');
    if (!token) return next(new Error('unauthorized'));
    const payload = verifyAuthToken(token);
    if (!payload) return next(new Error('unauthorized'));
    socket.data.userId = payload.sub;
    next();
  });

  ns.on('connection', (socket) => {
    logger.info({ socketId: socket.id, userId: socket.data.userId }, 'dashboard socket connected');
    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'dashboard socket disconnected');
    });
  });

  logger.info({ namespace: DASHBOARD_NAMESPACE }, 'Socket.IO server initialized');
  return io;
}

export function emitToDashboard(event: DashboardEvent, payload: object): void {
  if (!io) return;
  io.of(DASHBOARD_NAMESPACE).emit(event, payload);
}

export async function closeSocketIO(): Promise<void> {
  if (!io) return;
  await io.close();
  io = null;
}

function extractCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
