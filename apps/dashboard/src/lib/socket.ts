'use client';

import { io, type Socket } from 'socket.io-client';
import { api, BACKEND_WS_ORIGIN } from './api';

let socket: Socket | null = null;

export function getDashboardSocket(): Socket {
  if (!socket) {
    // The socket connects directly to the backend (cross-site), so it can't rely on the
    // session cookie on iOS Safari. Instead we authenticate with a short-lived token
    // fetched over the first-party proxied API (where the cookie IS sent). The `auth`
    // function runs on every connect/reconnect, so the token is always fresh.
    socket = io(`${BACKEND_WS_ORIGIN}/dashboard`, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
      auth: (cb) => {
        api
          .get<{ token: string }>('/api/auth/socket-token')
          .then((r) => cb({ token: r.token }))
          .catch(() => cb({}));
      },
    });
  }
  return socket;
}
