import { uploadFile } from '@uploadcare/upload-client';
import { storeFile } from '@uploadcare/rest-client';
import { UploadService } from './upload.service';
import { PipelineLogService } from '../assessments/pipeline-log.service';
import { NewPipelineEvent } from '../db/schema';

jest.mock('@uploadcare/upload-client', () => ({ uploadFile: jest.fn() }));
jest.mock('@uploadcare/rest-client', () => ({
  storeFile: jest.fn(),
  UploadcareSimpleAuthSchema: jest.fn(),
}));

describe('UploadService pipeline', () => {
  const file = {
    buffer: Buffer.from('image'),
    mimetype: 'image/png',
    originalname: 'food.png',
  } as Express.Multer.File;
  let events: NewPipelineEvent[];
  let agent: { assessImage: jest.Mock };
  let assessmentLog: { record: jest.Mock };
  let service: UploadService;

  beforeEach(() => {
    events = [];
    jest.clearAllMocks();
    (uploadFile as jest.Mock).mockResolvedValue({
      uuid: 'upload-id',
      cdnUrl: 'https://example.com/food.png',
    });
    (storeFile as jest.Mock).mockResolvedValue({});
    agent = {
      assessImage: jest.fn().mockResolvedValue({
        destination: 'enhance',
        enhancementPrompt: { prompt: 'Brighten.' },
        needsReview: true,
      }),
    };
    assessmentLog = { record: jest.fn().mockResolvedValue(true) };
    const log = new PipelineLogService({
      insert: () => ({
        values: async (event: NewPipelineEvent) => {
          events.push(event);
        },
      }),
    } as never);
    service = new UploadService(agent as never, assessmentLog as never, log);
  });

  it('hands the original bytes and the same run ID to the shared graph after logging upload and storage', async () => {
    const result = await service.storeImage(file, 'test-user');
    expect(result).toMatchObject({
      uuid: 'upload-id',
      enhancementPrompt: { prompt: 'Brighten.' },
      needsReview: true,
    });
    const context = agent.assessImage.mock.calls[0][1];
    expect(agent.assessImage).toHaveBeenCalledWith(
      { buffer: file.buffer, mimeType: file.mimetype },
      {
        runId: context.runId,
        userId: 'test-user',
        fileName: file.originalname,
        imageUrl: 'https://example.com/food.png',
      },
    );
    expect(events.every((e) => e.runId === context.runId)).toBe(true);
    expect(
      events.filter((e) => e.status === 'completed').map((e) => e.step),
    ).toEqual(['upload_image', 'store_image', 'upload_pipeline']);
    expect(assessmentLog.record).not.toHaveBeenCalled();
  });

  it('logs storage failure and a single failure summary without running the image graph', async () => {
    (storeFile as jest.Mock).mockRejectedValue(new Error('Storage failed'));
    await expect(service.storeImage(file, 'test-user')).rejects.toThrow(
      'Storage failed',
    );
    expect(agent.assessImage).not.toHaveBeenCalled();
    expect(assessmentLog.record).toHaveBeenCalledTimes(1);
    expect(
      events.filter((e) => e.status === 'failed').map((e) => e.step),
    ).toEqual(['store_image', 'upload_pipeline']);
  });

  it('does not duplicate the assessment summary when the shared graph fails', async () => {
    agent.assessImage.mockRejectedValue(new Error('Prompter failed'));
    await expect(service.storeImage(file, 'test-user')).rejects.toThrow(
      'Prompter failed',
    );
    expect(assessmentLog.record).not.toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: 'upload_pipeline', status: 'failed' }),
      ]),
    );
  });
});
