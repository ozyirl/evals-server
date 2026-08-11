import { Injectable } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { z } from 'zod';
import { IMAGE_QUALITY_SYSTEM_PROMPT } from './image-quality.prompt';

const assessmentSchema = z.object({
  decision: z.enum(['ENHANCE', 'KEEP']),
  confidence: z.number().min(0).max(1),
  scores: z.object({
    lighting: z.number().min(1).max(10),
    sharpness: z.number().min(1).max(10),
    composition: z.number().min(1).max(10),
    background: z.number().min(1).max(10),
    color: z.number().min(1).max(10),
    overall: z.number().min(1).max(10),
  }),
  issues: z.array(z.string()),
  reason: z.string(),
});

export type ImageQualityAssessment = z.infer<typeof assessmentSchema>;

@Injectable()
export class ImageQualityService {
  private readonly model = new ChatGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
    // gemini-2.5-flash-lite is no longer available to new API keys/projects.
    // Using the literal current flash-lite model name (not the "-latest" alias):
    // @langchain/google-genai gates image support on the model name starting
    // with "gemini-3"/"gemini-2"/etc., which the alias's name doesn't match.
    model: process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
  }).withStructuredOutput(assessmentSchema);

  async assessImage(
    buffer: Buffer,
    mimeType: string,
  ): Promise<ImageQualityAssessment> {
    const base64Image = buffer.toString('base64');

    return this.model.invoke([
      new SystemMessage(IMAGE_QUALITY_SYSTEM_PROMPT),
      new HumanMessage({
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64Image}` },
          },
        ],
      }),
    ]);
  }
}
