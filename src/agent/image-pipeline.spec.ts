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

describe('image pipeline', () => {
  const file = { buffer: Buffer.from('fixture-image'), mimeType: 'image/png' };
  let service: ImageAgentService;
  let events: NewPipelineEvent[];
  let quality: { modelName: string; assessImage: jest.Mock };
  let prompter: {
    modelName: string;
    promptVersion: string;
    generate: jest.Mock;
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
      generate: jest.fn().mockResolvedValue(prompt),
    };
    log = { record: jest.fn().mockResolvedValue(true) };
    service = new ImageAgentService(
      quality as unknown as ImageQualityService,
      log as unknown as AssessmentLogService,
      new ImageRouterService(),
      prompter as unknown as ImagePrompterService,
      pipelineLog,
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
