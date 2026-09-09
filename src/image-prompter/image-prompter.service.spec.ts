import { ImagePrompterService } from './image-prompter.service';
import { ImageQualityAssessment } from '../image-quality/image-quality.service';

const invoke = jest.fn();
jest.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: jest
    .fn()
    .mockImplementation(() => ({ withStructuredOutput: () => ({ invoke }) })),
}));

describe('ImagePrompterService', () => {
  const assessment = {
    decision: 'ENHANCE',
    issues: ['underexposure'],
  } as ImageQualityAssessment;
  beforeEach(() => invoke.mockReset());

  it('passes the original image and assessment as data and validates the generated plan', async () => {
    const result = {
      prompt: 'Lift shadows.',
      edits: [
        {
          issue: 'underexposure',
          instruction: 'Brighten shadows.',
          priority: 'high',
        },
      ],
      preserve: ['Ingredients'],
      negativePrompt: 'No new food.',
    };
    invoke.mockResolvedValue(result);
    const service = new ImagePrompterService();
    expect(
      await service.generate(Buffer.from('image'), 'image/png', assessment),
    ).toEqual(result);
    const [system, human] = invoke.mock.calls[0][0];
    expect(system.content).toContain('untrusted evidence');
    expect(human.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining(JSON.stringify(assessment)),
      }),
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${Buffer.from('image').toString('base64')}`,
        },
      },
    ]);
  });

  it('rejects an empty or malformed model response', async () => {
    invoke.mockResolvedValue({
      prompt: ' ',
      edits: [],
      preserve: [],
      negativePrompt: '',
    });
    await expect(
      new ImagePrompterService().generate(
        Buffer.from('image'),
        'image/png',
        assessment,
      ),
    ).rejects.toThrow();
  });

  it('rejects KEEP without spending a model call', async () => {
    await expect(
      new ImagePrompterService().generate(Buffer.from('image'), 'image/png', {
        ...assessment,
        decision: 'KEEP',
      }),
    ).rejects.toThrow('Only ENHANCE');
    expect(invoke).not.toHaveBeenCalled();
  });
});
