import { z } from 'zod';

/**
 * Hard caps on AI plan size. These are deliberately generous for legitimate
 * use, but tight enough that a hallucinating or adversarial model can't
 * write multi-megabyte files or thousands of paths.
 *
 *   MAX_FILES_PER_PLAN — total of `create.length + modify.length`. A typical
 *     resource scaffold creates ~6 files; even ambitious refactors stay under
 *     20. Beyond 50 something is wrong.
 *   MAX_CONTENT_BYTES  — per-file `content` payload (UTF-8 bytes). Custom
 *     handlers (auth, health, middleware) rarely exceed 4KB. 64KB is a hard
 *     stop, not a target.
 *   MAX_INJECT_LINES   — per `imports` / `registrations` / `methods` array.
 *     Prevents pathological injection storms into a single file.
 */
export const PLAN_LIMITS = {
  MAX_FILES_PER_PLAN: 50,
  MAX_CONTENT_BYTES: 64 * 1024,
  MAX_INJECT_LINES: 32,
} as const;

/**
 * Canonical file-kind enum. Mirrors `FileKind` in the skeleton generator so
 * the model can't request a kind the executor won't understand. We accept a
 * superset that includes `generic` for ad-hoc files.
 *
 * Keep in sync with `src/core/generator/types.ts :: FileKind` and the
 * `SKELETON_GENERATORS` registry.
 */
export const FILE_KINDS = [
  'controller',
  'service',
  'repository',
  'model',
  'routes',
  'validator',
  'types',
  'test',
  'component',
  'middleware',
  'util',
  'generic',
] as const;

export type PlanFileKind = (typeof FILE_KINDS)[number];

/**
 * Reject any path the executor cannot safely resolve under `projectRoot`.
 * Defense-in-depth — the executor also re-validates before writing.
 *
 * Rejected:
 *   - empty / whitespace-only
 *   - POSIX absolute (`/etc/passwd`)
 *   - Windows drive-letter absolute (`C:\Users\...`, `C:/Users/...`)
 *   - UNC paths (`\\server\share`)
 *   - parent-dir traversal (`..`, `foo/../bar`)
 *   - URL schemes (`file://`, `http://`)
 *   - NUL bytes (filesystem injection on POSIX)
 *   - paths longer than 512 chars (sanity)
 */
function validateRelativePath(p: string): true | string {
  if (p.length === 0 || p.trim().length === 0) return 'path must not be empty';
  if (p.length > 512) return 'path exceeds 512 characters';
  if (p.includes('\0')) return 'path contains NUL byte';
  if (p.startsWith('/') || p.startsWith('\\')) return 'path must be relative';
  if (/^[a-zA-Z]:[\\/]/.test(p)) return 'Windows absolute paths are rejected';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) return 'URL schemes are not allowed';
  // Split on both separators so `foo\..\bar` is also caught on POSIX hosts.
  const segments = p.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) return 'parent traversal (..) is not allowed';
  if (segments.some((s) => s === '.')) return 'redundant (.) segments are not allowed';
  return true;
}

const pathField = z.string().superRefine((p, ctx) => {
  const result = validateRelativePath(p);
  if (result !== true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result });
  }
});

const fieldSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
});

const methodSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(256),
  /**
   * Optional raw TS signature suffix, e.g. `(q: string): Promise<Product[]>`.
   * When present, the executor emits the method with exactly this signature
   * instead of the parameterless default stub. Lets the model wire
   * cross-file calls (controller → service) with matching arg arity.
   */
  signature: z.string().min(1).max(256).optional(),
});

/**
 * Per-file action. `content` is byte-bounded (not char-bounded) — multibyte
 * chars consume more bytes, so we measure `Buffer.byteLength`. We reject
 * here rather than at write-time so the diff preview never shows oversized
 * payloads.
 */
const fileActionSchema = z.object({
  path: pathField,
  purpose: z.string().min(1).max(512),
  kind: z.enum(FILE_KINDS),
  fields: z.array(fieldSchema).max(64).optional(),
  methods: z.array(methodSchema).max(PLAN_LIMITS.MAX_INJECT_LINES).optional(),
  content: z
    .string()
    .max(PLAN_LIMITS.MAX_CONTENT_BYTES * 2) // char cap as a cheap pre-filter
    .refine(
      (c) => Buffer.byteLength(c, 'utf-8') <= PLAN_LIMITS.MAX_CONTENT_BYTES,
      { message: `content exceeds ${PLAN_LIMITS.MAX_CONTENT_BYTES} bytes` },
    )
    .optional(),
  imports: z.array(z.string().min(1).max(512)).max(PLAN_LIMITS.MAX_INJECT_LINES).optional(),
  registrations: z.array(z.string().min(1).max(512)).max(PLAN_LIMITS.MAX_INJECT_LINES).optional(),
});

/**
 * Top-level plan. Total file count (create + modify) is capped via
 * `superRefine`; arrays alone can't express the cross-array constraint.
 */
export const aiGenerationPlanSchema = z
  .object({
    summary: z.string().min(1).max(1024),
    create: z.array(fileActionSchema),
    modify: z.array(fileActionSchema),
  })
  .superRefine((plan, ctx) => {
    const total = plan.create.length + plan.modify.length;
    if (total > PLAN_LIMITS.MAX_FILES_PER_PLAN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `plan touches ${total} files; max is ${PLAN_LIMITS.MAX_FILES_PER_PLAN}`,
      });
    }

    // Detect duplicate paths within and across `create`/`modify`. Silent
    // dedup at write-time hides a real model bug; surface it as a validation
    // error so operators see and report it.
    const seen = new Map<string, 'create' | 'modify'>();
    for (const action of plan.create) {
      if (seen.has(action.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['create'],
          message: `duplicate path in plan: ${action.path}`,
        });
      } else {
        seen.set(action.path, 'create');
      }
    }
    for (const action of plan.modify) {
      const prev = seen.get(action.path);
      if (prev === 'create') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modify'],
          message: `path "${action.path}" appears in both create and modify`,
        });
      } else if (prev === 'modify') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['modify'],
          message: `duplicate path in plan: ${action.path}`,
        });
      } else {
        seen.set(action.path, 'modify');
      }
    }
  });

export type ValidatedAIGenerationPlan = z.infer<typeof aiGenerationPlanSchema>;
