import path from 'node:path';
import fs from 'fs-extra';

interface EnvEntry {
  key: string;
  value: string;
  comment?: string;
}

interface EnvValidationResult {
  valid: boolean;
  missingInEnv: string[];
  extraInEnv: string[];
  emptyRequired: string[];
}

interface EnvSyncResult {
  added: string[];
  alreadyPresent: number;
}

/**
 * Parse a .env file into structured entries.
 * Handles comments, empty lines, quoted values, and inline comments.
 */
function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  let pendingComment: string | undefined;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    if (line === '') {
      pendingComment = undefined;
      continue;
    }

    if (line.startsWith('#')) {
      pendingComment = line.slice(1).trim();
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      entries.push({ key, value, comment: pendingComment });
      pendingComment = undefined;
    }
  }

  return entries;
}

/**
 * Serialize entries back into .env format.
 */
function serializeEnvFile(entries: EnvEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    if (entry.comment) {
      lines.push(`# ${entry.comment}`);
    }
    const needsQuotes = entry.value.includes(' ') || entry.value.includes('#');
    const value = needsQuotes ? `"${entry.value}"` : entry.value;
    lines.push(`${entry.key}=${value}`);
  }

  return lines.join('\n') + '\n';
}

export class EnvManager {
  private readonly envPath: string;
  private readonly examplePath: string;

  constructor(projectRoot: string) {
    this.envPath = path.join(projectRoot, '.env');
    this.examplePath = path.join(projectRoot, '.env.example');
  }

  /**
   * Validate that .env contains all keys defined in .env.example.
   */
  async validate(): Promise<EnvValidationResult> {
    const exampleExists = await fs.pathExists(this.examplePath);
    const envExists = await fs.pathExists(this.envPath);

    if (!exampleExists) {
      return { valid: false, missingInEnv: [], extraInEnv: [], emptyRequired: [] };
    }

    const exampleEntries = parseEnvFile(await fs.readFile(this.examplePath, 'utf-8'));
    const exampleKeys = new Set(exampleEntries.map((e) => e.key));

    if (!envExists) {
      return {
        valid: false,
        missingInEnv: [...exampleKeys],
        extraInEnv: [],
        emptyRequired: [],
      };
    }

    const envEntries = parseEnvFile(await fs.readFile(this.envPath, 'utf-8'));
    const envMap = new Map(envEntries.map((e) => [e.key, e.value]));
    const envKeys = new Set(envEntries.map((e) => e.key));

    const missingInEnv = [...exampleKeys].filter((k) => !envKeys.has(k));
    const extraInEnv = [...envKeys].filter((k) => !exampleKeys.has(k));

    // Keys that exist in .env but have empty values while .env.example has a non-empty value
    const emptyRequired = exampleEntries
      .filter((e) => {
        const envValue = envMap.get(e.key);
        return envValue !== undefined && envValue === '' && e.value !== '';
      })
      .map((e) => e.key);

    return {
      valid: missingInEnv.length === 0 && emptyRequired.length === 0,
      missingInEnv,
      extraInEnv,
      emptyRequired,
    };
  }

  /**
   * Sync .env with .env.example — adds missing keys with default values.
   * Never removes keys from .env.
   */
  async sync(): Promise<EnvSyncResult> {
    const exampleExists = await fs.pathExists(this.examplePath);
    if (!exampleExists) {
      return { added: [], alreadyPresent: 0 };
    }

    const exampleEntries = parseEnvFile(await fs.readFile(this.examplePath, 'utf-8'));

    let envEntries: EnvEntry[] = [];
    if (await fs.pathExists(this.envPath)) {
      envEntries = parseEnvFile(await fs.readFile(this.envPath, 'utf-8'));
    }

    const existingKeys = new Set(envEntries.map((e) => e.key));
    const added: string[] = [];

    for (const example of exampleEntries) {
      if (!existingKeys.has(example.key)) {
        envEntries.push({
          key: example.key,
          value: '',
          comment: example.comment,
        });
        added.push(example.key);
      }
    }

    if (added.length > 0) {
      await fs.writeFile(this.envPath, serializeEnvFile(envEntries), 'utf-8');
    }

    return { added, alreadyPresent: existingKeys.size };
  }

  /**
   * Add a new environment variable to both .env and .env.example.
   */
  async addVariable(
    key: string,
    options: { defaultValue?: string; comment?: string; required?: boolean },
  ): Promise<void> {
    // Validate key format
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(
        `Invalid env key: "${key}". Keys must be UPPER_SNAKE_CASE (e.g., DATABASE_URL).`,
      );
    }

    const defaultValue = options.defaultValue ?? '';
    const comment = options.comment;

    // Add to .env.example
    await this.appendToFile(this.examplePath, key, defaultValue, comment);

    // Add to .env (with empty value so user fills it in)
    if (await fs.pathExists(this.envPath)) {
      const envContent = await fs.readFile(this.envPath, 'utf-8');
      const envEntries = parseEnvFile(envContent);
      const exists = envEntries.some((e) => e.key === key);
      if (!exists) {
        await this.appendToFile(this.envPath, key, '', comment);
      }
    }
  }

  private async appendToFile(
    filePath: string,
    key: string,
    value: string,
    comment?: string,
  ): Promise<void> {
    let content = '';
    if (await fs.pathExists(filePath)) {
      content = await fs.readFile(filePath, 'utf-8');
      if (!content.endsWith('\n')) content += '\n';
    }

    if (comment) {
      content += `# ${comment}\n`;
    }

    const needsQuotes = value.includes(' ') || value.includes('#');
    const formattedValue = needsQuotes ? `"${value}"` : value;
    content += `${key}=${formattedValue}\n`;

    await fs.writeFile(filePath, content, 'utf-8');
  }
}
