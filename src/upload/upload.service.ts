import { Injectable } from '@nestjs/common';
import { uploadFile } from '@uploadcare/upload-client';
import { storeFile, UploadcareSimpleAuthSchema } from '@uploadcare/rest-client';

@Injectable()
export class UploadService {
  private readonly authSchema = new UploadcareSimpleAuthSchema({
    publicKey: process.env.UPLOADCARE_PUBLIC_KEY,
    secretKey: process.env.UPLOADCARE_SECRET_KEY,
  });

  async storeImage(
    file: Express.Multer.File,
  ): Promise<{ uuid: string; cdnUrl: string }> {
    const uploaded = await uploadFile(file.buffer, {
      publicKey: process.env.UPLOADCARE_PUBLIC_KEY,
      fileName: file.originalname,
      contentType: file.mimetype,
      store: false,
    });

    await storeFile({ uuid: uploaded.uuid }, { authSchema: this.authSchema });

    return { uuid: uploaded.uuid, cdnUrl: uploaded.cdnUrl };
  }
}
