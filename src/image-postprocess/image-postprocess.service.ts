import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { FinalCheck } from '../agent/enhancement.types';
import { MAX_IMAGE_BYTES } from '../image-quality/image-quality.constants';

export const FINAL_CHECK_POLICY = {
  version: 'final-check-v1',
  /** Published images are capped at this long side. */
  maxLongSide: 2048,
  /** Unless the original was smaller, a published image needs this short side. */
  minShortSide: 512,
  /** Allowed relative drift between candidate and original aspect ratio. */
  aspectTolerance: 0.15,
  /** Mean per-channel standard deviation below this is a blank frame. */
  minContrast: 2,
} as const;

type Image = { buffer: Buffer; mimeType: string };

export interface FinalizedImage extends Image {
  finalCheck: FinalCheck;
}

/** Dimensions as displayed, after applying any EXIF orientation. */
async function orientedSize(buffer: Buffer) {
  const { width, height } = await sharp(
    await sharp(buffer).rotate().toBuffer(),
  ).metadata();
  return { width, height };
}

/**
 * The last gate before publication. Deterministic on purpose: the LLM judge
 * has already had its say, so this only catches what a model cannot be trusted
 * to notice about a file — undecodable bytes, a blank frame, a changed shape.
 */
@Injectable()
export class ImagePostProcessService {
  readonly policyVersion = FINAL_CHECK_POLICY.version;

  async finalize(original: Image, candidate: Image): Promise<FinalizedImage> {
    let normalized: Buffer;
    try {
      // Re-encoding strips metadata and bounds the size of what is published.
      normalized = await sharp(candidate.buffer)
        .rotate()
        .resize({
          width: FINAL_CHECK_POLICY.maxLongSide,
          height: FINAL_CHECK_POLICY.maxLongSide,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer();
    } catch (error) {
      return {
        ...candidate,
        finalCheck: {
          passed: false,
          checks: [
            {
              name: 'decodes',
              passed: false,
              detail: error instanceof Error ? error.message : String(error),
            },
          ],
        },
      };
    }

    const [source, output, stats] = await Promise.all([
      orientedSize(original.buffer),
      sharp(normalized).metadata(),
      sharp(normalized).stats(),
    ]);
    const shortSide = Math.min(output.width, output.height);
    const requiredShortSide = Math.min(
      FINAL_CHECK_POLICY.minShortSide,
      source.width,
      source.height,
    );
    const drift = Math.abs(
      output.width / output.height / (source.width / source.height) - 1,
    );
    const contrast =
      stats.channels.reduce((sum, channel) => sum + channel.stdev, 0) /
      stats.channels.length;

    const checks = [
      {
        name: 'decodes',
        passed: true,
        detail: `${output.width}×${output.height} ${output.format}`,
      },
      {
        name: 'resolution',
        passed: shortSide >= requiredShortSide,
        detail: `short side ${shortSide}px, needs ${requiredShortSide}px`,
      },
      {
        name: 'aspect_ratio',
        passed: drift <= FINAL_CHECK_POLICY.aspectTolerance,
        detail: `${(drift * 100).toFixed(1)}% drift from the original, limit ${
          FINAL_CHECK_POLICY.aspectTolerance * 100
        }%`,
      },
      {
        name: 'not_blank',
        passed: contrast >= FINAL_CHECK_POLICY.minContrast,
        detail: `contrast ${contrast.toFixed(1)}, needs ${FINAL_CHECK_POLICY.minContrast}`,
      },
      {
        name: 'file_size',
        passed: normalized.byteLength <= MAX_IMAGE_BYTES,
        detail: `${normalized.byteLength} bytes`,
      },
    ];

    return {
      buffer: normalized,
      mimeType: 'image/jpeg',
      finalCheck: { passed: checks.every((check) => check.passed), checks },
    };
  }
}
