import { EnhancementSummary } from '../agent/enhancement.types';
import { ImageQaResult } from '../image-qa/image-qa.schema';
import { summarizeEvals } from './eval-summary';

const plan = {
  prompt: 'Brighten.',
  edits: [
    { issue: 'dark', instruction: 'Lift shadows.', priority: 'high' as const },
  ],
  preserve: ['The dish'],
  negativePrompt: 'No new food.',
};

function qa(
  iteration: number,
  passed: boolean,
  scores: Partial<ImageQaResult['scores']> = {},
): ImageQaResult {
  return {
    runId: 'run',
    iteration,
    passed,
    needsReview: false,
    policyVersion: 'fixture',
    confidence: 0.9,
    scores: {
      improvement: 0.9,
      editAdherence: 0.9,
      preservation: 0.95,
      artifactFree: 0.95,
      ...scores,
    },
    improved: passed,
    preservationViolations: [],
    issues: [],
    reason: 'fixture',
  };
}

/** A run whose attempts got these verdicts; null is a judge or provider error. */
function run(
  verdicts: (ImageQaResult | null)[],
  maxAttempts = 3,
): { enhancement: EnhancementSummary } {
  return {
    enhancement: {
      provider: 'fixture',
      model: 'fixture',
      maxAttempts,
      attempts: verdicts.map((verdict, index) => ({
        iteration: index + 1,
        prompt: plan,
        imageUrl: null,
        mimeType: null,
        byteSize: null,
        qa: verdict,
        error: verdict ? null : 'provider error',
      })),
      passedIteration: verdicts.find((verdict) => verdict?.passed)?.iteration,
      finalCheck: null,
    },
  };
}

const row = (overrides: Record<string, unknown> = {}) =>
  ({
    status: 'completed',
    label: 'ENHANCE',
    needsReview: false,
    outcome: null,
    enhancement: null,
    humanLabel: null,
    ...overrides,
  }) as Parameters<typeof summarizeEvals>[0][number];

describe('summarizeEvals', () => {
  it('reports an empty cohort without dividing by zero', () => {
    const summary = summarizeEvals([]);
    expect(summary.passAtK).toMatchObject({ cohort: 0, maxK: 0, overall: [] });
    expect(summary.confusion).toMatchObject({
      labelled: 0,
      accuracy: null,
      precision: null,
      recall: null,
    });
  });

  it('computes pass-by-k cumulatively: a pass at k counts for every larger k', () => {
    const { passAtK } = summarizeEvals([
      row(run([qa(1, true)])),
      row(run([qa(1, false), qa(2, true)])),
      row(run([qa(1, false), qa(2, false), qa(3, false)])),
      row(run([qa(1, false), qa(2, false), qa(3, true)])),
    ]);
    expect(passAtK.cohort).toBe(4);
    expect(passAtK.maxK).toBe(3);
    expect(passAtK.overall).toEqual([
      { k: 1, cohort: 4, passed: 1, rate: 0.25 },
      { k: 2, cohort: 4, passed: 2, rate: 0.5 },
      { k: 3, cohort: 4, passed: 3, rate: 0.75 },
    ]);
  });

  it('never counts an attempt without a verdict as a pass, and ignores runs with no verdict at all', () => {
    const { passAtK } = summarizeEvals([
      row(run([qa(1, false), null])),
      row(run([null])),
      row({ label: 'KEEP' }),
    ]);
    expect(passAtK.cohort).toBe(1);
    expect(passAtK.overall.map((point) => point.passed)).toEqual([0, 0, 0]);
  });

  it('only measures k against runs that had a budget of at least k', () => {
    const { passAtK } = summarizeEvals([
      row(run([qa(1, true)], 1)),
      row(run([qa(1, false), qa(2, false), qa(3, true)], 3)),
    ]);
    expect(passAtK.overall).toEqual([
      { k: 1, cohort: 2, passed: 1, rate: 0.5 },
      { k: 2, cohort: 1, passed: 0, rate: 0 },
      { k: 3, cohort: 1, passed: 1, rate: 1 },
    ]);
  });

  it('scores each QA goal against its own threshold', () => {
    const { passAtK } = summarizeEvals([
      row(
        run([
          qa(1, false, { preservation: 0.5 }),
          qa(2, false, { preservation: 0.92, improvement: 0.4 }),
        ]),
      ),
    ]);
    expect(passAtK.goals.preservation.map((p) => p.passed)).toEqual([0, 1, 1]);
    // Improvement was met on attempt 1 and stays met, though attempt 2 lost it.
    expect(passAtK.goals.improvement.map((p) => p.passed)).toEqual([1, 1, 1]);
    expect(passAtK.overall.map((p) => p.passed)).toEqual([0, 0, 0]);
  });

  it('builds the confusion matrix from labelled, completed runs with ENHANCE as positive', () => {
    const { confusion, runs, outcomes } = summarizeEvals([
      row({ label: 'ENHANCE', humanLabel: 'ENHANCE' }),
      row({ label: 'ENHANCE', humanLabel: 'ENHANCE' }),
      row({ label: 'ENHANCE', humanLabel: 'KEEP', outcome: 'rejected' }),
      row({ label: 'KEEP', humanLabel: 'ENHANCE' }),
      row({ label: 'KEEP', humanLabel: 'KEEP', outcome: 'published_original' }),
      row({ label: 'KEEP' }),
      row({ status: 'failed', label: null, humanLabel: 'KEEP' }),
    ]);
    expect(confusion).toEqual({
      labelled: 5,
      truePositive: 2,
      falsePositive: 1,
      falseNegative: 1,
      trueNegative: 1,
      accuracy: 3 / 5,
      precision: 2 / 3,
      recall: 2 / 3,
    });
    expect(runs).toMatchObject({ total: 7, completed: 6, failed: 1 });
    expect(outcomes).toMatchObject({ rejected: 1, published_original: 1 });
  });
});
