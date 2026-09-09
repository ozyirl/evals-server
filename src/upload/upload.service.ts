import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { uploadFile } from '@uploadcare/upload-client';
import { storeFile, UploadcareSimpleAuthSchema } from '@uploadcare/rest-client';
import { AssessmentLogService } from '../assessments/assessment-log.service';
import { PipelineLogService } from '../assessments/pipeline-log.service';
import {
  ImageAgentService,
  ImageAssessmentResult,
} from '../agent/image-agent.service';

export type StoredImageResult = ImageAssessmentResult & {
  uuid: string;
  cdnUrl: string;
};

@Injectable()
export class UploadService {
  private readonly authSchema = new UploadcareSimpleAuthSchema({
    publicKey: process.env.UPLOADCARE_PUBLIC_KEY,
    secretKey: process.env.UPLOADCARE_SECRET_KEY,
  });

  constructor(
    private readonly imageAgent: ImageAgentService,
    private readonly assessmentLog: AssessmentLogService,
    private readonly pipelineLog: PipelineLogService,
  ) {}

  async storeImage(
    file: Express.Multer.File,
    userId: string,
  ): Promise<StoredImageResult> {
    const context = { runId: randomUUID(), userId };
    return this.pipelineLog.trace(
      context,
      'upload_pipeline',
      async () => {
        const startedAt = Date.now();
        let uploaded: Awaited<ReturnType<typeof uploadFile>>;
        try {
          uploaded = await this.pipelineLog.trace(
            context,
            'upload_image',
            () =>
              uploadFile(file.buffer, {
                publicKey: process.env.UPLOADCARE_PUBLIC_KEY,
                fileName: file.originalname,
                contentType: file.mimetype,
                store: false,
              }),
            (result) => ({ uuid: result.uuid, cdnUrl: result.cdnUrl }),
            { byteSize: file.buffer.byteLength, mimeType: file.mimetype },
          );
          await this.pipelineLog.trace(
            context,
            'store_image',
            () =>
              storeFile(
                { uuid: uploaded.uuid },
                { authSchema: this.authSchema },
              ),
            () => ({ uuid: uploaded.uuid }),
          );
        } catch (error) {
          try {
            await this.pipelineLog.trace(
              context,
              'persist_assessment',
              async () => {
                const persisted = await this.assessmentLog.record({
                  id: context.runId,
                  userId,
                  source: 'upload',
                  fileName: file.originalname,
                  mimeType: file.mimetype,
                  byteSize: file.buffer.byteLength,
                  status: 'failed',
                  imageUrl: uploaded?.cdnUrl ?? null,
                  latencyMs: Date.now() - startedAt,
                  errorMessage:
                    error instanceof Error ? error.message : String(error),
                });
                if (!persisted)
                  throw new Error('Assessment log could not be persisted');
              },
            );
          } catch {
            /* Preserve the original upload error after recording the failed persistence hop. */
          }
          throw error;
        }

        // One graph owns assessment, confidence handling, routing, prompting and their logs.
        const result = await this.imageAgent.assessImage(
          { buffer: file.buffer, mimeType: file.mimetype },
          {
            ...context,
            fileName: file.originalname,
            imageUrl: uploaded.cdnUrl,
          },
        );
        return { uuid: uploaded.uuid, cdnUrl: uploaded.cdnUrl, ...result };
      },
      (result) => ({
        destination: result.destination,
        promptGenerated: result.enhancementPrompt !== null,
      }),
    );
  }
}
