import { PipelineLogService } from '../assessments/pipeline-log.service';
import { ImageQaInput, summarizeQaIterations } from './image-qa.schema';
import { ImageQaService } from './image-qa.service';

const invoke = jest.fn();
jest.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    withStructuredOutput: () => ({ invoke }),
  })),
}));

describe('ImageQaService', () => {
  const input: ImageQaInput = {
    runId: 'f723a112-ab14-4f47-912c-c268d42a5097',
    userId: 'user-1',
    original: { buffer: Buffer.from('original'), mimeType: 'image/png' },
    enhanced: {
      buffer: Buffer.from('enhanced'),
      mimeType: 'image/jpeg',
      iteration: 1,
    },
    enhancementPrompt: {
      prompt: 'Lift shadows',
      edits: [{ issue: 'dark', instruction: 'Lift shadows', priority: 'high' }],
      preserve: ['Ingredients'],
      negativePrompt: 'No new food',
    },
    needsReview: false,
  };
  const evidence = {
    confidence: 0.95,
    scores: {
      improvement: 0.8,
      editAdherence: 0.9,
      preservation: 1,
      artifactFree: 1,
    },
    improved: true,
    preservationViolations: [],
    issues: [],
    reason: 'Shadows lifted; ingredients and portions preserved.',
  };
  let service: ImageQaService;
  let record: jest.SpyInstance;

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(evidence);
    const log = new PipelineLogService({} as never);
    record = jest.spyOn(log, 'record').mockResolvedValue(undefined);
    service = new ImageQaService(log);
  });

  it('compares both images in order, passes good work and persists evidence without image bytes', async () => {
    const result = await service.evaluate(input);
    expect(result).toMatchObject({
      passed: true,
      iteration: 1,
      confidence: 0.95,
      needsReview: false,
    });
    const [system, human] = invoke.mock.calls[0][0];
    expect(system.content).toContain('untrusted evidence');
    expect(human.content[0].text).toContain(
      JSON.stringify(input.enhancementPrompt),
    );
    expect(human.content.slice(1)).toEqual(
      [input.original, input.enhanced].map((image) => ({
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}`,
        },
      })),
    );
    expect(record.mock.calls[0][0]).toMatchObject({
      runId: input.runId,
      userId: input.userId,
      step: 'evaluate_enhancement',
      status: 'started',
      metadata: { iteration: 1 },
    });
    expect(record.mock.calls[1][0]).toMatchObject({
      status: 'completed',
      hopId: record.mock.calls[0][0].hopId,
      latencyMs: expect.any(Number),
      metadata: { qa: result },
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('base64');
    expect(JSON.stringify(record.mock.calls)).not.toContain('buffer');
  });

  it.each([
    { confidence: 0.59 },
    { improved: false },
    { preservationViolations: ['Added garnish'] },
    ...['improvement', 'editAdherence', 'preservation', 'artifactFree'].map(
      (dimension) => ({ scores: { ...evidence.scores, [dimension]: 0.1 } }),
    ),
  ])('rejects deficient evidence: %j', async (change) => {
    invoke.mockResolvedValue({ ...evidence, ...change });
    expect((await service.evaluate(input)).passed).toBe(false);
  });

  it('preserves upstream review holds even when QA is confident', async () => {
    expect(
      await service.evaluate({ ...input, needsReview: true }),
    ).toMatchObject({ passed: false, needsReview: true });
  });

  it('flags uncertain QA for review', async () => {
    invoke.mockResolvedValue({ ...evidence, confidence: 0.59 });
    expect(await service.evaluate(input)).toMatchObject({
      passed: false,
      needsReview: true,
    });
  });

  it.each([{}, { ...evidence, confidence: 2 }])(
    'logs malformed model output as failure',
    async (output) => {
      invoke.mockResolvedValue(output);
      await expect(service.evaluate(input)).rejects.toThrow();
      expect(record.mock.calls[1][0]).toMatchObject({
        status: 'failed',
        metadata: { iteration: 1 },
      });
    },
  );

  it('propagates provider failures with a failed hop', async () => {
    invoke.mockRejectedValue(new Error('provider unavailable'));
    await expect(service.evaluate(input)).rejects.toThrow(
      'provider unavailable',
    );
    expect(record.mock.calls[1][0]).toMatchObject({
      status: 'failed',
      errorMessage: 'provider unavailable',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...input.enhanced, iteration: 0 },
    { ...input.enhanced, iteration: 1.5 },
    { ...input.enhanced, buffer: Buffer.alloc(0) },
    { ...input.enhanced, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) },
    { ...input.enhanced, mimeType: 'text/plain' },
  ])('validates enhancer output before invoking Gemini', async (enhanced) => {
    await expect(service.evaluate({ ...input, enhanced })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(record.mock.calls[1][0].status).toBe('failed');
  });

  it('distinguishes confidence at k, passing at k and passing by k', async () => {
    const pass = await service.evaluate(input);
    const fail = { ...pass, passed: false, confidence: 0.7 };
    expect(
      summarizeQaIterations([
        fail,
        { ...pass, iteration: 2 },
        { ...fail, iteration: 3 },
      ]),
    ).toEqual({
      runId: input.runId,
      k: 3,
      confidenceAtK: 0.7,
      passedAtK: false,
      passedByK: true,
      firstPassedIteration: 2,
    });
    expect(summarizeQaIterations([fail])).toMatchObject({
      passedByK: false,
      firstPassedIteration: null,
    });
    expect(() => summarizeQaIterations([])).toThrow();
    expect(() => summarizeQaIterations([{ ...pass, iteration: 2 }])).toThrow();
    expect(() => summarizeQaIterations([pass, pass])).toThrow();
    expect(() =>
      summarizeQaIterations([pass, { ...pass, iteration: 2, runId: 'other' }]),
    ).toThrow();
  });
});
