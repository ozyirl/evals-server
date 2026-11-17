import { randomUUID } from 'node:crypto';
import { ImageAgentService } from './image-agent.service';
import {
  ImageQualityService,
  ImageQualityAssessment,
} from '../image-quality/image-quality.service';
import { ImagePrompterService } from '../image-prompter/image-prompter.service';
import { ImageRouterService } from '../routing/image-router.service';
import { AssessmentLogService } from '../assessments/assessment-log.service';
import { PipelineLogService } from '../assessments/pipeline-log.service';
import { NewPipelineEvent } from '../db/schema';
import { ImageEnhancerService } from '../image-enhancer/image-enhancer.service';
import { ImagePostProcessService } from '../image-postprocess/image-postprocess.service';
import { ImageQaService } from '../image-qa/image-qa.service';
import { ImageQaResult } from '../image-qa/image-qa.schema';
import { ImageStoreService } from '../storage/image-store.service';

const assessment: ImageQualityAssessment = {
  decision: 'ENHANCE',
  confidence: 0.9,
  scores: {
    lighting: 3,
    sharpness: 8,
    composition: 8,
    background: 8,
    color: 7,
    overall: 5,
  },
  issues: ['underexposure'],
  reason: 'The dish is too dark.',
};
const prompt = {
  prompt: 'Brighten the food photo without altering the dish.',
  edits: [
    {
      issue: 'underexposure',
      instruction: 'Lift shadows gently.',
      priority: 'high' as const,
    },
  ],
  preserve: ['Ingredients and portions'],
  negativePrompt: 'No added food or text.',
};

const revisedPrompt = {
  ...prompt,
  prompt: 'Brighten more gently and keep the plate rim untouched.',
};
const candidate = {
  buffer: Buffer.from('candidate-image'),
  mimeType: 'image/jpeg',
};
const finalImage = {
  buffer: Buffer.from('final-image'),
  mimeType: 'image/jpeg',
};
const passingCheck = {
  passed: true,
  checks: [{ name: 'decodes', passed: true, detail: 'ok' }],
};

function verdict(
  iteration: number,
  overrides: Partial<ImageQaResult> = {},
): ImageQaResult {
  return {
    runId: 'set-by-the-judge',
    iteration,
    passed: true,
    needsReview: false,
    policyVersion: 'fixture-policy',
    confidence: 0.9,
    scores: {
      improvement: 0.9,
      editAdherence: 0.9,
      preservation: 0.95,
      artifactFree: 0.95,
    },
    improved: true,
    preservationViolations: [],
    issues: [],
    reason: 'Brighter, same dish.',
    ...overrides,
  };
}
const failing = (iteration: number, overrides: Partial<ImageQaResult> = {}) =>
  verdict(iteration, {
    passed: false,
    improved: false,
    reason: 'Still too dark.',
    ...overrides,
  });

describe('image pipeline', () => {
  const file = { buffer: Buffer.from('fixture-image'), mimeType: 'image/png' };
  let enhancer: { provider: string; modelName: string; enhance: jest.Mock };
  let qa: { evaluate: jest.Mock };
  let postProcessor: { policyVersion: string; finalize: jest.Mock };
  let store: { store: jest.Mock };
  let service: ImageAgentService;
  let events: NewPipelineEvent[];
  let quality: { modelName: string; assessImage: jest.Mock };
  let prompter: {
    modelName: string;
    promptVersion: string;
    revisionVersion: string;
    generate: jest.Mock;
    revise: jest.Mock;
  };
  let log: { record: jest.Mock };

  beforeEach(() => {
    events = [];
    const pipelineLog = new PipelineLogService({
      insert: () => ({
        values: async (event: NewPipelineEvent) => {
          events.push(event);
        },
      }),
    } as never);
    quality = {
      modelName: 'quality-fixture',
      assessImage: jest.fn().mockResolvedValue(assessment),
    };
    prompter = {
      modelName: 'prompter-fixture',
      promptVersion: '1',
      revisionVersion: 'revise-fixture',
      generate: jest.fn().mockResolvedValue(prompt),
      revise: jest.fn().mockResolvedValue(revisedPrompt),
    };
    log = { record: jest.fn().mockResolvedValue(true) };
    enhancer = {
      provider: 'fixture',
      modelName: 'enhancer-fixture',
      enhance: jest.fn().mockResolvedValue(candidate),
    };
    qa = {
      evaluate: jest.fn(async (input) => verdict(input.enhanced.iteration)),
    };
    postProcessor = {
      policyVersion: 'final-fixture',
      finalize: jest
        .fn()
        .mockResolvedValue({ ...finalImage, finalCheck: passingCheck }),
    };
    store = {
      store: jest.fn(async (_buffer, _mimeType, fileName: string) => ({
        uuid: fileName,
        cdnUrl: `https://cdn.example.test/${fileName}`,
      })),
    };
    service = new ImageAgentService(
      quality as unknown as ImageQualityService,
      log as unknown as AssessmentLogService,
      new ImageRouterService(),
      prompter as unknown as ImagePrompterService,
      pipelineLog,
      enhancer as unknown as ImageEnhancerService,
      qa as unknown as ImageQaService,
      postProcessor as unknown as ImagePostProcessService,
      store as unknown as ImageStoreService,
    );
  });

  it('generates and persists an ENHANCE prompt, with paired logs for every hop and no image bytes in events', async () => {
    const result = await service.assessImage(file, {
      userId: 'test-user',
      fileName: 'food.png',
    });
    expect(result).toMatchObject({
      destination: 'enhance',
      enhancementPrompt: prompt,
      needsReview: false,
    });
    expect(prompter.generate).toHaveBeenCalledWith(
      file.buffer,
      file.mimeType,
      assessment,
    );
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        id: result.runId,
        enhancementPrompt: prompt,
        status: 'completed',
      }),
    );
    expect(
      events.filter((e) => e.status === 'started').map((e) => e.step),
    ).toEqual([
      'image_pipeline',
      'resolve_image',
      'assess_quality',
      'label',
      'route',
      'prepare_prompt',
      'enhance_image',
      'store_candidate',
      'post_process',
      'publish',
      'persist_assessment',
    ]);
    for (const start of events.filter((e) => e.status === 'started')) {
      expect(
        events.filter((e) => e.hopId === start.hopId).map((e) => e.status),
      ).toEqual(['started', 'completed']);
    }
    expect(
      events.every((e) => e.runId === result.runId && e.userId === 'test-user'),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(
      file.buffer.toString('base64'),
    );
    expect(JSON.stringify(events)).not.toContain(
      candidate.buffer.toString('base64'),
    );
  });

  it('publishes a candidate that passes QA and the final check on the first attempt', async () => {
    const result = await service.assessImage(file, { userId: 'test-user' });

    expect(result.outcome).toBe('published_enhanced');
    expect(result.publishedImageUrl).toBe(
      `https://cdn.example.test/${result.runId}-enhanced.jpg`,
    );
    expect(result.enhancement).toMatchObject({
      provider: 'fixture',
      model: 'enhancer-fixture',
      maxAttempts: 3,
      passedIteration: 1,
      finalCheck: passingCheck,
    });
    expect(result.enhancement.attempts).toEqual([
      expect.objectContaining({
        iteration: 1,
        prompt,
        imageUrl: `https://cdn.example.test/${result.runId}-candidate-1.jpg`,
        byteSize: candidate.buffer.byteLength,
        qa: expect.objectContaining({ passed: true }),
        error: null,
      }),
    ]);
    // The judge compares the candidate with the original, under the plan used.
    expect(qa.evaluate).toHaveBeenCalledWith({
      runId: result.runId,
      userId: 'test-user',
      original: file,
      enhanced: { ...candidate, iteration: 1 },
      enhancementPrompt: prompt,
      needsReview: false,
    });
    // What is published is the post-processed image, not the raw candidate.
    expect(store.store).toHaveBeenLastCalledWith(
      finalImage.buffer,
      'image/jpeg',
      `${result.runId}-enhanced.jpg`,
    );
    expect(prompter.revise).not.toHaveBeenCalled();
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'published_enhanced',
        publishedImageUrl: result.publishedImageUrl,
        enhancement: result.enhancement,
      }),
    );
  });

  it('feeds a failed verdict back into prompting and retries from the original', async () => {
    const firstVerdict = failing(1);
    qa.evaluate
      .mockResolvedValueOnce(firstVerdict)
      .mockResolvedValueOnce(verdict(2));

    const result = await service.assessImage(file, { userId: 'test-user' });

    expect(prompter.revise).toHaveBeenCalledTimes(1);
    expect(prompter.revise).toHaveBeenCalledWith(
      file.buffer,
      file.mimeType,
      assessment,
      prompt,
      firstVerdict,
    );
    expect(enhancer.enhance).toHaveBeenNthCalledWith(1, { ...file, prompt });
    expect(enhancer.enhance).toHaveBeenNthCalledWith(2, {
      ...file,
      prompt: revisedPrompt,
    });
    expect(result.outcome).toBe('published_enhanced');
    expect(result.enhancement.passedIteration).toBe(2);
    expect(result.enhancement.attempts.map((a) => a.prompt)).toEqual([
      prompt,
      revisedPrompt,
    ]);
    // The API keeps reporting the first plan; revisions live on the attempts.
    expect(result.enhancementPrompt).toEqual(prompt);
    expect(
      events.filter((e) => e.step === 'revise_prompt').map((e) => e.status),
    ).toEqual(['started', 'completed']);
  });

  it('rejects the run when no candidate passes within the attempt budget', async () => {
    qa.evaluate.mockImplementation(async (input) =>
      failing(input.enhanced.iteration),
    );

    const result = await service.assessImage(file, { userId: 'test-user' });

    expect(result.outcome).toBe('rejected');
    expect(result.outcomeReason).toContain('3 attempts');
    expect(result.publishedImageUrl).toBeNull();
    expect(result.enhancement.passedIteration).toBeNull();
    expect(enhancer.enhance).toHaveBeenCalledTimes(3);
    // No revision after the last attempt: there is nothing left to spend it on.
    expect(prompter.revise).toHaveBeenCalledTimes(2);
    expect(postProcessor.finalize).not.toHaveBeenCalled();
    expect(events.some((e) => e.step === 'publish')).toBe(false);
  });

  it('holds the run for a human when the judge stays unsure', async () => {
    qa.evaluate.mockImplementation(async (input) =>
      failing(input.enhanced.iteration, { needsReview: true, confidence: 0.3 }),
    );

    const result = await service.assessImage(file, { userId: 'test-user' });

    expect(result.outcome).toBe('held_for_review');
    expect(result.publishedImageUrl).toBeNull();
  });

  it('refuses to publish a QA-approved candidate that fails the final check', async () => {
    postProcessor.finalize.mockResolvedValue({
      ...finalImage,
      finalCheck: {
        passed: false,
        checks: [{ name: 'aspect_ratio', passed: false, detail: '40% drift' }],
      },
    });

    const result = await service.assessImage(file, { userId: 'test-user' });

    expect(result.outcome).toBe('rejected');
    expect(result.outcomeReason).toContain('aspect_ratio');
    expect(result.enhancement.passedIteration).toBe(1);
    expect(result.publishedImageUrl).toBeNull();
    expect(events.some((e) => e.step === 'publish')).toBe(false);
  });

  it('keeps first-pass evidence when image generation fails', async () => {
    enhancer.enhance.mockRejectedValue(new Error('FAL_KEY is not configured'));

    const result = await service.assessImage(file, { userId: 'test-user' });

    expect(result.outcome).toBe('error');
    expect(result.outcomeReason).toContain('FAL_KEY is not configured');
    expect(result.enhancementPrompt).toEqual(prompt);
    expect(result.enhancement.attempts).toEqual([
      expect.objectContaining({
        iteration: 1,
        qa: null,
        error: 'FAL_KEY is not configured',
      }),
    ]);
    expect(qa.evaluate).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: 'enhance_image', status: 'failed' }),
        expect.objectContaining({
          step: 'image_pipeline',
          status: 'completed',
        }),
      ]),
    );
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', outcome: 'error' }),
    );
  });

  it('does not count a judge failure as a pass', async () => {
    qa.evaluate.mockRejectedValue(new Error('Judge unavailable'));

    const result = await service.assessImage(file, { userId: 'test-user' });

    expect(result.outcome).toBe('error');
    expect(result.enhancement.passedIteration).toBeNull();
    expect(result.enhancement.attempts[0]).toMatchObject({
      qa: null,
      error: 'Judge unavailable',
    });
    expect(enhancer.enhance).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.step === 'publish')).toBe(false);
  });

  it('still judges a candidate whose storage failed', async () => {
    store.store.mockRejectedValueOnce(new Error('CDN down'));

    const result = await service.assessImage(file, { userId: 'test-user' });

    expect(result.enhancement.attempts[0].imageUrl).toBeNull();
    expect(result.outcome).toBe('published_enhanced');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: 'store_candidate',
          status: 'failed',
          errorMessage: 'CDN down',
        }),
      ]),
    );
  });

  it('publishes a confident KEEP as uploaded, at its existing URL when it has one', async () => {
    quality.assessImage.mockResolvedValue({ ...assessment, decision: 'KEEP' });

    const hosted = await service.assessImage(file, {
      userId: 'test-user',
      imageUrl: 'https://example.com/stored.png',
    });
    expect(hosted.outcome).toBe('published_original');
    expect(hosted.publishedImageUrl).toBe('https://example.com/stored.png');
    expect(store.store).not.toHaveBeenCalled();

    const direct = await service.assessImage(file, { userId: 'test-user' });
    expect(direct.publishedImageUrl).toBe(
      `https://cdn.example.test/${direct.runId}-original.png`,
    );
    expect(store.store).toHaveBeenCalledWith(
      file.buffer,
      file.mimeType,
      `${direct.runId}-original.png`,
    );
    expect(direct.enhancement).toBeNull();
    expect(enhancer.enhance).not.toHaveBeenCalled();
  });

  it('holds a low-confidence KEEP instead of publishing it', async () => {
    quality.assessImage.mockResolvedValue({
      ...assessment,
      decision: 'KEEP',
      confidence: 0.2,
    });

    const result = await service.assessImage(file, { userId: 'test-user' });

    expect(result.outcome).toBe('held_for_review');
    expect(result.publishedImageUrl).toBeNull();
    expect(events.some((e) => e.step === 'publish')).toBe(false);
  });

  it('does not call the prompter for KEEP', async () => {
    quality.assessImage.mockResolvedValue({ ...assessment, decision: 'KEEP' });
    const result = await service.assessImage(file, { userId: 'test-user' });
    expect(result.enhancementPrompt).toBeNull();
    expect(result.destination).toBe('keep');
    expect(prompter.generate).not.toHaveBeenCalled();
    expect(events.some((e) => e.step === 'prepare_prompt')).toBe(false);
  });

  it('retains the human-review flag on low-confidence ENHANCE runs', async () => {
    quality.assessImage.mockResolvedValue({ ...assessment, confidence: 0.2 });
    const result = await service.assessImage(file, { userId: 'test-user' });
    expect(result.needsReview).toBe(true);
    expect(
      events.some(
        (e) => e.step === 'flag_for_review' && e.status === 'completed',
      ),
    ).toBe(true);
    // A held run gets a draft plan for the reviewer, and no edit is paid for.
    expect(result.enhancementPrompt).toEqual(prompt);
    expect(result.outcome).toBe('held_for_review');
    expect(result.enhancement).toBeNull();
    expect(enhancer.enhance).not.toHaveBeenCalled();
    expect(store.store).not.toHaveBeenCalled();
  });

  it('records a prompter failure and preserves earlier quality evidence', async () => {
    const failure = new Error('Model unavailable');
    prompter.generate.mockRejectedValue(failure);
    await expect(
      service.assessImage(file, { userId: 'test-user' }),
    ).rejects.toThrow('Model unavailable');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: 'prepare_prompt',
          status: 'failed',
          errorMessage: 'Model unavailable',
        }),
        expect.objectContaining({ step: 'image_pipeline', status: 'failed' }),
        expect.objectContaining({
          step: 'assess_quality',
          status: 'completed',
          metadata: expect.objectContaining({ assessment }),
        }),
      ]),
    );
    expect(log.record).toHaveBeenCalledTimes(1);
    expect(log.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'Model unavailable',
      }),
    );
  });

  it('records resolution failures without invoking either model', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('not found', { status: 404 }));
    try {
      await expect(
        service.assessImage(
          { imageUrl: 'https://example.com/missing.png' },
          { userId: 'test-user' },
        ),
      ).rejects.toThrow('404');
      expect(quality.assessImage).not.toHaveBeenCalled();
      expect(prompter.generate).not.toHaveBeenCalled();
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ step: 'resolve_image', status: 'failed' }),
        ]),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reports a persistence failure without discarding a finished result', async () => {
    log.record.mockResolvedValue(false);
    const result = await service.assessImage(file, { userId: 'test-user' });
    expect(result.enhancementPrompt).toEqual(prompt);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          step: 'persist_assessment',
          status: 'failed',
        }),
      ]),
    );
    expect(
      events.some(
        (e) => e.step === 'persist_assessment' && e.status === 'completed',
      ),
    ).toBe(false);
  });

  it('keeps concurrent runs isolated', async () => {
    const runId = randomUUID();
    const [first, second] = await Promise.all([
      service.assessImage(file, { userId: 'first', runId }),
      service.assessImage(file, { userId: 'second' }),
    ]);
    expect(first.runId).toBe(runId);
    expect(second.runId).not.toBe(runId);
    expect(
      events
        .filter((e) => e.runId === first.runId)
        .every((e) => e.userId === 'first'),
    ).toBe(true);
    expect(
      events
        .filter((e) => e.runId === second.runId)
        .every((e) => e.userId === 'second'),
    ).toBe(true);
  });

  it('preserves an Uploadcare URL for downstream routing without re-fetching the supplied bytes', async () => {
    const route = jest.spyOn(ImageRouterService.prototype, 'route');
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      await service.assessImage(file, {
        userId: 'test-user',
        imageUrl: 'https://example.com/stored.png',
      });
      expect(route).toHaveBeenCalledWith(
        expect.objectContaining({
          imageUrl: 'https://example.com/stored.png',
          buffer: file.buffer,
        }),
        'ENHANCE',
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      route.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});
