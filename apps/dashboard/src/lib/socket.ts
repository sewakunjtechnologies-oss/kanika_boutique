'use client';

import { io, type Socket } from 'socket.io-client';
import { BACKEND_BASE_URL } from './api';

let socket: Socket | null = null;

export function getDashboardSocket(): Socket {
  if (!socket) {
    socket = io(`${BACKEND_BASE_URL}/dashboard`, {
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}
