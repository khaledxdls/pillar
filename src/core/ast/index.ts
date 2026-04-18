/**
 * AST-based source transforms.
 *
 * Pillar's generators originally mutated TypeScript with regular expressions
 * (match an interface header, splice a line before the closing brace, etc.).
 * That worked for the golden path but broke on nested braces, comments with
 * braces, decorators, and anything users edited by hand.
 *
 * This module wraps `ts-morph` and exposes a tight, domain-oriented API so
 * the rest of the codebase never touches the underlying AST. Every helper:
 *
 *   1. Accepts a source string + a logical target (interface name, schema
 *      name, class name, …) and returns the new source string.
 *   2. Is idempotent — re-running with the same inputs is a no-op, which
 *      makes the `pillar add` pipeline safe to retry.
 *   3. Returns `null` when the target cannot be located, so callers can
 *      fall back to regex-based helpers without crashing.
 *
 * Keeping the ts-morph surface hidden lets us swap the backend (Babel,
 * Biome) later without ripping through every call site.
 */

import { Project, ScriptKind, SyntaxKind, type SourceFile } from 'ts-morph';

export interface InterfaceFieldSpec {
  name: string;
  type: string;
  optional?: boolean;
}

export interface ZodFieldSpec {
  name: string;
  expression: string;
}

/**
 * Add one or more fields to an interface declaration. Skips fields that
 * already exist (by name) so repeated calls don't produce duplicates.
 *
 * Returns the updated source or `null` if the interface is not found.
 */
export function addFieldsToInterface(
  source: string,
  interfaceName: string,
  fields: InterfaceFieldSpec[],
): string | null {
  if (fields.length === 0) return source;

  return withSourceFile(source, (sf) => {
    const iface = sf.getInterface(interfaceName);
    if (!iface) return null;

    const existing = new Set(iface.getProperties().map((p) => p.getName()));
    for (const f of fields) {
      if (existing.has(f.name)) continue;
      iface.addProperty({
        name: f.name,
        type: f.type,
        hasQuestionToken: !!f.optional,
      });
    }
    return sf.getFullText();
  });
}

/**
 * Add properties to the object literal inside a call like
 * `export const create<Name>Schema = z.object({ ... })`. Idempotent on
 * field name. Returns `null` if the schema variable isn't a z.object call.
 */
export function addFieldsToZodObjectSchema(
  source: string,
  schemaVariableName: string,
  fields: ZodFieldSpec[],
): string | null {
  if (fields.length === 0) return source;

  return withSourceFile(source, (sf) => {
    const decl = sf.getVariableDeclaration(schemaVariableName);
    if (!decl) return null;

    const init = decl.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.CallExpression) return null;

    const call = init.asKindOrThrow(SyntaxKind.CallExpression);
    const args = call.getArguments();
    const objArg = args[0];
    if (!objArg || objArg.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;

    const obj = objArg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const existing = new Set(
      obj
        .getProperties()
        .map((p) => (p.getKind() === SyntaxKind.PropertyAssignment
          ? p.asKindOrThrow(SyntaxKind.PropertyAssignment).getName()
          : '')),
    );

    for (const f of fields) {
      if (existing.has(f.name)) continue;
      obj.addPropertyAssignment({
        name: f.name,
        initializer: f.expression,
      });
    }
    return sf.getFullText();
  });
}

/**
 * Insert an import statement if the file doesn't already import the given
 * named binding from the same module. Preserves existing imports (merges
 * into an existing named-import clause when module specifiers match).
 *
 * `kind` controls whether the added import is a type-only import.
 */
export function ensureNamedImport(
  source: string,
  moduleSpecifier: string,
  namedBinding: string,
  kind: 'type' | 'value' = 'value',
): string {
  const result = withSourceFile(source, (sf) => {
    const existing = sf
      .getImportDeclarations()
      .find((d) => d.getModuleSpecifierValue() === moduleSpecifier);

    if (existing) {
      const already = existing.getNamedImports().some((n) => n.getName() === namedBinding);
      if (already) return sf.getFullText();
      existing.addNamedImport({ name: namedBinding });
      return sf.getFullText();
    }

    sf.addImportDeclaration({
      moduleSpecifier,
      namedImports: [{ name: namedBinding }],
      isTypeOnly: kind === 'type',
    });
    return sf.getFullText();
  });
  return result ?? source;
}

/**
 * Append a method to a class. Idempotent on method name.
 * Returns `null` if the class cannot be found.
 */
export function addMethodToClass(
  source: string,
  className: string,
  methodCode: string,
): string | null {
  return withSourceFile(source, (sf) => {
    const cls = sf.getClass(className);
    if (!cls) return null;

    const methodName = extractMethodName(methodCode);
    if (methodName && cls.getMethod(methodName)) {
      return sf.getFullText();
    }

    // ts-morph lacks a "raw insert" API; splice into the class body text.
    const openBrace = cls.getFirstChildByKindOrThrow(SyntaxKind.OpenBraceToken);
    const closeBrace = cls.getLastChildByKindOrThrow(SyntaxKind.CloseBraceToken);
    const body = sf.getFullText().slice(openBrace.getEnd(), closeBrace.getStart());
    const trimmed = body.replace(/\s+$/, '');
    const separator = trimmed.length === 0 ? '\n' : '\n\n';
    const updated =
      sf.getFullText().slice(0, openBrace.getEnd()) +
      trimmed +
      separator +
      indent(methodCode, 2) +
      '\n' +
      sf.getFullText().slice(closeBrace.getStart());
    sf.replaceWithText(updated);
    return sf.getFullText();
  });
}

/**
 * Add an element to an array literal property inside an object literal
 * passed to a decorator call (e.g., `@Module({ controllers: [...] })`).
 * Creates the property if missing. Idempotent on element text.
 */
export function addElementToDecoratorArray(
  source: string,
  decoratorName: string,
  propertyName: string,
  elementExpression: string,
): string | null {
  return withSourceFile(source, (sf) => {
    const cls = sf.getClasses().find((c) => c.getDecorator(decoratorName));
    if (!cls) return null;
    const decorator = cls.getDecoratorOrThrow(decoratorName);
    const args = decorator.getArguments();
    const arg = args[0];
    if (!arg || arg.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;

    const obj = arg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    let prop = obj.getProperty(propertyName);

    if (!prop) {
      obj.addPropertyAssignment({
        name: propertyName,
        initializer: `[${elementExpression}]`,
      });
      return sf.getFullText();
    }

    if (prop.getKind() !== SyntaxKind.PropertyAssignment) return null;
    const assignment = prop.asKindOrThrow(SyntaxKind.PropertyAssignment);
    const initializer = assignment.getInitializer();
    if (!initializer || initializer.getKind() !== SyntaxKind.ArrayLiteralExpression) return null;

    const arr = initializer.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
    const already = arr.getElements().some((e) => e.getText().trim() === elementExpression);
    if (already) return sf.getFullText();

    arr.addElement(elementExpression);
    return sf.getFullText();
  });
}

/**
 * Run `mutate` against a fresh in-memory source file. Returns whatever the
 * mutation returns; `null` signals "target not found" and should cause the
 * caller to fall back rather than write broken output.
 *
 * We create a new `Project` per call to avoid cross-file state leaks —
 * these transforms are surgical, not bulk refactors.
 */
function withSourceFile(
  source: string,
  mutate: (sf: SourceFile) => string | null,
): string | null {
  const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
  const sf = project.createSourceFile('input.ts', source, { scriptKind: ScriptKind.TS });
  try {
    return mutate(sf);
  } finally {
    project.removeSourceFile(sf);
  }
}

function extractMethodName(methodCode: string): string | null {
  // Matches `async foo(` / `foo(` / `public async foo(` at line start.
  const m = methodCode.match(/(?:^|\s)(?:async\s+)?(?:public\s+|private\s+|protected\s+)?(\w+)\s*\(/);
  return m ? m[1]! : null;
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length === 0 ? line : pad + line))
    .join('\n');
}
