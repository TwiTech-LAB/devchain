import { z } from 'zod';

export const PromptSummarySchema = z.object({
  promptId: z.string(),
  title: z.string(),
  order: z.number().int().min(1),
});

export const AgentProfileWithPromptsSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  name: z.string(),
  providerId: z.string(),
  options: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  instructions: z.string().nullable(),
  temperature: z.number().nullable(),
  maxTokens: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  prompts: z.array(PromptSummarySchema),
});

export type AgentProfileWithPrompts = z.infer<typeof AgentProfileWithPromptsSchema>;
