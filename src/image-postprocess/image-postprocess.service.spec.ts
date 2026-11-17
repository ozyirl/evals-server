import sharp from 'sharp';
import {
  FINAL_CHECK_POLICY,
  ImagePostProcessService,
} from './image-postprocess.service';

/** A real, decodable image with visible structure, so stats are not flat. */
async function photo(width: number, height: number, format: 'png' | 'jpeg') {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 37) % 256;
  const image = sharp(pixels, { raw: { width, height, channels: 3 } });
  return {
    buffer: await (format === 'png' ? image.png() : image.jpeg()).toBuffer(),
    mimeType: `image/${format}`,
  };
}

const failed = (result: {
  finalCheck: { checks: { name: string; passed: boolean }[] };
}) => result.finalCheck.checks.filter((c) => !c.passed).map((c) => c.name);

describe('ImagePostProcessService', () => {
  const service = new ImagePostProcessService();

  it('normalises an acceptable candidate to a bounded, metadata-free JPEG', async () => {
    const original = await photo(1200, 900, 'jpeg');
    const candidate = await photo(3200, 2400, 'png');

    const result = await service.finalize(original, candidate);

    expect(result.finalCheck.passed).toBe(true);
    expect(result.mimeType).toBe('image/jpeg');
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width, meta.height)).toBe(
      FINAL_CHECK_POLICY.maxLongSide,
    );
    expect(meta.exif).toBeUndefined();
  });

  it('rejects a candidate whose shape drifted from the original', async () => {
    const result = await service.finalize(
      await photo(1200, 800, 'jpeg'),
      await photo(1024, 1024, 'jpeg'),
    );
    expect(result.finalCheck.passed).toBe(false);
    expect(failed(result)).toEqual(['aspect_ratio']);
  });

  it('rejects a blank frame, such as a safety-filtered output', async () => {
    const black = await sharp({
      create: { width: 1024, height: 768, channels: 3, background: '#000' },
    })
      .jpeg()
      .toBuffer();
    const result = await service.finalize(await photo(1024, 768, 'jpeg'), {
      buffer: black,
      mimeType: 'image/jpeg',
    });
    expect(failed(result)).toEqual(['not_blank']);
  });

  it('rejects a low-resolution candidate, unless the original was that small too', async () => {
    const small = await photo(400, 300, 'jpeg');
    expect(
      failed(await service.finalize(await photo(1600, 1200, 'jpeg'), small)),
    ).toEqual(['resolution']);
    expect((await service.finalize(small, small)).finalCheck.passed).toBe(true);
  });

  it('fails closed on bytes that are not an image', async () => {
    const result = await service.finalize(await photo(800, 600, 'jpeg'), {
      buffer: Buffer.from('not an image'),
      mimeType: 'image/jpeg',
    });
    expect(result.finalCheck.passed).toBe(false);
    expect(failed(result)).toEqual(['decodes']);
  });
});
