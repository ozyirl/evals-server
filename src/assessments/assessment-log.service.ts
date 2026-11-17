import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { Database, DB } from '../db/db.module';
import {
  ImageAssessmentRow,
  imageAssessments,
  NewImageAssessment,
} from '../db/schema';

@Injectable()
export class AssessmentLogService {
  private readonly logger = new Logger(AssessmentLogService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Persists one assessment attempt. Deliberately swallows its own failures —
   * an unreachable database should not turn a finished assessment into a 500.
   */
  async record(entry: NewImageAssessment): Promise<boolean> {
    try {
      await this.db.insert(imageAssessments).values(entry);
      return true;
    } catch (error) {
      this.logger.error(
        `Could not persist assessment for user ${entry.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  async listForUser(userId: string, limit = 20): Promise<ImageAssessmentRow[]> {
    return this.db
      .select()
      .from(imageAssessments)
      .where(eq(imageAssessments.userId, userId))
      .orderBy(desc(imageAssessments.createdAt))
      .limit(limit);
  }

  /** The cohort the eval layer aggregates over, newest first. */
  async listForEval(
    userId: string,
    limit = 1000,
  ): Promise<ImageAssessmentRow[]> {
    return this.listForUser(userId, limit);
  }

  /** Records a person's ground-truth label; scoped to the caller's own run. */
  async setHumanLabel(
    userId: string,
    runId: string,
    label: 'ENHANCE' | 'KEEP' | null,
  ): Promise<ImageAssessmentRow | null> {
    const [row] = await this.db
      .update(imageAssessments)
      .set({ humanLabel: label, humanLabeledAt: label ? new Date() : null })
      .where(
        and(
          eq(imageAssessments.userId, userId),
          eq(imageAssessments.id, runId),
        ),
      )
      .returning();
    return row ?? null;
  }
}
