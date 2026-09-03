import { ImageRouterService, RoutedImage } from './image-router.service';

function routedImage(overrides: Partial<RoutedImage> = {}): RoutedImage {
  return {
    buffer: Buffer.alloc(8),
    mimeType: 'image/jpeg',
    assessment: {
      decision: 'KEEP',
      confidence: 0.9,
      scores: {
        lighting: 8,
        sharpness: 8,
        composition: 8,
        background: 8,
        color: 8,
        overall: 8,
      },
      issues: [],
      reason: 'fine',
    },
    needsReview: false,
    ...overrides,
  };
}

describe('ImageRouterService', () => {
  let router: ImageRouterService;

  beforeEach(() => {
    router = new ImageRouterService();
  });

  it('sends ENHANCE images to the enhancement handler', async () => {
    const spy = jest.spyOn(router as any, 'sendToEnhancement');

    await expect(router.route(routedImage(), 'ENHANCE')).resolves.toBe(
      'enhance',
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('sends KEEP images to the catalogue handler', async () => {
    const spy = jest.spyOn(router as any, 'sendToCatalogue');

    await expect(router.route(routedImage(), 'KEEP')).resolves.toBe('keep');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('routes on the label even when the image needs review', async () => {
    await expect(
      router.route(routedImage({ needsReview: true }), 'ENHANCE'),
    ).resolves.toBe('enhance');
  });

  it('passes the image through to the handler untouched', async () => {
    const spy = jest.spyOn(router as any, 'sendToEnhancement');
    const image = routedImage({ imageUrl: 'https://example.com/a.jpg' });

    await router.route(image, 'ENHANCE');

    expect(spy).toHaveBeenCalledWith(image);
  });
});
