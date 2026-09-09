import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { Database, DB } from '../db/db.module';
import { NewPipelineEvent, pipelineEvents } from '../db/schema';

export type PipelineContext = { runId: string; userId: string };

@Injectable()
export class PipelineLogService {
  private readonly logger = new Logger(PipelineLogService.name);
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(event: NewPipelineEvent): Promise<void> {
    this.logger.log(`${event.runId} ${event.step} ${event.status}`);
    try {
      await this.db.insert(pipelineEvents).values(event);
    } catch (error) {
      this.logger.error(
        `Could not persist pipeline event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async trace<T>(
    context: PipelineContext,
    step: string,
    operation: () => Promise<T> | T,
    summarize: (value: T) => Record<string, unknown> = () => ({}),
    metadata: Record<string, unknown> = {},
  ): Promise<T> {
    const event = { ...context, hopId: randomUUID(), step };
    await this.record({ ...event, status: 'started', metadata });
    const startedAt = Date.now();
    try {
      const result = await operation();
      await this.record({
        ...event,
        status: 'completed',
        latencyMs: Date.now() - startedAt,
        metadata: { ...metadata, ...summarize(result) },
      });
      return result;
    } catch (error) {
      await this.record({
        ...event,
        status: 'failed',
        latencyMs: Date.now() - startedAt,
        metadata,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async listForRun(userId: string, runId: string) {
    return this.db
      .select()
      .from(pipelineEvents)
      .where(
        and(eq(pipelineEvents.userId, userId), eq(pipelineEvents.runId, runId)),
      )
      .orderBy(asc(pipelineEvents.createdAt), asc(pipelineEvents.id));
  }
}
