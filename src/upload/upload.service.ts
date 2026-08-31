import { Injectable, Logger } from '@nestjs/common';
import { uploadFile } from '@uploadcare/upload-client';
import { storeFile, UploadcareSimpleAuthSchema } from '@uploadcare/rest-client';
import { AssessmentLogService } from '../assessments/assessment-log.service';
import {
  ImageQualityAssessment,
  ImageQualityService,
} from '../image-quality/image-quality.service';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  private readonly authSchema = new UploadcareSimpleAuthSchema({
    publicKey: process.env.UPLOADCARE_PUBLIC_KEY,
    secretKey: process.env.UPLOADCARE_SECRET_KEY,
  });

  constructor(
    private readonly imageQualityService: ImageQualityService,
    private readonly assessmentLog: AssessmentLogService,
  ) {}

  async storeImage(
    file: Express.Multer.File,
    userId: string,
  ): Promise<{
    uuid: string;
    cdnUrl: string;
    assessment: ImageQualityAssessment;
  }> {
    const startedAt = Date.now();
    this.logger.log(`Uploading ${file.originalname} for ${userId}`);

    try {
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

      const latencyMs = Date.now() - startedAt;
      this.logger.log(
        `Stored ${uploaded.uuid} — ${assessment.decision} (${assessment.confidence} confidence) in ${latencyMs}ms`,
      );

      await this.assessmentLog.record({
        userId,
        source: 'upload',
        imageUrl: uploaded.cdnUrl,
        fileName: file.originalname,
        mimeType: file.mimetype,
        byteSize: file.buffer.byteLength,
        status: 'completed',
        label: assessment.decision,
        requiresEnhancement: assessment.decision === 'ENHANCE',
        needsReview: false,
        confidence: assessment.confidence,
        scores: assessment.scores,
        issues: assessment.issues,
        reason: assessment.reason,
        model: this.imageQualityService.modelName,
        latencyMs,
      });

      return { uuid: uploaded.uuid, cdnUrl: uploaded.cdnUrl, assessment };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Upload failed after ${latencyMs}ms: ${message}`);

      await this.assessmentLog.record({
        userId,
        source: 'upload',
        fileName: file.originalname,
        mimeType: file.mimetype,
        byteSize: file.buffer.byteLength,
        status: 'failed',
        model: this.imageQualityService.modelName,
        latencyMs,
        errorMessage: message,
      });

      throw error;
    }
  }
}
