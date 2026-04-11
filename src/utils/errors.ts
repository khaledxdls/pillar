export class PillarError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'PillarError';
  }
}

export class ConfigNotFoundError extends PillarError {
  constructor(path: string) {
    super(
      `No pillar.config.json found at ${path}`,
      'CONFIG_NOT_FOUND',
      'Run "pillar init" to create a new project, or navigate to an existing Pillar project.',
    );
    this.name = 'ConfigNotFoundError';
  }
}

export class FileExistsError extends PillarError {
  constructor(path: string) {
    super(
      `File already exists: ${path}`,
      'FILE_EXISTS',
      'Use --force to overwrite, or choose a different name.',
    );
    this.name = 'FileExistsError';
  }
}

export class InvalidConfigError extends PillarError {
  constructor(details: string) {
    super(
      `Invalid configuration: ${details}`,
      'INVALID_CONFIG',
      'Check pillar.config.json for errors.',
    );
    this.name = 'InvalidConfigError';
  }
}

export class MapIntegrityError extends PillarError {
  constructor(details: string) {
    super(
      `Project map integrity issue: ${details}`,
      'MAP_INTEGRITY',
      'Run "pillar map --refresh" to rebuild the map.',
    );
    this.name = 'MapIntegrityError';
  }
}
