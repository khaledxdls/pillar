import type { PillarConfig } from '../config/index.js';
import type { GeneratedFile } from './types.js';
import type { MapNode } from '../map/types.js';

interface ScaffoldResult {
  files: GeneratedFile[];
  mapStructure: Record<string, MapNode>;
}

/**
 * Generates the initial project structure based on config choices.
 */
export function scaffoldProject(config: PillarConfig): ScaffoldResult {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const files: GeneratedFile[] = [];
  const mapStructure: Record<string, MapNode> = {};

  // Core application files
  const appFiles = generateAppFiles(config, ext);
  files.push(...appFiles);

  // Architecture-specific structure
  const archFiles = generateArchitectureStructure(config, ext);
  files.push(...archFiles);

  // Build map structure from generated files
  buildMapStructure(files, mapStructure);

  // Config files at project root
  files.push(...generateRootFiles(config));

  return { files, mapStructure };
}

function generateAppFiles(config: PillarConfig, ext: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  switch (config.project.stack) {
    case 'express':
      files.push({
        relativePath: `src/app.${ext}`,
        content: generateExpressApp(config, ext),
        purpose: 'Express application setup and middleware configuration',
      });
      files.push({
        relativePath: `src/server.${ext}`,
        content: generateExpressServer(ext),
        purpose: 'HTTP server bootstrap and port binding',
      });
      break;

    case 'fastify':
      files.push({
        relativePath: `src/app.${ext}`,
        content: generateFastifyApp(config, ext),
        purpose: 'Fastify application setup and plugin registration',
      });
      files.push({
        relativePath: `src/server.${ext}`,
        content: generateFastifyServer(ext),
        purpose: 'HTTP server bootstrap and port binding',
      });
      break;

    case 'hono':
      files.push({
        relativePath: `src/app.${ext}`,
        content: generateHonoApp(ext),
        purpose: 'Hono application setup and middleware configuration',
      });
      files.push({
        relativePath: `src/server.${ext}`,
        content: generateHonoServer(ext),
        purpose: 'HTTP server bootstrap',
      });
      break;

    case 'nestjs':
      files.push({
        relativePath: `src/main.${ext}`,
        content: generateNestMain(ext),
        purpose: 'NestJS application bootstrap',
      });
      files.push({
        relativePath: `src/app.module.${ext}`,
        content: generateNestAppModule(),
        purpose: 'Root application module',
      });
      break;

    case 'nextjs':
      files.push({
        relativePath: `src/app/layout.tsx`,
        content: generateNextLayout(),
        purpose: 'Root layout component',
      });
      files.push({
        relativePath: `src/app/page.tsx`,
        content: generateNextPage(config.project.name),
        purpose: 'Home page component',
      });
      break;
  }

  return files;
}

function generateArchitectureStructure(config: PillarConfig, ext: string): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // Next.js has its own structure via the app router
  if (config.project.stack === 'nextjs') {
    files.push({
      relativePath: `src/lib/.gitkeep`,
      content: '',
      purpose: 'Shared library code and utilities',
    });
    files.push({
      relativePath: `src/components/.gitkeep`,
      content: '',
      purpose: 'Reusable UI components',
    });
    return files;
  }

  switch (config.project.architecture) {
    case 'feature-first':
      files.push({
        relativePath: `src/features/.gitkeep`,
        content: '',
        purpose: 'Business features, each self-contained',
      });
      files.push({
        relativePath: `src/shared/.gitkeep`,
        content: '',
        purpose: 'Cross-feature utilities and shared code',
      });
      files.push({
        relativePath: `src/infra/database.${ext}`,
        content: `// Purpose: Database connection and configuration\n\n// TODO: configure database connection\nexport {};\n`,
        purpose: 'Database connection and configuration',
      });
      files.push({
        relativePath: `src/infra/middleware.${ext}`,
        content: `// Purpose: Global middleware setup\n\n// TODO: configure global middleware\nexport {};\n`,
        purpose: 'Global middleware setup',
      });
      break;

    case 'layered':
      for (const layer of ['controllers', 'services', 'repositories', 'models']) {
        files.push({
          relativePath: `src/${layer}/.gitkeep`,
          content: '',
          purpose: `${layer.charAt(0).toUpperCase() + layer.slice(1)} layer`,
        });
      }
      files.push({
        relativePath: `src/middleware/.gitkeep`,
        content: '',
        purpose: 'Application middleware',
      });
      files.push({
        relativePath: `src/config/database.${ext}`,
        content: `// Purpose: Database connection and configuration\n\nexport {};\n`,
        purpose: 'Database connection and configuration',
      });
      break;

    case 'modular':
      files.push({
        relativePath: `src/modules/.gitkeep`,
        content: '',
        purpose: 'Application modules, each encapsulating a domain',
      });
      files.push({
        relativePath: `src/common/.gitkeep`,
        content: '',
        purpose: 'Shared utilities, guards, and decorators',
      });
      files.push({
        relativePath: `src/config/database.${ext}`,
        content: `// Purpose: Database connection and configuration\n\nexport {};\n`,
        purpose: 'Database connection and configuration',
      });
      break;
  }

  return files;
}

function generateRootFiles(config: PillarConfig): GeneratedFile[] {
  const files: GeneratedFile[] = [];

  // .env.example
  const envLines = ['NODE_ENV=development', 'PORT=3000'];
  if (config.database.type !== 'none') {
    envLines.push(`DATABASE_URL="your-${config.database.type}-connection-string"`);
  }
  files.push({
    relativePath: '.env.example',
    content: envLines.join('\n') + '\n',
    purpose: 'Environment variable template',
  });

  files.push({
    relativePath: '.env',
    content: envLines.map((l) => l.replace(/"your-.*"/, '""')).join('\n') + '\n',
    purpose: 'Local environment variables',
  });

  // Docker
  if (config.extras.docker) {
    files.push({
      relativePath: 'Dockerfile',
      content: generateDockerfile(config),
      purpose: 'Container build definition',
    });
    files.push({
      relativePath: 'docker-compose.yml',
      content: generateDockerCompose(config),
      purpose: 'Local development services',
    });
    files.push({
      relativePath: '.dockerignore',
      content: 'node_modules\ndist\n.git\n.env\n.pillar\n',
      purpose: 'Docker build exclusions',
    });
  }

  return files;
}

// --- Stack-specific app generators ---

function generateExpressApp(config: PillarConfig, ext: string): string {
  const lines = [
    `// Purpose: Express application setup and middleware configuration`,
    '',
    `import express from 'express';`,
    `import cors from 'cors';`,
    '',
    `const app = express();`,
    '',
    'app.use(cors());',
    'app.use(express.json());',
    'app.use(express.urlencoded({ extended: true }));',
    '',
    `app.get('/health', (_req, res) => {`,
    `  res.json({ status: 'ok', timestamp: new Date().toISOString() });`,
    '});',
    '',
    '// TODO: register feature routes here',
    '',
    'export { app };',
    '',
  ];
  return lines.join('\n');
}

function generateExpressServer(ext: string): string {
  return [
    `// Purpose: HTTP server bootstrap and port binding`,
    '',
    `import { app } from './app.js';`,
    '',
    `const PORT = process.env['PORT'] ?? 3000;`,
    '',
    `app.listen(PORT, () => {`,
    `  console.log(\`Server running on port \${PORT}\`);`,
    '});',
    '',
  ].join('\n');
}

function generateFastifyApp(config: PillarConfig, ext: string): string {
  return [
    `// Purpose: Fastify application setup and plugin registration`,
    '',
    `import Fastify from 'fastify';`,
    `import cors from '@fastify/cors';`,
    '',
    `export async function buildApp() {`,
    `  const app = Fastify({ logger: true });`,
    '',
    '  await app.register(cors);',
    '',
    `  app.get('/health', async () => {`,
    `    return { status: 'ok', timestamp: new Date().toISOString() };`,
    '  });',
    '',
    '  // TODO: register feature routes here',
    '',
    '  return app;',
    '}',
    '',
  ].join('\n');
}

function generateFastifyServer(ext: string): string {
  return [
    `// Purpose: HTTP server bootstrap and port binding`,
    '',
    `import { buildApp } from './app.js';`,
    '',
    `const PORT = Number(process.env['PORT'] ?? 3000);`,
    '',
    `async function start() {`,
    '  const app = await buildApp();',
    '  await app.listen({ port: PORT, host: "0.0.0.0" });',
    '}',
    '',
    'start().catch((err) => {',
    '  console.error(err);',
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
}

function generateHonoApp(ext: string): string {
  return [
    `// Purpose: Hono application setup and middleware configuration`,
    '',
    `import { Hono } from 'hono';`,
    `import { cors } from 'hono/cors';`,
    '',
    `const app = new Hono();`,
    '',
    'app.use(cors());',
    '',
    `app.get('/health', (c) => {`,
    `  return c.json({ status: 'ok', timestamp: new Date().toISOString() });`,
    '});',
    '',
    '// TODO: register feature routes here',
    '',
    'export { app };',
    '',
  ].join('\n');
}

function generateHonoServer(ext: string): string {
  return [
    `// Purpose: HTTP server bootstrap`,
    '',
    `import { serve } from '@hono/node-server';`,
    `import { app } from './app.js';`,
    '',
    `const PORT = Number(process.env['PORT'] ?? 3000);`,
    '',
    `serve({ fetch: app.fetch, port: PORT }, (info) => {`,
    `  console.log(\`Server running on port \${info.port}\`);`,
    '});',
    '',
  ].join('\n');
}

function generateNestMain(ext: string): string {
  return [
    `// Purpose: NestJS application bootstrap`,
    '',
    `import { NestFactory } from '@nestjs/core';`,
    `import { AppModule } from './app.module.js';`,
    '',
    `async function bootstrap() {`,
    `  const app = await NestFactory.create(AppModule);`,
    '  app.enableCors();',
    `  const port = process.env['PORT'] ?? 3000;`,
    '  await app.listen(port);',
    `  console.log(\`Server running on port \${port}\`);`,
    '}',
    '',
    'bootstrap();',
    '',
  ].join('\n');
}

function generateNestAppModule(): string {
  return [
    `// Purpose: Root application module`,
    '',
    `import { Module } from '@nestjs/common';`,
    '',
    '@Module({',
    '  imports: [],',
    '  controllers: [],',
    '  providers: [],',
    '})',
    'export class AppModule {}',
    '',
  ].join('\n');
}

function generateNextLayout(): string {
  return [
    `// Purpose: Root layout component`,
    '',
    `export const metadata = {`,
    `  title: 'App',`,
    `  description: 'Generated by Pillar',`,
    '};',
    '',
    'export default function RootLayout({ children }: { children: React.ReactNode }) {',
    '  return (',
    '    <html lang="en">',
    '      <body>{children}</body>',
    '    </html>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function generateNextPage(projectName: string): string {
  return [
    `// Purpose: Home page component`,
    '',
    `export default function Home() {`,
    '  return (',
    '    <main>',
    `      <h1>${projectName}</h1>`,
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
}

function generateDockerfile(config: PillarConfig): string {
  return [
    'FROM node:22-alpine AS base',
    'WORKDIR /app',
    '',
    'FROM base AS deps',
    'COPY package.json package-lock.json* ./',
    'RUN npm ci --omit=dev',
    '',
    'FROM base AS build',
    'COPY package.json package-lock.json* ./',
    'RUN npm ci',
    'COPY . .',
    'RUN npm run build',
    '',
    'FROM base AS runner',
    'ENV NODE_ENV=production',
    'COPY --from=deps /app/node_modules ./node_modules',
    'COPY --from=build /app/dist ./dist',
    'COPY package.json ./',
    '',
    'EXPOSE 3000',
    'CMD ["node", "dist/server.js"]',
    '',
  ].join('\n');
}

function generateDockerCompose(config: PillarConfig): string {
  const services: string[] = [
    'services:',
    '  app:',
    '    build: .',
    '    ports:',
    '      - "3000:3000"',
    '    env_file:',
    '      - .env',
  ];

  if (config.database.type === 'postgresql') {
    services.push(
      '    depends_on:',
      '      - postgres',
      '',
      '  postgres:',
      '    image: postgres:16-alpine',
      '    ports:',
      '      - "5432:5432"',
      '    environment:',
      '      POSTGRES_USER: pillar',
      '      POSTGRES_PASSWORD: pillar',
      `      POSTGRES_DB: ${config.project.name}`,
      '    volumes:',
      '      - pgdata:/var/lib/postgresql/data',
    );
  } else if (config.database.type === 'mongodb') {
    services.push(
      '    depends_on:',
      '      - mongo',
      '',
      '  mongo:',
      '    image: mongo:7',
      '    ports:',
      '      - "27017:27017"',
      '    volumes:',
      '      - mongodata:/data/db',
    );
  }

  services.push('');

  // Volumes
  if (config.database.type === 'postgresql') {
    services.push('volumes:', '  pgdata:', '');
  } else if (config.database.type === 'mongodb') {
    services.push('volumes:', '  mongodata:', '');
  }

  return services.join('\n');
}

function buildMapStructure(files: GeneratedFile[], structure: Record<string, MapNode>): void {
  for (const file of files) {
    // Only map src/ files
    if (!file.relativePath.startsWith('src/')) continue;

    const parts = file.relativePath.replace('src/', '').split('/');
    let current = structure;

    // Ensure we have a 'src' top-level entry
    if (!structure['src']) {
      structure['src'] = { purpose: 'Application source code', children: {} };
    }
    current = structure['src']!.children!;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;

      if (isLast) {
        if (part !== '.gitkeep') {
          current[part] = { purpose: file.purpose };
        }
      } else {
        if (!current[part]) {
          current[part] = { purpose: '', children: {} };
        }
        if (!current[part]!.children) {
          current[part]!.children = {};
        }
        current = current[part]!.children!;
      }
    }
  }

  // Set directory purposes from .gitkeep files
  for (const file of files) {
    if (!file.relativePath.endsWith('.gitkeep')) continue;
    const dir = file.relativePath.replace('src/', '').replace('/.gitkeep', '');
    const parts = dir.split('/');
    let current = structure['src']!.children!;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (i === parts.length - 1) {
        if (!current[part]) {
          current[part] = { purpose: file.purpose, children: {} };
        } else {
          current[part]!.purpose = file.purpose;
        }
      } else {
        if (!current[part]?.children) break;
        current = current[part]!.children!;
      }
    }
  }
}
