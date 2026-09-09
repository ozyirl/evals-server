import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PipelineLogService } from '../assessments/pipeline-log.service';
import { ImagePrompterService } from '../image-prompter/image-prompter.service';
import { EnhancementPrompt } from '../image-prompter/image-prompter.schema';
import { NewImageAssessment } from '../db/schema';
import { AssessmentLogService } from '../assessments/assessment-log.service';
import {
  ImageQualityAssessment,
  ImageQualityService,
} from '../image-quality/image-quality.service';
import {
  ImageRouterService,
  RouteDestination,
} from '../routing/image-router.service';
import {
  buildImageQualityGraph,
  ImageQualityLabel,
} from './image-quality.graph';

export type ImageSource =
  { imageUrl: string } | { buffer: Buffer; mimeType: string };

export type AssessmentContext = {
  userId: string;
  fileName?: string;
  imageUrl?: string;
  runId?: string;
};

export type ImageAssessmentResult = ImageQualityLabel & {
  runId: string;
  enhancementPrompt: EnhancementPrompt | null;
  assessment: ImageQualityAssessment;
  /** The downstream handler this image was dispatched to. */
  destination: RouteDestination;
};

@Injectable()
export class ImageAgentService {
  private readonly logger = new Logger(ImageAgentService.name);
  private readonly graph: ReturnType<typeof buildImageQualityGraph>;

  constructor(
    private readonly imageQualityService: ImageQualityService,
    private readonly assessmentLog: AssessmentLogService,
    private readonly imageRouter: ImageRouterService,
    private readonly imagePrompter: ImagePrompterService,
    private readonly pipelineLog: PipelineLogService,
  ) {
    this.graph = buildImageQualityGraph(
      this.imageQualityService,
      this.imageRouter,
      this.imagePrompter,
      this.pipelineLog,
    );
  }

  async assessImage(
    source: ImageSource,
    context: AssessmentContext,
  ): Promise<ImageAssessmentResult> {
    const isUrl = 'imageUrl' in source;
    const startedAt = Date.now();
    const runId = context.runId ?? randomUUID();
    const traceContext = { runId, userId: context.userId };
    const baseEntry: NewImageAssessment = {
      id: runId,
      userId: context.userId,
      source: isUrl ? 'url' : 'upload',
      imageUrl: isUrl ? source.imageUrl : (context.imageUrl ?? null),
      fileName: context.fileName ?? null,
      mimeType: isUrl ? null : source.mimeType,
      byteSize: isUrl ? null : source.buffer.byteLength,
      model: this.imageQualityService.modelName,
      status: 'failed',
    };

    return this.pipelineLog.trace(
      traceContext,
      'image_pipeline',
      async () => {
        this.logger.log(
          `Assessing ${isUrl ? source.imageUrl : (context.fileName ?? 'upload')} for ${context.userId}`,
        );

        try {
          const state = await this.graph.invoke({
            ...source,
            imageUrl: baseEntry.imageUrl ?? undefined,
            ...traceContext,
            enhancementPrompt: null,
          });
          const latencyMs = Date.now() - startedAt;

          this.logger.log(
            `${state.result.label} (${state.assessment.confidence} confidence${
              state.result.needsReview ? ', needs review' : ''
            }) in ${latencyMs}ms`,
          );

          await this.persistAssessment({
            ...baseEntry,
            mimeType: state.mimeType,
            byteSize: state.buffer?.byteLength ?? null,
            status: 'completed',
            label: state.result.label,
            requiresEnhancement: state.result.requiresEnhancement,
            needsReview: state.result.needsReview,
            confidence: state.assessment.confidence,
            scores: state.assessment.scores,
            issues: state.assessment.issues,
            reason: state.assessment.reason,
            model: this.imageQualityService.modelName,
            latencyMs,
            enhancementPrompt: state.enhancementPrompt,
          });

          return {
            runId,
            enhancementPrompt: state.enhancementPrompt,
            ...state.result,
            assessment: state.assessment,
            destination: state.destination,
          };
        } catch (error) {
          const latencyMs = Date.now() - startedAt;
          const message =
            error instanceof Error ? error.message : String(error);

          this.logger.warn(
            `Assessment failed after ${latencyMs}ms: ${message}`,
          );

          // Failures are part of the eval record — a rejected URL or a model
          // error is a signal, not something to drop on the floor.
          await this.persistAssessment({
            ...baseEntry,
            latencyMs,
            errorMessage: message,
          });

          throw error;
        }
      },
      (result) => ({
        destination: result.destination,
        needsReview: result.needsReview,
        promptGenerated: result.enhancementPrompt !== null,
      }),
    );
  }

  private async persistAssessment(entry: NewImageAssessment): Promise<void> {
    // Logging remains best-effort, but a failed write must not appear as a completed hop.
    try {
      await this.pipelineLog.trace(
        { runId: entry.id, userId: entry.userId },
        'persist_assessment',
        async () => {
          if (!(await this.assessmentLog.record(entry)))
            throw new Error('Assessment log could not be persisted');
        },
      );
    } catch {
      // The failed hop was recorded; preserve the pipeline's result or original error.
    }
  }
}
