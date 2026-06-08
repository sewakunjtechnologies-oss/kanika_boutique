import path from 'node:path';
import { LocalStorage } from './LocalStorage';
import type { StorageService } from './StorageService';

// uploads/ lives at the monorepo root (.../kanika_design_automation/uploads).
const UPLOADS_ROOT = path.resolve(__dirname, '../../../../uploads');

export const storage: StorageService = new LocalStorage(UPLOADS_ROOT);

export type { StorageService } from './StorageService';
