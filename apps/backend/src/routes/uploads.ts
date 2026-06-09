import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../auth/middleware';
import { storage } from '../storage';
import fs from 'node:fs/promises';

export const uploadsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp|gif)$/.test(file.mimetype);
    if (!ok) return cb(new Error('only jpg/png/webp/gif allowed'));
    cb(null, true);
  },
});

uploadsRouter.post(
  '/uploads/products',
  requireAuth,
  upload.single('photo'),
  async (req: Request, res: Response): Promise<void> => {
    // Temporary debug — remove after verifying. Logs only the filename, no secrets.
    // eslint-disable-next-line no-console
    console.log('uploaded file', req.file?.originalname);
    if (!req.file) {
      // Only a genuinely missing file reaches here (a wrong field name throws a Multer
      // "Unexpected field" error before this handler runs).
      res.status(400).json({ error: 'no_file', message: 'Photo file is required (field "photo").' });
      return;
    }
    const ext = path.extname(req.file.originalname).toLowerCase() || guessExt(req.file.mimetype);
    const filename = `products/${randomUUID()}${ext}`;
    const storedPath = await storage.save(req.file.buffer, filename, req.file.mimetype);
    res.json({ url: `/uploads/${storedPath}`, path: storedPath });
  },
);

// Serve uploaded files (auth not required — images can be viewed by customers via WA).
uploadsRouter.get('/uploads/*', async (req: Request, res: Response): Promise<void> => {
  const rel = req.params[0] ?? '';
  try {
    const absolute = storage.resolve(rel);
    const buf = await fs.readFile(absolute);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('Content-Type', guessMime(rel));
    res.send(buf);
  } catch {
    res.status(404).end();
  }
});

function guessExt(mime: string): string {
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  return '.jpg';
}
function guessMime(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.pdf') return 'application/pdf';
  return 'image/jpeg';
}
