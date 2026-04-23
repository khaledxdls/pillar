import { describe, it, expect } from 'vitest';
import { aiGenerationPlanSchema, FILE_KINDS, PLAN_LIMITS } from './plan-schema.js';

/**
 * The schema is the trust boundary between an LLM's free-form output and
 * filesystem writes. Every rejection path here corresponds to a real
 * failure mode — these tests are not paranoia, they are the contract.
 */
describe('aiGenerationPlanSchema', () => {
  const validAction = {
    path: 'src/foo.ts',
    purpose: 'A test file',
    kind: 'service' as const,
  };

  const validPlan = {
    summary: 'Do a thing',
    create: [validAction],
    modify: [],
  };

  describe('happy path', () => {
    it('accepts a minimal valid plan', () => {
      const result = aiGenerationPlanSchema.safeParse(validPlan);
      expect(result.success).toBe(true);
    });

    it('accepts every canonical FileKind', () => {
      for (const kind of FILE_KINDS) {
        const result = aiGenerationPlanSchema.safeParse({
          ...validPlan,
          create: [{ ...validAction, kind }],
        });
        expect(result.success, `kind=${kind}`).toBe(true);
      }
    });

    it('accepts plans up to the file-count cap', () => {
      const create = Array.from({ length: PLAN_LIMITS.MAX_FILES_PER_PLAN }, (_, i) => ({
        ...validAction,
        path: `src/file-${i}.ts`,
      }));
      const result = aiGenerationPlanSchema.safeParse({ ...validPlan, create });
      expect(result.success).toBe(true);
    });
  });

  describe('path validation', () => {
    const reject = (p: string, hint: string) => {
      const result = aiGenerationPlanSchema.safeParse({
        ...validPlan,
        create: [{ ...validAction, path: p }],
      });
      expect(result.success, `expected reject: ${p}`).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join('|');
        expect(messages.toLowerCase()).toContain(hint.toLowerCase());
      }
    };

    it('rejects POSIX absolute paths', () => reject('/etc/passwd', 'relative'));
    it('rejects backslash-rooted paths', () => reject('\\Windows\\evil.ts', 'relative'));
    it('rejects Windows drive-letter paths', () => reject('C:\\Users\\evil.ts', 'Windows'));
    it('rejects forward-slash drive paths', () => reject('D:/evil.ts', 'Windows'));
    it('rejects parent traversal', () => reject('foo/../etc/passwd', '..'));
    it('rejects bare ..', () => reject('..', '..'));
    it('rejects backslash traversal', () => reject('foo\\..\\bar.ts', '..'));
    it('rejects URL schemes', () => reject('file:///etc/passwd', 'URL'));
    it('rejects http:// schemes', () => reject('http://evil.com/x', 'URL'));
    it('rejects empty path', () => reject('', 'empty'));
    it('rejects whitespace-only path', () => reject('   ', 'empty'));
    it('rejects NUL bytes', () => reject('foo\0bar.ts', 'NUL'));
    it('rejects paths over 512 chars', () => reject('a/'.repeat(300) + 'x.ts', '512'));
    it('rejects redundant ./ segments', () => reject('./foo.ts', '.'));
  });

  describe('kind enum', () => {
    it('rejects unknown kinds', () => {
      const result = aiGenerationPlanSchema.safeParse({
        ...validPlan,
        create: [{ ...validAction, kind: 'foobar' as never }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty kind', () => {
      const result = aiGenerationPlanSchema.safeParse({
        ...validPlan,
        create: [{ ...validAction, kind: '' as never }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('content size cap', () => {
    it('accepts content at the byte limit', () => {
      const content = 'a'.repeat(PLAN_LIMITS.MAX_CONTENT_BYTES);
      const result = aiGenerationPlanSchema.safeParse({
        ...validPlan,
        create: [{ ...validAction, content }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects content above the byte limit', () => {
      const content = 'a'.repeat(PLAN_LIMITS.MAX_CONTENT_BYTES + 1);
      const result = aiGenerationPlanSchema.safeParse({
        ...validPlan,
        create: [{ ...validAction, content }],
      });
      expect(result.success).toBe(false);
    });

    it('measures bytes, not chars (multibyte characters count more)', () => {
      // '✓' is 3 UTF-8 bytes; (MAX/3 + 1) chars exceeds the byte cap.
      const charCount = Math.floor(PLAN_LIMITS.MAX_CONTENT_BYTES / 3) + 1;
      const content = '✓'.repeat(charCount);
      const result = aiGenerationPlanSchema.safeParse({
        ...validPlan,
        create: [{ ...validAction, content }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('plan-level caps', () => {
    it('rejects plans exceeding the file-count cap', () => {
      const create = Array.from({ length: PLAN_LIMITS.MAX_FILES_PER_PLAN + 1 }, (_, i) => ({
        ...validAction,
        path: `src/file-${i}.ts`,
      }));
      const result = aiGenerationPlanSchema.safeParse({ ...validPlan, create });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes('max'))).toBe(true);
      }
    });

    it('rejects duplicate paths within create', () => {
      const result = aiGenerationPlanSchema.safeParse({
        ...validPlan,
        create: [validAction, { ...validAction }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes('duplicate'))).toBe(true);
      }
    });

    it('rejects same path appearing in both create and modify', () => {
      const result = aiGenerationPlanSchema.safeParse({
        summary: 'x',
        create: [validAction],
        modify: [validAction],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.message.includes('both'))).toBe(true);
      }
    });

    it('rejects duplicate paths within modify', () => {
      const result = aiGenerationPlanSchema.safeParse({
        summary: 'x',
        create: [],
        modify: [validAction, { ...validAction }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('inject-array caps', () => {
    it('rejects oversized methods array', () => {
      const methods = Array.from({ length: PLAN_LIMITS.MAX_INJECT_LINES + 1 }, (_, i) => ({
        name: `m${i}`,
        description: 'x',
      }));
      const result = aiGenerationPlanSchema.safeParse({
        ...validPlan,
        create: [{ ...validAction, methods }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects oversized imports array', () => {
      const imports = Array.from({ length: PLAN_LIMITS.MAX_INJECT_LINES + 1 }, (_, i) => `import x${i};`);
      const result = aiGenerationPlanSchema.safeParse({
        ...validPlan,
        create: [{ ...validAction, imports }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('structural rejection', () => {
    it('rejects missing summary', () => {
      const result = aiGenerationPlanSchema.safeParse({ create: [], modify: [] });
      expect(result.success).toBe(false);
    });

    it('rejects empty summary', () => {
      const result = aiGenerationPlanSchema.safeParse({ summary: '', create: [], modify: [] });
      expect(result.success).toBe(false);
    });
  });
});
