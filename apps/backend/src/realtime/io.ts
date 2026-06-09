import { Server, type Socket } from 'socket.io';
import type http from 'node:http';
import { logger } from '../logger';
import { allowedOrigins } from '../config/cors';
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
  // Shared allow-list with the REST API. The dashboard connects to this socket directly
  // (cross-site, since Vercel can't proxy WebSockets), authenticating with a handshake
  // token rather than the cookie — iOS Safari won't send a third-party cookie.
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  const ns = io.of(DASHBOARD_NAMESPACE);

  // Auth middleware: read the short-lived socket JWT from handshake auth.
  // Browser login itself is a server-side session cookie; the socket token is
  // fetched over /api/auth/socket-token because Vercel cannot proxy WebSockets.
  ns.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
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
