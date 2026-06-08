import path from 'node:path';
import { env } from '../config/env';
import { LocalStorage } from './LocalStorage';
import type { StorageService } from './StorageService';

// In production, UPLOADS_DIR points at a persistent disk mount (e.g.
// /var/data/uploads on Render) so media survives deploys/restarts. When unset
// (local dev), uploads/ lives at the monorepo root.
const UPLOADS_ROOT = env.UPLOADS_DIR
  ? path.resolve(env.UPLOADS_DIR)
  : path.resolve(__dirname, '../../../../uploads');

export const storage: StorageService = new LocalStorage(UPLOADS_ROOT);

export type { StorageService } from './StorageService';
