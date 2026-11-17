import { BadRequestException } from '@nestjs/common';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  ImageQualityAssessment,
  ImageQualityService,
} from '../image-quality/image-quality.service';
import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from '../image-quality/image-quality.constants';
import {
  ImageRouterService,
  RouteDestination,
} from '../routing/image-router.service';
import { PipelineLogService } from '../assessments/pipeline-log.service';
import { ImagePrompterService } from '../image-prompter/image-prompter.service';
import { EnhancementPrompt } from '../image-prompter/image-prompter.schema';
import { ImageEnhancerService } from '../image-enhancer/image-enhancer.service';
import { ImagePostProcessService } from '../image-postprocess/image-postprocess.service';
import { ImageQaService } from '../image-qa/image-qa.service';
import { ImageStoreService } from '../storage/image-store.service';
import {
  EnhancementAttempt,
  FinalCheck,
  RunOutcome,
} from './enhancement.types';

/** Assessments below this confidence are flagged for a human instead of auto-labelled. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/** Candidates generated per run before the loop gives up. */
export const DEFAULT_MAX_ATTEMPTS = 3;

const FETCH_TIMEOUT_MS = 10_000;

type ImageBytes = { buffer: Buffer; mimeType: string };

export interface ImageGraphDeps {
  imageQuality: ImageQualityService;
  imageRouter: ImageRouterService;
  imagePrompter: ImagePrompterService;
  imageEnhancer: ImageEnhancerService;
  imageQa: ImageQaService;
  postProcessor: ImagePostProcessService;
  imageStore: ImageStoreService;
  pipelineLog: PipelineLogService;
  maxAttempts?: number;
}

export interface ImageQualityLabel {
  label: 'ENHANCE' | 'KEEP';
  requiresEnhancement: boolean;
  needsReview: boolean;
}

export const ImageQualityAnnotation = Annotation.Root({
  runId: Annotation<string>,
  userId: Annotation<string>,
  /** Set when the image comes from an upstream service; resolved into a buffer. */
  imageUrl: Annotation<string>,
  buffer: Annotation<Buffer>,
  mimeType: Annotation<string>,
  assessment: Annotation<ImageQualityAssessment>,
  result: Annotation<ImageQualityLabel>,
  /** Which downstream handler the image was dispatched to. */
  destination: Annotation<RouteDestination>,
  /** The first plan. Revisions live on the attempt that used them. */
  enhancementPrompt: Annotation<EnhancementPrompt | null>,
  /** The plan the next candidate is generated from. */
  activePrompt: Annotation<EnhancementPrompt | null>,
  attempts: Annotation<EnhancementAttempt[]>,
  /** Bytes of the latest candidate; never written to events or the database. */
  candidate: Annotation<ImageBytes | null>,
  finalImage: Annotation<ImageBytes | null>,
  finalCheck: Annotation<FinalCheck | null>,
  /** Set by whichever node ends the run; unset means the loop is still going. */
  outcome: Annotation<RunOutcome | null>,
  outcomeReason: Annotation<string | null>,
  publishedImageUrl: Annotation<string | null>,
});

type ImageQualityState = typeof ImageQualityAnnotation.State;

/**
 * Pulls the image bytes into state. Direct uploads already carry a buffer; a URL
 * is fetched here. This node is the seam where an upstream image service plugs in.
 */
async function resolveImage(
  state: ImageQualityState,
): Promise<Partial<ImageQualityState>> {
  if (state.buffer) {
    return { buffer: state.buffer, mimeType: state.mimeType };
  }

  if (!state.imageUrl) {
    throw new BadRequestException(
      'Provide either an image file or an imageUrl',
    );
  }

  let response: Response;
  try {
    response = await fetch(state.imageUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new BadRequestException(`Could not fetch image at ${state.imageUrl}`);
  }

  if (!response.ok) {
    throw new BadRequestException(
      `Image URL responded with ${response.status} ${response.statusText}`,
    );
  }

  const mimeType = (response.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  if (!SUPPORTED_IMAGE_TYPES.test(mimeType)) {
    throw new BadRequestException(
      `Expected a JPEG, PNG or WebP image but got "${mimeType || 'unknown'}"`,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new BadRequestException(
      `Image exceeds the ${MAX_IMAGE_BYTES} byte limit`,
    );
  }

  return { buffer, mimeType };
}

/** Routes on how sure the model was, so borderline calls can be held back. */
export function routeByConfidence(state: ImageQualityState) {
  return state.assessment.confidence < LOW_CONFIDENCE_THRESHOLD
    ? 'flagForReview'
    : 'label';
}

function toLabel(
  assessment: ImageQualityAssessment,
  needsReview: boolean,
): ImageQualityLabel {
  return {
    label: assessment.decision,
    requiresEnhancement: assessment.decision === 'ENHANCE',
    needsReview,
  };
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const extension = (mimeType: string) =>
  mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';

export function buildImageQualityGraph({
  imageQuality,
  imageRouter,
  imagePrompter,
  imageEnhancer,
  imageQa,
  postProcessor,
  imageStore,
  pipelineLog,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}: ImageGraphDeps) {
  async function assess(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    const assessment = await imageQuality.assessImage(
      state.buffer,
      state.mimeType,
    );
    return { assessment };
  }

  function label(state: ImageQualityState): Partial<ImageQualityState> {
    return { result: toLabel(state.assessment, false) };
  }

  function flagForReview(state: ImageQualityState): Partial<ImageQualityState> {
    return { result: toLabel(state.assessment, true) };
  }

  /** Both labelling paths converge here and hand off to the router. */
  async function dispatch(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    const destination = await imageRouter.route(
      {
        buffer: state.buffer,
        mimeType: state.mimeType,
        imageUrl: state.imageUrl,
        assessment: state.assessment,
        needsReview: state.result.needsReview,
      },
      state.result.label,
    );

    // An unsure assessment stops here: no edit and no publication without a human.
    if (state.result.needsReview) {
      return {
        destination,
        outcome: 'held_for_review',
        outcomeReason: `Assessment confidence ${state.assessment.confidence} is below ${LOW_CONFIDENCE_THRESHOLD}; held for human review before any edit or publication.`,
      };
    }
    return { destination };
  }

  async function preparePrompt(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    const enhancementPrompt = await imagePrompter.generate(
      state.buffer,
      state.mimeType,
      state.assessment,
    );
    return { enhancementPrompt, activePrompt: enhancementPrompt };
  }

  function logged(
    step: string,
    operation: (
      state: ImageQualityState,
    ) => Promise<Partial<ImageQualityState>> | Partial<ImageQualityState>,
    summarize: (result: Partial<ImageQualityState>) => Record<string, unknown>,
    metadata: Record<string, unknown> = {},
  ) {
    return (state: ImageQualityState) =>
      pipelineLog.trace(
        { runId: state.runId, userId: state.userId },
        step,
        () => operation(state),
        summarize,
        metadata,
      );
  }

  /*
   * Second pass. Unlike the first pass, a provider failure here does not fail
   * the run: the assessment and plan are already valid evidence, so the failed
   * hop is logged and the run ends with an `error` outcome instead of a throw.
   */

  /** Agent 3: one candidate per call, stored so its verdict can be audited. */
  async function generate(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    const context = { runId: state.runId, userId: state.userId };
    const iteration = state.attempts.length + 1;
    const attempt: EnhancementAttempt = {
      iteration,
      prompt: state.activePrompt,
      imageUrl: null,
      mimeType: null,
      byteSize: null,
      qa: null,
      error: null,
    };

    let candidate: ImageBytes;
    try {
      candidate = await pipelineLog.trace(
        context,
        'enhance_image',
        () =>
          imageEnhancer.enhance({
            buffer: state.buffer,
            mimeType: state.mimeType,
            prompt: state.activePrompt,
          }),
        (image) => ({
          mimeType: image.mimeType,
          byteSize: image.buffer.byteLength,
        }),
        {
          iteration,
          maxAttempts,
          provider: imageEnhancer.provider,
          model: imageEnhancer.modelName,
        },
      );
    } catch (error) {
      return {
        attempts: [...state.attempts, { ...attempt, error: message(error) }],
        candidate: null,
        outcome: 'error',
        outcomeReason: `Image generation failed on attempt ${iteration}: ${message(error)}`,
      };
    }
    attempt.mimeType = candidate.mimeType;
    attempt.byteSize = candidate.buffer.byteLength;

    try {
      const stored = await pipelineLog.trace(
        context,
        'store_candidate',
        () =>
          imageStore.store(
            candidate.buffer,
            candidate.mimeType,
            `${state.runId}-candidate-${iteration}.${extension(candidate.mimeType)}`,
          ),
        (image) => ({ imageUrl: image.cdnUrl }),
        { iteration },
      );
      attempt.imageUrl = stored.cdnUrl;
    } catch {
      // The failed hop is logged. The candidate can still be judged from memory.
    }

    return { attempts: [...state.attempts, attempt], candidate };
  }

  /** LLM QA on the newest candidate. The service logs its own hop. */
  async function evaluate(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    const attempt = state.attempts[state.attempts.length - 1];
    const settle = (changes: Partial<EnhancementAttempt>) => [
      ...state.attempts.slice(0, -1),
      { ...attempt, ...changes },
    ];

    try {
      const qa = await imageQa.evaluate({
        runId: state.runId,
        userId: state.userId,
        original: { buffer: state.buffer, mimeType: state.mimeType },
        enhanced: { ...state.candidate, iteration: attempt.iteration },
        enhancementPrompt: attempt.prompt,
        needsReview: state.result.needsReview,
      });
      const attempts = settle({ qa });
      if (qa.passed || attempts.length < maxAttempts) return { attempts };

      // Out of attempts. An unsure judge is a human's call, not a rejection.
      return qa.needsReview
        ? {
            attempts,
            outcome: 'held_for_review',
            outcomeReason: `The QA judge was not confident about candidate ${attempt.iteration} and no attempts remain; held for human review.`,
          }
        : {
            attempts,
            outcome: 'rejected',
            outcomeReason: `No candidate passed QA within ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}.`,
          };
    } catch (error) {
      // A judge that did not answer has not passed anything.
      return {
        attempts: settle({ error: message(error) }),
        outcome: 'error',
        outcomeReason: `QA failed on attempt ${attempt.iteration}: ${message(error)}`,
      };
    }
  }

  /** Feeds the failed verdict back into prompting for the next attempt. */
  async function revisePrompt(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    const attempt = state.attempts[state.attempts.length - 1];
    try {
      return await pipelineLog.trace(
        { runId: state.runId, userId: state.userId },
        'revise_prompt',
        async () => ({
          activePrompt: await imagePrompter.revise(
            state.buffer,
            state.mimeType,
            state.assessment,
            attempt.prompt,
            attempt.qa,
          ),
        }),
        (result) => ({ enhancementPrompt: result.activePrompt }),
        {
          iteration: attempt.iteration + 1,
          model: imagePrompter.modelName,
          promptVersion: imagePrompter.revisionVersion,
        },
      );
    } catch (error) {
      return {
        outcome: 'error',
        outcomeReason: `Prompt revision failed after attempt ${attempt.iteration}: ${message(error)}`,
      };
    }
  }

  /** Normalises the accepted candidate and runs the deterministic final check. */
  async function postProcess(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    const iteration = state.attempts.length;
    try {
      const { finalCheck, ...finalImage } = await pipelineLog.trace(
        { runId: state.runId, userId: state.userId },
        'post_process',
        () =>
          postProcessor.finalize(
            { buffer: state.buffer, mimeType: state.mimeType },
            state.candidate,
          ),
        (image) => ({
          finalCheck: image.finalCheck,
          mimeType: image.mimeType,
          byteSize: image.buffer.byteLength,
        }),
        { iteration, policyVersion: postProcessor.policyVersion },
      );
      if (finalCheck.passed) return { finalCheck, finalImage };

      const failed = finalCheck.checks
        .filter((check) => !check.passed)
        .map((check) => check.name)
        .join(', ');
      return {
        finalCheck,
        outcome: 'rejected',
        outcomeReason: `Candidate ${iteration} passed QA but failed the final check: ${failed}.`,
      };
    } catch (error) {
      return {
        outcome: 'error',
        outcomeReason: `Post-processing failed: ${message(error)}`,
      };
    }
  }

  /** The catalogue hand-off, for an approved candidate or a confident KEEP. */
  async function publish(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    const enhanced = state.destination === 'enhance';
    try {
      const { publishedImageUrl } = await pipelineLog.trace(
        { runId: state.runId, userId: state.userId },
        'publish',
        async () => {
          // A KEEP that already has a URL is published where it is.
          if (!enhanced && state.imageUrl) {
            return { publishedImageUrl: state.imageUrl };
          }
          const image = enhanced
            ? state.finalImage
            : { buffer: state.buffer, mimeType: state.mimeType };
          const stored = await imageStore.store(
            image.buffer,
            image.mimeType,
            `${state.runId}-${enhanced ? 'enhanced' : 'original'}.${extension(image.mimeType)}`,
          );
          return { publishedImageUrl: stored.cdnUrl };
        },
        (result) => result,
        { kind: enhanced ? 'enhanced' : 'original' },
      );
      return {
        publishedImageUrl,
        outcome: enhanced ? 'published_enhanced' : 'published_original',
        outcomeReason: enhanced
          ? `Candidate ${state.attempts.length} passed QA and the final check.`
          : 'Confident KEEP: published as uploaded.',
      };
    } catch (error) {
      return {
        outcome: 'error',
        outcomeReason: `Publishing failed: ${message(error)}`,
      };
    }
  }

  /** A node that set an outcome has ended the run. */
  const unlessSettled = (next: string) => (state: ImageQualityState) =>
    state.outcome ? END : next;

  const workflow = new StateGraph(ImageQualityAnnotation)
    .addNode(
      'resolveImage',
      logged('resolve_image', resolveImage, (s) => ({
        mimeType: s.mimeType,
        byteSize: s.buffer?.byteLength,
      })),
    )
    .addNode(
      'assess',
      logged('assess_quality', assess, (s) => ({ assessment: s.assessment }), {
        model: imageQuality.modelName,
      }),
    )
    .addNode(
      'label',
      logged('label', label, (s) => ({ ...s.result })),
    )
    .addNode(
      'flagForReview',
      logged('flag_for_review', flagForReview, (s) => ({ ...s.result })),
    )
    .addNode(
      'dispatch',
      logged('route', dispatch, (s) => ({ destination: s.destination })),
    )
    .addNode(
      'preparePrompt',
      logged(
        'prepare_prompt',
        preparePrompt,
        (s) => ({ enhancementPrompt: s.enhancementPrompt }),
        {
          model: imagePrompter.modelName,
          promptVersion: imagePrompter.promptVersion,
        },
      ),
    )
    .addNode('generate', generate)
    .addNode('evaluate', evaluate)
    .addNode('revisePrompt', revisePrompt)
    .addNode('postProcess', postProcess)
    .addNode('publish', publish)
    .addEdge(START, 'resolveImage')
    .addEdge('resolveImage', 'assess')
    .addConditionalEdges('assess', routeByConfidence, [
      'label',
      'flagForReview',
    ])
    .addEdge('label', 'dispatch')
    .addEdge('flagForReview', 'dispatch')
    .addConditionalEdges(
      'dispatch',
      (state) => {
        // A held ENHANCE still gets a draft plan for the reviewer; nothing more.
        if (state.destination === 'enhance') return 'preparePrompt';
        return state.outcome ? END : 'publish';
      },
      ['preparePrompt', 'publish', END],
    )
    .addConditionalEdges('preparePrompt', unlessSettled('generate'), [
      'generate',
      END,
    ])
    .addConditionalEdges('generate', unlessSettled('evaluate'), [
      'evaluate',
      END,
    ])
    .addConditionalEdges(
      'evaluate',
      (state) => {
        if (state.outcome) return END;
        return state.attempts[state.attempts.length - 1].qa.passed
          ? 'postProcess'
          : 'revisePrompt';
      },
      ['postProcess', 'revisePrompt', END],
    )
    .addConditionalEdges('revisePrompt', unlessSettled('generate'), [
      'generate',
      END,
    ])
    .addConditionalEdges('postProcess', unlessSettled('publish'), [
      'publish',
      END,
    ])
    .addEdge('publish', END);

  return workflow.compile();
}
