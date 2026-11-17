import type { RunOutcome } from '../agent/enhancement.types';
import type { ImageQaResult } from '../image-qa/image-qa.schema';
import type { ImageAssessmentRow } from '../db/schema';

/**
 * Per-goal acceptance thresholds. Mirrors IMAGE_QA_POLICY; kept as plain data
 * so the eval layer does not pull in the judge's model client.
 */
export const QA_GOAL_THRESHOLDS = {
  improvement: 0.7,
  editAdherence: 0.8,
  preservation: 0.9,
  artifactFree: 0.9,
} as const;

export type QaGoal = keyof typeof QA_GOAL_THRESHOLDS;

export interface KPoint {
  k: number;
  /** Runs with an attempt budget of at least k: the denominator for this k. */
  cohort: number;
  passed: number;
  rate: number;
}

export interface EvalSummary {
  runs: {
    total: number;
    completed: number;
    failed: number;
    enhance: number;
    keep: number;
    needsReview: number;
  };
  outcomes: Record<RunOutcome, number>;
  passAtK: {
    /** Runs with at least one QA-scored candidate. */
    cohort: number;
    maxK: number;
    /** Pass-by-k: an accepted candidate within the first k iterations. */
    overall: KPoint[];
    /** The same, per QA goal: that goal's threshold met within k iterations. */
    goals: Record<QaGoal, KPoint[]>;
    thresholds: typeof QA_GOAL_THRESHOLDS;
  };
  /** Agent decision against the human label, with ENHANCE as the positive class. */
  confusion: {
    labelled: number;
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    trueNegative: number;
    accuracy: number | null;
    precision: number | null;
    recall: number | null;
  };
}

type EvalRow = Pick<
  ImageAssessmentRow,
  'status' | 'label' | 'needsReview' | 'outcome' | 'enhancement' | 'humanLabel'
>;

const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : numerator / denominator;

/**
 * Cohort metrics over persisted runs. This is the observed pass-by-k of the
 * sequential retry loop (each attempt sees the previous verdict), not the
 * independent-sample pass@k estimator.
 */
export function summarizeEvals(rows: readonly EvalRow[]): EvalSummary {
  const outcomes: Record<RunOutcome, number> = {
    published_original: 0,
    published_enhanced: 0,
    held_for_review: 0,
    rejected: 0,
    error: 0,
  };
  for (const row of rows) {
    if (row.outcome && row.outcome in outcomes) outcomes[row.outcome] += 1;
  }

  // A run enters the cohort once the judge scored a candidate. A run whose
  // only candidate never got a verdict has nothing to measure.
  const cohort = rows
    .map((row) => row.enhancement)
    .filter((enhancement) =>
      enhancement?.attempts.some((attempt) => attempt.qa),
    );
  const maxK = Math.max(0, ...cohort.map((run) => run.maxAttempts));

  const byK = (met: (qa: ImageQaResult) => boolean) =>
    Array.from({ length: maxK }, (_, index): KPoint => {
      const k = index + 1;
      // A run budgeted for fewer than k attempts says nothing about k.
      const eligible = cohort.filter((run) => run.maxAttempts >= k);
      const passed = eligible.filter((run) =>
        run.attempts.some(
          // An attempt without a verdict is never a pass.
          (attempt) => attempt.iteration <= k && attempt.qa && met(attempt.qa),
        ),
      ).length;
      return {
        k,
        cohort: eligible.length,
        passed,
        rate: ratio(passed, eligible.length) ?? 0,
      };
    });

  const goals = Object.fromEntries(
    (Object.keys(QA_GOAL_THRESHOLDS) as QaGoal[]).map((goal) => [
      goal,
      byK((qa) => qa.scores[goal] >= QA_GOAL_THRESHOLDS[goal]),
    ]),
  ) as Record<QaGoal, KPoint[]>;

  const labelled = rows.filter((row) => row.humanLabel && row.label);
  const count = (agent: 'ENHANCE' | 'KEEP', human: 'ENHANCE' | 'KEEP') =>
    labelled.filter((row) => row.label === agent && row.humanLabel === human)
      .length;
  const truePositive = count('ENHANCE', 'ENHANCE');
  const falsePositive = count('ENHANCE', 'KEEP');
  const falseNegative = count('KEEP', 'ENHANCE');
  const trueNegative = count('KEEP', 'KEEP');

  return {
    runs: {
      total: rows.length,
      completed: rows.filter((row) => row.status === 'completed').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      enhance: rows.filter((row) => row.label === 'ENHANCE').length,
      keep: rows.filter((row) => row.label === 'KEEP').length,
      needsReview: rows.filter((row) => row.needsReview).length,
    },
    outcomes,
    passAtK: {
      cohort: cohort.length,
      maxK,
      overall: byK((qa) => qa.passed),
      goals,
      thresholds: QA_GOAL_THRESHOLDS,
    },
    confusion: {
      labelled: labelled.length,
      truePositive,
      falsePositive,
      falseNegative,
      trueNegative,
      accuracy: ratio(truePositive + trueNegative, labelled.length),
      precision: ratio(truePositive, truePositive + falsePositive),
      recall: ratio(truePositive, truePositive + falseNegative),
    },
  };
}
