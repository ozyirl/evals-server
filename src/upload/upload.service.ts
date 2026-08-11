import { Injectable } from '@nestjs/common';
import { uploadFile } from '@uploadcare/upload-client';
import { storeFile, UploadcareSimpleAuthSchema } from '@uploadcare/rest-client';
import {
  ImageQualityAssessment,
  ImageQualityService,
} from '../image-quality/image-quality.service';

@Injectable()
export class UploadService {
  private readonly authSchema = new UploadcareSimpleAuthSchema({
    publicKey: process.env.UPLOADCARE_PUBLIC_KEY,
    secretKey: process.env.UPLOADCARE_SECRET_KEY,
  });

  constructor(private readonly imageQualityService: ImageQualityService) {}

  async storeImage(file: Express.Multer.File): Promise<{
    uuid: string;
    cdnUrl: string;
    assessment: ImageQualityAssessment;
  }> {
    const [uploaded, assessment] = await Promise.all([
      uploadFile(file.buffer, {
        publicKey: process.env.UPLOADCARE_PUBLIC_KEY,
        fileName: file.originalname,
        contentType: file.mimetype,
        store: false,
      }),
      this.imageQualityService.assessImage(file.buffer, file.mimetype),
    ]);

    await storeFile({ uuid: uploaded.uuid }, { authSchema: this.authSchema });

    return { uuid: uploaded.uuid, cdnUrl: uploaded.cdnUrl, assessment };
  }
}
