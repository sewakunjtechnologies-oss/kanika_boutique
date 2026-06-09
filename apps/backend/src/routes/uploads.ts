import { Router, type Request, type Response, type NextFunction } from 'express';
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

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Memory storage (not disk) so the buffer can be streamed straight to Cloudinary.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(new Error('invalid_type'));
      return;
    }
    cb(null, true);
  },
});

// Product images go to Cloudinary in production (never the ephemeral disk) and whenever
// the provider is explicitly cloudinary. Locally, the default 'local' provider uses disk.
const useCloudinary = (): boolean =>
  env.UPLOAD_PROVIDER === 'cloudinary' || env.NODE_ENV === 'production';

// Wrap multer so its errors become clear 400s instead of falling through to the generic
// 500 handler. Without this, an oversized file / wrong type / wrong field name all 500.
function acceptPhoto(req: Request, res: Response, next: NextFunction): void {
  upload.single('photo')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'Image must be 5MB or smaller' });
        return;
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({ error: 'Unexpected file field — use "photo"' });
        return;
      }
      res.status(400).json({ error: 'File upload error' });
      return;
    }
    if (err instanceof Error && err.message === 'invalid_type') {
      res.status(400).json({ error: 'Only JPEG, PNG, and WebP images are allowed' });
      return;
    }
    next(err);
  });
}

uploadsRouter.post(
  '/uploads/products',
  requireAuth,
  acceptPhoto,
  async (req: Request, res: Response): Promise<void> => {
    // Temporary diagnostic — safe metadata only, no secrets. Remove once verified.
    // eslint-disable-next-line no-console
    console.log('Upload received', {
      field: req.file?.fieldname,
      name: req.file?.originalname,
      type: req.file?.mimetype,
      size: req.file?.size,
    });

    if (!req.file) {
      res.status(400).json({ error: 'Product photo is required' });
      return;
    }

    if (useCloudinary()) {
      try {
        const { url, publicId } = await uploadImageBuffer(req.file.buffer, PRODUCTS_FOLDER);
        // eslint-disable-next-line no-console
        console.log('Cloudinary upload success', { publicId });
        res.json({ url, publicId, path: publicId });
      } catch (err) {
        // Log the real cause server-side; never leak secrets or stack traces to the client.
        logger.error({ err }, 'cloudinary upload failed');
        res.status(500).json({ error: 'Image upload failed' });
      }
      return;
    }

    // Local provider (dev only): write to UPLOADS_DIR and return a relative URL.
    try {
      const ext = path.extname(req.file.originalname).toLowerCase() || guessExt(req.file.mimetype);
      const filename = `products/${randomUUID()}${ext}`;
      const storedPath = await storage.save(req.file.buffer, filename, req.file.mimetype);
      res.json({ url: `/uploads/${storedPath}`, path: storedPath });
    } catch (err) {
      logger.error({ err }, 'local image save failed');
      res.status(500).json({ error: 'Image upload failed' });
    }
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
