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

/** Assessments below this confidence are flagged for a human instead of auto-labelled. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

const FETCH_TIMEOUT_MS = 10_000;

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
  enhancementPrompt: Annotation<EnhancementPrompt | null>,
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

export function buildImageQualityGraph(
  imageQualityService: ImageQualityService,
  imageRouter: ImageRouterService,
  imagePrompter: ImagePrompterService,
  pipelineLog: PipelineLogService,
) {
  async function assess(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    const assessment = await imageQualityService.assessImage(
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

    return { destination };
  }

  async function preparePrompt(
    state: ImageQualityState,
  ): Promise<Partial<ImageQualityState>> {
    return {
      enhancementPrompt: await imagePrompter.generate(
        state.buffer,
        state.mimeType,
        state.assessment,
      ),
    };
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
        model: imageQualityService.modelName,
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
      (state) => (state.destination === 'enhance' ? 'preparePrompt' : END),
      ['preparePrompt', END],
    )
    .addEdge('preparePrompt', END);

  return workflow.compile();
}
