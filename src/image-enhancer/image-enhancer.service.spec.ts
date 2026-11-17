import sharp from 'sharp';
import {
  ImageEnhancerService,
  prepareSource,
  toEditInstruction,
} from './image-enhancer.service';

const plan = {
  prompt: 'Brighten the photo without altering the dish.',
  edits: [
    { issue: 'noise', instruction: 'Reduce noise.', priority: 'low' as const },
    { issue: 'dark', instruction: 'Lift shadows.', priority: 'high' as const },
  ],
  preserve: ['Ingredients', 'Plate'],
  negativePrompt: 'No added garnish.',
};

const source = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#a63' } })
    .jpeg()
    .toBuffer();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('ImageEnhancerService', () => {
  const env = { ...process.env };
  let fetchSpy: jest.SpyInstance;
  const edited = Buffer.from('edited-image-bytes');

  beforeEach(() => {
    delete process.env.IMAGE_ENHANCER_PROVIDER;
    delete process.env.IMAGE_ENHANCER_MODEL;
    process.env.FAL_KEY = 'fal-test-key';
    process.env.GEMINI_API_KEY = 'gemini-test-key';
    fetchSpy = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    process.env = { ...env };
  });

  it('orders edits by priority and carries the constraints into one instruction', () => {
    const text = toEditInstruction(plan);
    expect(text.indexOf('Lift shadows.')).toBeLessThan(
      text.indexOf('Reduce noise.'),
    );
    expect(text).toContain('Keep unchanged: Ingredients; Plate.');
    expect(text).toContain('Do not: No added garnish.');
  });

  it('caps the source at one megapixel so a phone photo is not billed as twelve', async () => {
    const prepared = await sharp(
      await prepareSource(await source(4000, 3000)),
    ).metadata();
    expect(prepared.width * prepared.height).toBeLessThanOrEqual(1024 * 1024);
    expect(prepared.width / prepared.height).toBeCloseTo(4 / 3, 1);

    const small = await sharp(
      await prepareSource(await source(640, 480)),
    ).metadata();
    expect([small.width, small.height]).toEqual([640, 480]);
  });

  it('defaults to FLUX.2 klein on fal and decodes the inline result', async () => {
    fetchSpy.mockResolvedValue(
      json({
        images: [
          { url: `data:image/jpeg;base64,${edited.toString('base64')}` },
        ],
        has_nsfw_concepts: [false],
      }),
    );
    const service = new ImageEnhancerService();
    expect(service.provider).toBe('fal');

    const result = await service.enhance({
      buffer: await source(800, 600),
      mimeType: 'image/jpeg',
      prompt: plan,
    });

    expect(result).toEqual({ buffer: edited, mimeType: 'image/jpeg' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://fal.run/fal-ai/flux-2/klein/4b/edit');
    expect(init.headers.Authorization).toBe('Key fal-test-key');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      prompt: toEditInstruction(plan),
      num_images: 1,
      sync_mode: true,
    });
    expect(body.image_urls).toHaveLength(1);
    expect(body.image_urls[0]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('downloads the result when fal returns a hosted URL', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        json({
          images: [
            { url: 'https://fal.example/out.png', content_type: 'image/png' },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response(edited));
    const result = await new ImageEnhancerService().enhance({
      buffer: await source(800, 600),
      mimeType: 'image/jpeg',
      prompt: plan,
    });
    expect(result).toEqual({ buffer: edited, mimeType: 'image/png' });
    expect(fetchSpy.mock.calls[1][0]).toBe('https://fal.example/out.png');
  });

  it('fails without calling out when the fal key is missing, and on provider errors', async () => {
    const input = {
      buffer: await source(800, 600),
      mimeType: 'image/jpeg',
      prompt: plan,
    };
    delete process.env.FAL_KEY;
    await expect(new ImageEnhancerService().enhance(input)).rejects.toThrow(
      'FAL_KEY is not configured',
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    process.env.FAL_KEY = 'fal-test-key';
    fetchSpy.mockResolvedValueOnce(json({ detail: 'Exhausted balance' }, 403));
    await expect(new ImageEnhancerService().enhance(input)).rejects.toThrow(
      /fal image edit responded 403.*Exhausted balance/,
    );

    fetchSpy.mockResolvedValueOnce(
      json({ images: [{ url: 'x' }], has_nsfw_concepts: [true] }),
    );
    await expect(new ImageEnhancerService().enhance(input)).rejects.toThrow(
      'safety checker',
    );
  });

  it('can run on the existing Gemini key instead', async () => {
    process.env.IMAGE_ENHANCER_PROVIDER = 'gemini';
    fetchSpy.mockResolvedValue(
      json({
        candidates: [
          {
            content: {
              parts: [
                { text: 'Here is the edit.' },
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: edited.toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const service = new ImageEnhancerService();
    const result = await service.enhance({
      buffer: await source(800, 600),
      mimeType: 'image/jpeg',
      prompt: plan,
    });

    expect(result).toEqual({ buffer: edited, mimeType: 'image/png' });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${service.modelName}:generateContent`,
    );
    expect(init.headers['x-goog-api-key']).toBe('gemini-test-key');
    expect(JSON.parse(init.body).generationConfig.responseModalities).toContain(
      'IMAGE',
    );
  });

  it('reports why Gemini returned no image', async () => {
    process.env.IMAGE_ENHANCER_PROVIDER = 'gemini';
    fetchSpy.mockResolvedValue(
      json({ candidates: [{ finishReason: 'IMAGE_SAFETY', content: {} }] }),
    );
    await expect(
      new ImageEnhancerService().enhance({
        buffer: await source(800, 600),
        mimeType: 'image/jpeg',
        prompt: plan,
      }),
    ).rejects.toThrow('IMAGE_SAFETY');
  });
});
