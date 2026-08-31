import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Structural copy of the assessment scores. Kept local so drizzle-kit can load
 * this file without pulling in LangChain; the compiler still catches drift at
 * the point where an assessment is written.
 */
type AssessmentScores = {
  lighting: number;
  sharpness: number;
  composition: number;
  background: number;
  color: number;
  overall: number;
};

/** One row per image the quality agent looked at, successful or not. */
export const imageAssessments = pgTable(
  'image_assessments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Clerk `sub` of the caller. */
    userId: text('user_id').notNull(),
    source: text('source').$type<'url' | 'upload'>().notNull(),
    /** Where the image came from, or the CDN url it was stored at. */
    imageUrl: text('image_url'),
    fileName: text('file_name'),
    mimeType: text('mime_type'),
    byteSize: integer('byte_size'),

    status: text('status').$type<'completed' | 'failed'>().notNull(),
    label: text('label').$type<'ENHANCE' | 'KEEP'>(),
    requiresEnhancement: boolean('requires_enhancement'),
    needsReview: boolean('needs_review'),
    confidence: real('confidence'),
    scores: jsonb('scores').$type<AssessmentScores>(),
    issues: jsonb('issues').$type<string[]>(),
    reason: text('reason'),

    model: text('model'),
    latencyMs: integer('latency_ms'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('image_assessments_user_created_idx').on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export type ImageAssessmentRow = typeof imageAssessments.$inferSelect;
export type NewImageAssessment = typeof imageAssessments.$inferInsert;
