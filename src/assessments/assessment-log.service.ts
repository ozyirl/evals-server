import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
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
  async record(entry: NewImageAssessment): Promise<void> {
    try {
      await this.db.insert(imageAssessments).values(entry);
    } catch (error) {
      this.logger.error(
        `Could not persist assessment for user ${entry.userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
}
