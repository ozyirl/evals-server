import { Injectable } from '@nestjs/common';
import sharp from 'sharp';
import { EnhancementPrompt } from '../image-prompter/image-prompter.schema';

export type EnhancerProvider = 'fal' | 'gemini';

export interface EnhanceInput {
  buffer: Buffer;
  mimeType: string;
  prompt: EnhancementPrompt;
}

export interface EnhancedImage {
  buffer: Buffer;
  mimeType: string;
}

const DEFAULT_MODELS: Record<EnhancerProvider, string> = {
  // Cheapest edit model that keeps the source photo: $0.01 per megapixel.
  fal: 'fal-ai/flux-2/klein/4b/edit',
  // Runs on the existing GEMINI_API_KEY, at roughly three times the price.
  gemini: 'gemini-3.1-flash-lite-image',
};

/** fal bills per output megapixel and defaults to the input size, so cap it. */
const MAX_SOURCE_PIXELS = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_INSTRUCTION_CHARS = 4000;
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/** Flattens the structured plan into the single instruction an edit model takes. */
export function toEditInstruction(plan: EnhancementPrompt): string {
  const edits = [...plan.edits].sort(
    (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );
  return [
    plan.prompt,
    'Apply these corrections, most important first:',
    ...edits.map((edit) => `- ${edit.instruction}`),
    `Keep unchanged: ${plan.preserve.join('; ')}.`,
    `Do not: ${plan.negativePrompt}`,
    'Return the same photograph with only these corrections applied.',
  ]
    .join('\n')
    .slice(0, MAX_INSTRUCTION_CHARS);
}

/** Auto-orients and shrinks the source to at most one megapixel of JPEG. */
export async function prepareSource(buffer: Buffer): Promise<Buffer> {
  const oriented = await sharp(buffer).rotate().toBuffer();
  const { width, height } = await sharp(oriented).metadata();
  const scale = Math.min(1, Math.sqrt(MAX_SOURCE_PIXELS / (width * height)));
  return sharp(oriented)
    .resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      fit: 'fill',
    })
    .jpeg({ quality: 92 })
    .toBuffer();
}

function parseDataUri(uri: string): EnhancedImage | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(uri);
  return match
    ? { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') }
    : null;
}

async function failure(provider: string, response: Response): Promise<Error> {
  const body = (await response.text().catch(() => '')).slice(0, 300);
  return new Error(
    `${provider} image edit responded ${response.status}${body ? `: ${body}` : ''}`,
  );
}

/**
 * Agent 3: applies an editing plan to the original photo and returns candidate
 * bytes. One provider call per invocation and no retries, so every attempt is
 * one billed image and one visible hop.
 */
@Injectable()
export class ImageEnhancerService {
  readonly provider: EnhancerProvider =
    process.env.IMAGE_ENHANCER_PROVIDER === 'gemini' ? 'gemini' : 'fal';
  readonly modelName =
    process.env.IMAGE_ENHANCER_MODEL ?? DEFAULT_MODELS[this.provider];

  async enhance(input: EnhanceInput): Promise<EnhancedImage> {
    const source = await prepareSource(input.buffer);
    const instruction = toEditInstruction(input.prompt);
    const image =
      this.provider === 'gemini'
        ? await this.viaGemini(source, instruction)
        : await this.viaFal(source, instruction);
    if (image.buffer.byteLength === 0) {
      throw new Error(`${this.provider} returned an empty image`);
    }
    return image;
  }

  private async viaFal(
    source: Buffer,
    instruction: string,
  ): Promise<EnhancedImage> {
    const key = process.env.FAL_KEY;
    if (!key) {
      throw new Error(
        'FAL_KEY is not configured. Set it, or set IMAGE_ENHANCER_PROVIDER=gemini to use the existing Gemini key.',
      );
    }
    const response = await fetch(`https://fal.run/${this.modelName}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: instruction,
        image_urls: [`data:image/jpeg;base64,${source.toString('base64')}`],
        num_images: 1,
        output_format: 'jpeg',
        // Return the bytes inline instead of a hosted URL to fetch afterwards.
        sync_mode: true,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await failure('fal', response);

    const payload = (await response.json()) as {
      images?: { url?: string; content_type?: string }[];
      has_nsfw_concepts?: boolean[];
    };
    if (payload.has_nsfw_concepts?.[0]) {
      throw new Error('fal safety checker blocked the edited image');
    }
    const url = payload.images?.[0]?.url;
    if (!url) throw new Error('fal returned no image');

    const inline = parseDataUri(url);
    if (inline) return inline;

    const download = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!download.ok) throw await failure('fal image download', download);
    return {
      buffer: Buffer.from(await download.arrayBuffer()),
      mimeType:
        payload.images[0].content_type ??
        download.headers.get('content-type')?.split(';')[0] ??
        'image/jpeg',
    };
  }

  private async viaGemini(
    source: Buffer,
    instruction: string,
  ): Promise<EnhancedImage> {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY is not configured');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: instruction },
                {
                  inline_data: {
                    mime_type: 'image/jpeg',
                    data: source.toString('base64'),
                  },
                },
              ],
            },
          ],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw await failure('Gemini', response);

    type Part = {
      text?: string;
      inlineData?: { mimeType?: string; data?: string };
      inline_data?: { mime_type?: string; data?: string };
    };
    const payload = (await response.json()) as {
      candidates?: { finishReason?: string; content?: { parts?: Part[] } }[];
      promptFeedback?: { blockReason?: string };
    };
    const candidate = payload.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      const data = part.inlineData?.data ?? part.inline_data?.data;
      if (data) {
        return {
          buffer: Buffer.from(data, 'base64'),
          mimeType:
            part.inlineData?.mimeType ??
            part.inline_data?.mime_type ??
            'image/png',
        };
      }
    }
    throw new Error(
      `Gemini returned no image (${
        payload.promptFeedback?.blockReason ??
        candidate?.finishReason ??
        'no candidates'
      })`,
    );
  }
}
