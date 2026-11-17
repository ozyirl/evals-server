import type { EnhancementPrompt } from '../image-prompter/image-prompter.schema';
import type { ImageQaResult } from '../image-qa/image-qa.schema';

/** Where a run ended up once the loop stopped. */
export type RunOutcome =
  /** Confident KEEP: the image went to the catalogue as uploaded. */
  | 'published_original'
  /** A candidate passed LLM QA and the final check, and was published. */
  | 'published_enhanced'
  /** The assessment or the QA judge was unsure; nothing was published. */
  | 'held_for_review'
  /** No candidate passed within the attempt budget, or the final check failed. */
  | 'rejected'
  /** A second-pass provider call failed; first-pass evidence is still valid. */
  | 'error';

/** One generated candidate and what the judge made of it. */
export interface EnhancementAttempt {
  /** One-based count of generated candidates. */
  iteration: number;
  /** The plan this candidate was generated from; revised after a failed verdict. */
  prompt: EnhancementPrompt;
  /** Stored candidate, or null when storage failed or nothing was generated. */
  imageUrl: string | null;
  mimeType: string | null;
  byteSize: number | null;
  /** Null when generation or the judge call errored: no score is not a pass. */
  qa: ImageQaResult | null;
  error: string | null;
}

export interface FinalCheck {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
}

export interface EnhancementSummary {
  provider: string;
  model: string;
  maxAttempts: number;
  attempts: EnhancementAttempt[];
  passedIteration: number | null;
  finalCheck: FinalCheck | null;
}
