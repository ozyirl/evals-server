import { z } from 'zod';

export const enhancementPromptSchema = z.object({
  prompt: z.string().trim().min(1).max(6000),
  edits: z
    .array(
      z.object({
        issue: z.string().trim().min(1),
        instruction: z.string().trim().min(1),
        priority: z.enum(['high', 'medium', 'low']),
      }),
    )
    .min(1)
    .max(12),
  preserve: z.array(z.string().trim().min(1)).min(1).max(12),
  negativePrompt: z.string().trim().min(1).max(3000),
});

export type EnhancementPrompt = z.infer<typeof enhancementPromptSchema>;
