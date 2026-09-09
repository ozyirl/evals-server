import { PipelineLogService } from './pipeline-log.service';

describe('PipelineLogService', () => {
  it('preserves operation results and original errors when the database is unavailable', async () => {
    const service = new PipelineLogService({
      insert: () => ({
        values: jest.fn().mockRejectedValue(new Error('DB offline')),
      }),
    } as never);
    const context = { runId: 'test-run', userId: 'test-user' };
    await expect(
      service.trace(context, 'success', async () => 42),
    ).resolves.toBe(42);
    const failure = new Error('Original model failure');
    await expect(
      service.trace(context, 'failure', async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
