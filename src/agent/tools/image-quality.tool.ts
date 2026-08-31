import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import type { ImageAgentService } from '../image-agent.service';

/**
 * Lets the chat agent assess an image it was given a link to. URL-only — the
 * ReAct loop passes JSON arguments, so raw upload buffers never reach it.
 *
 * The caller's Clerk id rides along in the graph config so tool-driven
 * assessments land in the log under the user who asked for them.
 */
export const createImageQualityTool = (imageAgentService: ImageAgentService) =>
  tool(
    async ({ imageUrl }: { imageUrl: string }, config?: RunnableConfig) => {
      const userId = (config?.configurable?.userId as string) ?? 'unknown';
      const result = await imageAgentService.assessImage(
        { imageUrl },
        { userId },
      );
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
