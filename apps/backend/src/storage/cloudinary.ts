import { v2 as cloudinary } from 'cloudinary';
import { env } from '../config/env';

/** Folder under which all product photos are stored in Cloudinary. */
export const PRODUCTS_FOLDER = 'kanika-boutique/products';

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  // api_secret stays server-side only — it is never sent to or exposed in the frontend.
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

export interface CloudinaryUpload {
  url: string; // secure_url (https://res.cloudinary.com/...)
  publicId: string; // public_id, used later to replace/delete the asset
}

/** Upload an in-memory image buffer to Cloudinary and return its URL + public_id. */
export function uploadImageBuffer(buffer: Buffer, folder = PRODUCTS_FOLDER): Promise<CloudinaryUpload> {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (error, result) => {
        if (error || !result) {
          reject(error ?? new Error('cloudinary upload returned no result'));
          return;
        }
        resolve({ url: result.secure_url, publicId: result.public_id });
      },
    );
    stream.end(buffer);
  });
}

/** Delete an asset by public_id. Safe to call for any provider/state — see safeDeleteImage callers. */
export async function deleteImage(publicId: string): Promise<void> {
  ensureConfigured();
  await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true });
}
