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

  it('sends ENHANCE images down the enhancement branch', async () => {
    await expect(router.route(routedImage(), 'ENHANCE')).resolves.toBe(
      'enhance',
    );
  });

  it('sends KEEP images down the catalogue branch', async () => {
    await expect(router.route(routedImage(), 'KEEP')).resolves.toBe('keep');
  });

  it('routes on the label even when the image needs review', async () => {
    await expect(
      router.route(routedImage({ needsReview: true }), 'ENHANCE'),
    ).resolves.toBe('enhance');
  });
});
