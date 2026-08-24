import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { ImageAgentService } from '../image-agent.service';

/**
 * Lets the chat agent assess an image it was given a link to. URL-only — the
 * ReAct loop passes JSON arguments, so raw upload buffers never reach it.
 */
export const createImageQualityTool = (imageAgentService: ImageAgentService) =>
  tool(
    async ({ imageUrl }: { imageUrl: string }) => {
      const result = await imageAgentService.assessImage({ imageUrl });
      return JSON.stringify(result);
    },
    {
      name: 'assess_image_quality',
      description:
        'Assess whether a food photo needs enhancement before being shown to customers. Call with the URL of the image.',
      schema: z.object({
        imageUrl: z
          .string()
          .describe('Public URL of the food image to assess.'),
      }),
    },
  );
