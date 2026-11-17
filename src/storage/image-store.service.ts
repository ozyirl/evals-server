import { Injectable } from '@nestjs/common';
import { uploadFile } from '@uploadcare/upload-client';
import { storeFile, UploadcareSimpleAuthSchema } from '@uploadcare/rest-client';

export interface StoredImage {
  uuid: string;
  cdnUrl: string;
}

/**
 * Keeps generated images on the CDN. Candidates are stored as well as the
 * published result: a rejected candidate is eval evidence, and a QA verdict
 * means little without the image it was passed on.
 */
@Injectable()
export class ImageStoreService {
  async store(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<StoredImage> {
    const publicKey = process.env.UPLOADCARE_PUBLIC_KEY;
    const secretKey = process.env.UPLOADCARE_SECRET_KEY;
    if (!publicKey || !secretKey) {
      throw new Error('Uploadcare keys are not configured');
    }
    const uploaded = await uploadFile(buffer, {
      publicKey,
      fileName,
      contentType: mimeType,
      store: false,
    });
    await storeFile(
      { uuid: uploaded.uuid },
      { authSchema: new UploadcareSimpleAuthSchema({ publicKey, secretKey }) },
    );
    return { uuid: uploaded.uuid, cdnUrl: uploaded.cdnUrl };
  }
}
