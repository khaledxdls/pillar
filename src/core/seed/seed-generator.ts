import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { MapNode } from '../map/types.js';
import { MapManager } from '../map/index.js';
import { resolveResourcePath } from '../../utils/resolve-resource-path.js';
import { escapeRegex } from '../../utils/sanitize.js';

interface SeedField {
  name: string;
  type: string;
}

interface GeneratedSeed {
  relativePath: string;
  content: string;
  purpose: string;
}

/**
 * Generate a seed file for a resource.
 * Reads the model/types file to discover fields and generates
 * deterministic fake data generators.
 */
export async function generateSeedFile(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
  count: number,
): Promise<GeneratedSeed> {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const isTS = config.project.language === 'typescript';
  const basePath = resolveResourcePath(config.project.architecture, resourceName);
  const seedDir = 'src/seeds';
  const seedPath = `${seedDir}/${resourceName}.seed.${ext}`;

  // Try to read fields from existing types/model
  const fields = await extractFields(projectRoot, basePath, resourceName, ext);

  const pascalName = resourceName.charAt(0).toUpperCase() + resourceName.slice(1);

  const content = generateSeedContent({
    resourceName,
    pascalName,
    fields,
    count,
    isTS,
    ext,
    basePath,
  });

  return {
    relativePath: seedPath,
    content,
    purpose: `Seed data generator for ${resourceName} (${count} records)`,
  };
}

/**
 * Generate the seed runner file that executes all seed files.
 */
export function generateSeedRunner(config: PillarConfig, seedFiles: string[]): GeneratedSeed {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const lines: string[] = [
    `// Purpose: Seed data runner — executes all seed files`,
    '',
  ];

  for (const file of seedFiles) {
    const name = path.basename(file, `.seed.${ext}`);
    lines.push(`import { seed as seed${capitalize(name)} } from './${name}.seed.js';`);
  }

  lines.push('');
  lines.push('async function runAllSeeds() {');
  lines.push('  console.log("Running seed files...");');
  lines.push('');

  for (const file of seedFiles) {
    const name = path.basename(file, `.seed.${ext}`);
    lines.push(`  console.log("  Seeding ${name}...");`);
    lines.push(`  await seed${capitalize(name)}();`);
    lines.push(`  console.log("  ✔ ${name} seeded");`);
    lines.push('');
  }

  lines.push('  console.log("All seeds complete.");');
  lines.push('}');
  lines.push('');
  lines.push('runAllSeeds().catch((err) => {');
  lines.push('  console.error("Seed failed:", err);');
  lines.push('  process.exit(1);');
  lines.push('});');
  lines.push('');

  return {
    relativePath: `src/seeds/run.${ext}`,
    content: lines.join('\n'),
    purpose: 'Seed runner — executes all seed files in order',
  };
}

interface SeedContentOptions {
  resourceName: string;
  pascalName: string;
  fields: SeedField[];
  count: number;
  isTS: boolean;
  ext: string;
  basePath: string;
}

function generateSeedContent(opts: SeedContentOptions): string {
  const { resourceName, pascalName, fields, count, isTS } = opts;
  const lines: string[] = [
    `// Purpose: Seed data generator for ${resourceName} (${count} records)`,
    '',
  ];

  // Generate a simple pseudo-random seeded generator (no external deps needed)
  lines.push(
    '// Simple seeded random for deterministic fake data',
    'let _seed = 42;',
    'function rand() { _seed = (_seed * 16807 + 0) % 2147483647; return (_seed - 1) / 2147483646; }',
    isTS
      ? 'function randInt(min: number, max: number) { return Math.floor(rand() * (max - min + 1)) + min; }'
      : 'function randInt(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }',
    isTS
      ? 'function randItem<T>(arr: T[]): T { return arr[Math.floor(rand() * arr.length)]!; }'
      : 'function randItem(arr) { return arr[Math.floor(rand() * arr.length)]; }',
    '',
  );

  // Name pools
  lines.push(
    'const FIRST_NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Hank"];',
    'const LAST_NAMES = ["Smith", "Jones", "Brown", "Wilson", "Taylor", "Clark", "Hall", "Lee"];',
    'const WORDS = ["quick", "lazy", "bright", "calm", "bold", "warm", "cool", "sharp"];',
    '',
  );

  // Generate function
  if (isTS) {
    lines.push(`interface ${pascalName}Seed {`);
    for (const field of fields) {
      lines.push(`  ${field.name}: ${mapToTSType(field.type)};`);
    }
    if (fields.length === 0) {
      lines.push('  // TODO: add fields');
    }
    lines.push('}');
    lines.push('');
  }

  lines.push(`function generate${pascalName}(index${isTS ? ': number' : ''})${isTS ? `: ${pascalName}Seed` : ''} {`);
  lines.push('  return {');

  if (fields.length === 0) {
    lines.push(`    // TODO: add field generators`);
  }

  for (const field of fields) {
    lines.push(`    ${field.name}: ${generateFakeValue(field, 'index')},`);
  }

  lines.push('  };');
  lines.push('}');
  lines.push('');

  // Export seed function
  lines.push(`export async function seed() {`);
  lines.push(`  const records = Array.from({ length: ${count} }, (_, i) => generate${pascalName}(i));`);
  lines.push('');
  lines.push('  // TODO: insert records into your database');
  lines.push(`  // Example with Prisma:`);
  lines.push(`  // const { PrismaClient } = await import('@prisma/client');`);
  lines.push(`  // const prisma = new PrismaClient();`);
  lines.push(`  // await prisma.${resourceName}.createMany({ data: records });`);
  lines.push('');
  lines.push(`  console.log(\`Generated \${records.length} ${resourceName} record(s)\`);`);
  lines.push('  return records;');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

async function extractFields(
  projectRoot: string,
  basePath: string,
  resourceName: string,
  ext: string,
): Promise<SeedField[]> {
  const typesPath = path.join(projectRoot, basePath, `${resourceName}.types.${ext}`);
  const modelPath = path.join(projectRoot, basePath, `${resourceName}.model.${ext}`);
  const targetPath = (await fs.pathExists(typesPath)) ? typesPath :
    (await fs.pathExists(modelPath)) ? modelPath : null;

  if (!targetPath) return [];

  const content = await fs.readFile(targetPath, 'utf-8');
  const fields: SeedField[] = [];

  // Match only the main resource interface to avoid pulling fields from ListResponse, etc.
  const pascalName = resourceName.charAt(0).toUpperCase() + resourceName.slice(1);
  const interfaceRegex = new RegExp(
    `export\\s+interface\\s+${escapeRegex(pascalName)}\\s*\\{([^}]*)}`,
  );
  const interfaceMatch = content.match(interfaceRegex);
  if (!interfaceMatch) return fields;

  const interfaceBody = interfaceMatch[1]!;
  const fieldRegex = /^\s+(\w+)\??\s*:\s*(\w+)/gm;
  let match: RegExpExecArray | null;

  while ((match = fieldRegex.exec(interfaceBody)) !== null) {
    const name = match[1]!;
    if (['id', 'createdAt', 'updatedAt'].includes(name)) continue;
    const type = match[2] ?? 'string';
    // Skip relation fields (types that start with uppercase are likely other models)
    if (/^[A-Z]/.test(type) && type !== 'Date' && type !== 'Record') continue;
    fields.push({ name, type });
  }

  return fields;
}

function generateFakeValue(field: SeedField, indexVar: string): string {
  const name = field.name.toLowerCase();
  const type = field.type.toLowerCase();

  // Smart matching by field name
  if (name.includes('email')) return '`${randItem(FIRST_NAMES).toLowerCase()}${' + indexVar + '}@example.com`';
  if (name.includes('name') && name.includes('first')) return 'randItem(FIRST_NAMES)';
  if (name.includes('name') && name.includes('last')) return 'randItem(LAST_NAMES)';
  if (name.includes('name')) return '`${randItem(FIRST_NAMES)} ${randItem(LAST_NAMES)}`';
  if (name.includes('phone')) return '`+1${randInt(200, 999)}${randInt(1000000, 9999999)}`';
  if (name.includes('url') || name.includes('website')) return '`https://example.com/${' + indexVar + '}`';
  if (name.includes('title')) return '`${randItem(WORDS)} ${randItem(WORDS)} ${' + indexVar + '}`';
  if (name.includes('description') || name.includes('bio')) return '`A ${randItem(WORDS)} description for item ${' + indexVar + '}`';
  if (name.includes('password')) return '"hashed_password_placeholder"';
  if (name.includes('price') || name.includes('amount')) return 'Math.round(rand() * 10000) / 100';
  if (name.includes('age')) return 'randInt(18, 80)';
  if (name.includes('count') || name.includes('quantity')) return 'randInt(1, 100)';

  // Fall back to type
  switch (type) {
    case 'string': return '`value_${' + indexVar + '}`';
    case 'number': return 'randInt(1, 1000)';
    case 'boolean': return 'rand() > 0.5';
    case 'date': return 'new Date(Date.now() - randInt(0, 365) * 86400000)';
    default: return '`value_${' + indexVar + '}`';
  }
}

function mapToTSType(type: string): string {
  const map: Record<string, string> = {
    string: 'string', number: 'number', boolean: 'boolean',
    date: 'Date', int: 'number', float: 'number',
  };
  return map[type.toLowerCase()] ?? 'string';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}


