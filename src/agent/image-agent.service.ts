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
import { ImageEnhancerService } from '../image-enhancer/image-enhancer.service';
import { ImagePostProcessService } from '../image-postprocess/image-postprocess.service';
import { ImageQaService } from '../image-qa/image-qa.service';
import { ImageStoreService } from '../storage/image-store.service';
import { EnhancementSummary, RunOutcome } from './enhancement.types';
import {
  buildImageQualityGraph,
  DEFAULT_MAX_ATTEMPTS,
  ImageQualityLabel,
} from './image-quality.graph';

const MAX_ATTEMPTS_LIMIT = 5;

/** `IMAGE_MAX_ATTEMPTS`, clamped so a typo cannot buy an unbounded loop. */
export function resolveMaxAttempts(
  raw = process.env.IMAGE_MAX_ATTEMPTS,
): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed)
    ? Math.min(MAX_ATTEMPTS_LIMIT, Math.max(1, parsed))
    : DEFAULT_MAX_ATTEMPTS;
}

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
  /** The branch of the graph this image was dispatched to. */
  destination: RouteDestination;
  /** Every candidate and verdict; null when no image was generated. */
  enhancement: EnhancementSummary | null;
  outcome: RunOutcome;
  outcomeReason: string;
  publishedImageUrl: string | null;
};

@Injectable()
export class ImageAgentService {
  private readonly logger = new Logger(ImageAgentService.name);
  private readonly graph: ReturnType<typeof buildImageQualityGraph>;
  readonly maxAttempts = resolveMaxAttempts();

  constructor(
    private readonly imageQualityService: ImageQualityService,
    private readonly assessmentLog: AssessmentLogService,
    private readonly imageRouter: ImageRouterService,
    private readonly imagePrompter: ImagePrompterService,
    private readonly pipelineLog: PipelineLogService,
    private readonly imageEnhancer: ImageEnhancerService,
    private readonly imageQa: ImageQaService,
    private readonly postProcessor: ImagePostProcessService,
    private readonly imageStore: ImageStoreService,
  ) {
    this.graph = buildImageQualityGraph({
      imageQuality: this.imageQualityService,
      imageRouter: this.imageRouter,
      imagePrompter: this.imagePrompter,
      imageEnhancer: this.imageEnhancer,
      imageQa: this.imageQa,
      postProcessor: this.postProcessor,
      imageStore: this.imageStore,
      pipelineLog: this.pipelineLog,
      maxAttempts: this.maxAttempts,
    });
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
          const state = await this.graph.invoke(
            {
              ...source,
              imageUrl: baseEntry.imageUrl ?? undefined,
              ...traceContext,
              enhancementPrompt: null,
              activePrompt: null,
              attempts: [],
              candidate: null,
              finalImage: null,
              finalCheck: null,
              outcome: null,
              outcomeReason: null,
              publishedImageUrl: null,
            },
            // Each retry is three nodes; the default limit of 25 is too tight.
            { recursionLimit: 12 + this.maxAttempts * 4 },
          );
          const latencyMs = Date.now() - startedAt;
          const enhancement: EnhancementSummary | null =
            state.attempts.length > 0
              ? {
                  provider: this.imageEnhancer.provider,
                  model: this.imageEnhancer.modelName,
                  maxAttempts: this.maxAttempts,
                  attempts: state.attempts,
                  passedIteration:
                    state.attempts.find((attempt) => attempt.qa?.passed)
                      ?.iteration ?? null,
                  finalCheck: state.finalCheck,
                }
              : null;

          this.logger.log(
            `${state.result.label} (${state.assessment.confidence} confidence${
              state.result.needsReview ? ', needs review' : ''
            }) → ${state.outcome} after ${state.attempts.length} candidate${
              state.attempts.length === 1 ? '' : 's'
            } in ${latencyMs}ms`,
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
            enhancement,
            outcome: state.outcome,
            outcomeReason: state.outcomeReason,
            publishedImageUrl: state.publishedImageUrl,
          });

          return {
            runId,
            enhancementPrompt: state.enhancementPrompt,
            ...state.result,
            assessment: state.assessment,
            destination: state.destination,
            enhancement,
            outcome: state.outcome,
            outcomeReason: state.outcomeReason,
            publishedImageUrl: state.publishedImageUrl,
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
        outcome: result.outcome,
        attempts: result.enhancement?.attempts.length ?? 0,
        passedIteration: result.enhancement?.passedIteration ?? null,
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
