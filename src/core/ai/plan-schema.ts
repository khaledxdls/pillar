import { z } from 'zod';

const fieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
});

const methodSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

const fileActionSchema = z.object({
  path: z.string().min(1).refine(
    (p) => !p.startsWith('/') && !p.includes('..'),
    { message: 'Path must be relative and cannot traverse upward' },
  ),
  purpose: z.string().min(1),
  kind: z.string().min(1),
  fields: z.array(fieldSchema).optional(),
  methods: z.array(methodSchema).optional(),
  content: z.string().optional(),
  imports: z.array(z.string().min(1)).optional(),
  registrations: z.array(z.string().min(1)).optional(),
});

export const aiGenerationPlanSchema = z.object({
  summary: z.string().min(1),
  create: z.array(fileActionSchema),
  modify: z.array(fileActionSchema),
});

export type ValidatedAIGenerationPlan = z.infer<typeof aiGenerationPlanSchema>;
