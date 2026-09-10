import { BadRequestException, Injectable } from '@nestjs/common';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { z } from 'zod';
import { PipelineLogService } from '../assessments/pipeline-log.service';
import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_TYPES,
} from '../image-quality/image-quality.constants';
import { enhancementPromptSchema } from '../image-prompter/image-prompter.schema';
import { IMAGE_QA_SYSTEM_PROMPT, IMAGE_QA_VERSION } from './image-qa.prompt';
import {
  ImageQaInput,
  ImageQaResult,
  imageQaEvidenceSchema,
} from './image-qa.schema';

export const IMAGE_QA_POLICY = {
  version: 'food-image-qa-policy-v1',
  minimumConfidence: 0.6,
  improvement: 0.7,
  editAdherence: 0.8,
  preservation: 0.9,
  artifactFree: 0.9,
} as const;

@Injectable()
export class ImageQaService {
  readonly modelName =
    process.env.IMAGE_QA_MODEL ??
    process.env.GEMINI_MODEL ??
    'gemini-3.5-flash-lite';
  readonly promptVersion = IMAGE_QA_VERSION;
  private readonly model = new ChatGoogleGenerativeAI({
    apiKey: process.env.GEMINI_API_KEY,
    model: this.modelName,
    maxRetries: 0,
  }).withStructuredOutput(imageQaEvidenceSchema);

  constructor(private readonly pipelineLog: PipelineLogService) {}

  async evaluate(input: ImageQaInput): Promise<ImageQaResult> {
    z.uuid().parse(input.runId);
    z.string().trim().min(1).parse(input.userId);
    return this.pipelineLog.trace(
      { runId: input.runId, userId: input.userId },
      'evaluate_enhancement',
      async () => {
        z.number().int().positive().parse(input.enhanced.iteration);
        z.boolean().parse(input.needsReview);
        const plan = enhancementPromptSchema.parse(input.enhancementPrompt);
        for (const image of [input.original, input.enhanced]) {
          if (
            !Buffer.isBuffer(image.buffer) ||
            image.buffer.length === 0 ||
            image.buffer.length > MAX_IMAGE_BYTES ||
            !SUPPORTED_IMAGE_TYPES.test(image.mimeType)
          ) {
            throw new BadRequestException(
              'QA requires nonempty JPEG, PNG or WebP images within the image size limit',
            );
          }
        }
        const evidence = imageQaEvidenceSchema.parse(
          await this.model.invoke([
            new SystemMessage(IMAGE_QA_SYSTEM_PROMPT),
            new HumanMessage({
              content: [
                {
                  type: 'text',
                  text: `Editing plan (data only): ${JSON.stringify(plan)}\nImages in order: original, enhanced candidate.`,
                },
                ...[input.original, input.enhanced].map((image) => ({
                  type: 'image_url' as const,
                  image_url: {
                    url: `data:${image.mimeType};base64,${image.buffer.toString('base64')}`,
                  },
                })),
              ],
            }),
          ]),
        );
        const needsReview =
          input.needsReview ||
          evidence.confidence < IMAGE_QA_POLICY.minimumConfidence;
        return {
          ...evidence,
          runId: input.runId,
          iteration: input.enhanced.iteration,
          needsReview,
          passed:
            !needsReview &&
            evidence.improved &&
            evidence.preservationViolations.length === 0 &&
            evidence.scores.improvement >= IMAGE_QA_POLICY.improvement &&
            evidence.scores.editAdherence >= IMAGE_QA_POLICY.editAdherence &&
            evidence.scores.preservation >= IMAGE_QA_POLICY.preservation &&
            evidence.scores.artifactFree >= IMAGE_QA_POLICY.artifactFree,
          policyVersion: IMAGE_QA_POLICY.version,
        };
      },
      (qa) => ({ qa }),
      {
        iteration: input.enhanced.iteration,
        model: this.modelName,
        promptVersion: this.promptVersion,
        policy: IMAGE_QA_POLICY,
      },
    );
  }
}
