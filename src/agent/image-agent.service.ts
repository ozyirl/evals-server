import { Injectable, Logger } from '@nestjs/common';
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
};

export type ImageAssessmentResult = ImageQualityLabel & {
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
  ) {
    this.graph = buildImageQualityGraph(
      this.imageQualityService,
      this.imageRouter,
    );
  }

  async assessImage(
    source: ImageSource,
    context: AssessmentContext,
  ): Promise<ImageAssessmentResult> {
    const isUrl = 'imageUrl' in source;
    const startedAt = Date.now();

    this.logger.log(
      `Assessing ${isUrl ? source.imageUrl : (context.fileName ?? 'upload')} for ${context.userId}`,
    );

    try {
      const state = await this.graph.invoke(source);
      const latencyMs = Date.now() - startedAt;

      this.logger.log(
        `${state.result.label} (${state.assessment.confidence} confidence${
          state.result.needsReview ? ', needs review' : ''
        }) in ${latencyMs}ms`,
      );

      await this.assessmentLog.record({
        userId: context.userId,
        source: isUrl ? 'url' : 'upload',
        imageUrl: isUrl ? source.imageUrl : null,
        fileName: context.fileName ?? null,
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
      });

      return {
        ...state.result,
        assessment: state.assessment,
        destination: state.destination,
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(`Assessment failed after ${latencyMs}ms: ${message}`);

      // Failures are part of the eval record — a rejected URL or a model
      // error is a signal, not something to drop on the floor.
      await this.assessmentLog.record({
        userId: context.userId,
        source: isUrl ? 'url' : 'upload',
        imageUrl: isUrl ? source.imageUrl : null,
        fileName: context.fileName ?? null,
        mimeType: isUrl ? null : source.mimeType,
        byteSize: isUrl ? null : source.buffer.byteLength,
        status: 'failed',
        model: this.imageQualityService.modelName,
        latencyMs,
        errorMessage: message,
      });

      throw error;
    }
  }
}
