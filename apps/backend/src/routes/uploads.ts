import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../auth/middleware';
import { storage } from '../storage';
import { uploadImageBuffer, PRODUCTS_FOLDER } from '../storage/cloudinary';
import { env } from '../config/env';
import { logger } from '../logger';
import fs from 'node:fs/promises';

export const uploadsRouter = Router();

// Memory storage (not disk) so the buffer can be streamed straight to Cloudinary.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpe?g|png|webp)$/.test(file.mimetype);
    if (!ok) return cb(new Error('only jpeg, png, or webp images are allowed'));
    cb(null, true);
  },
});

uploadsRouter.post(
  '/uploads/products',
  requireAuth,
  upload.single('photo'),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      // Only a genuinely missing file reaches here (a wrong field name throws a Multer
      // "Unexpected field" error before this handler runs).
      res.status(400).json({ error: 'no_file', message: 'Photo file is required (field "photo").' });
      return;
    }
    logger.info({ originalname: req.file.originalname, size: req.file.size, provider: env.UPLOAD_PROVIDER }, 'product image upload');

    if (env.UPLOAD_PROVIDER === 'cloudinary') {
      try {
        const { url, publicId } = await uploadImageBuffer(req.file.buffer, PRODUCTS_FOLDER);
        res.json({ url, publicId, path: publicId });
      } catch (err) {
        logger.error({ err }, 'cloudinary upload failed');
        res.status(500).json({ error: 'Image upload failed' });
      }
      return;
    }

    // Local provider (dev / disk-backed): write to UPLOADS_DIR and return a relative URL.
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
