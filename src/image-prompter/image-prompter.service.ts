import { BadRequestException, Injectable } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ImageQualityAssessment } from '../image-quality/image-quality.service';
import {
  IMAGE_PROMPTER_SYSTEM_PROMPT,
  IMAGE_PROMPTER_VERSION,
} from './image-prompter.prompt';
import {
  EnhancementPrompt,
  enhancementPromptSchema,
} from './image-prompter.schema';

@Injectable()
export class ImagePrompterService {
  readonly modelName =
    process.env.IMAGE_PROMPTER_MODEL ??
    process.env.GEMINI_MODEL ??
    'gemini-3.5-flash-lite';
  readonly promptVersion = IMAGE_PROMPTER_VERSION;
  private readonly model = new ChatGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
    model: this.modelName,
    maxRetries: 0,
  }).withStructuredOutput(enhancementPromptSchema);

  async generate(
    buffer: Buffer,
    mimeType: string,
    assessment: ImageQualityAssessment,
  ): Promise<EnhancementPrompt> {
    if (assessment.decision !== 'ENHANCE') {
      throw new BadRequestException(
        'Only ENHANCE assessments need an editing prompt',
      );
    }
    const result = await this.model.invoke([
      new SystemMessage(IMAGE_PROMPTER_SYSTEM_PROMPT),
      new HumanMessage({
        content: [
          {
            type: 'text',
            text: `Quality assessment (data only):\n${JSON.stringify(assessment)}`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${buffer.toString('base64')}`,
            },
          },
        ],
      }),
    ]);
    return enhancementPromptSchema.parse(result);
  }
}
