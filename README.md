# Pillar

AI-aware architecture engine — scaffold, generate, and maintain production-ready projects.

Pillar is not a scaffolding tool. It is an architecture engine that combines intelligent code generation with a living project map that minimizes AI context costs and maximizes developer speed.

## Install

```bash
npm install -g @pillar-cli/pillar
```

## Quick Start

```bash
# Create a new project
pillar init my-app

# Navigate into it
cd my-app

# Generate a full resource (model, service, controller, tests, etc.)
pillar add resource user

# Create a file with a registered purpose
pillar create src/utils/format-date.ts -p "date formatting helpers for UI display"

# Check project health
pillar doctor
```

## Commands

### `pillar init [project-name]`

Interactive wizard that scaffolds a complete project.

```
pillar init my-app

→ Platform?        [Web]
→ Category?        [API / Fullstack]
→ Stack?           [Express / Fastify / NestJS / Hono / Next.js]
→ Language?        [TypeScript / JavaScript]
→ Database?        [PostgreSQL / MongoDB / SQLite / None]
→ ORM?             [Prisma / Drizzle / TypeORM / Mongoose / None]
→ Architecture?    [Feature-first / Layered / Modular]
→ Package manager? [npm / yarn / pnpm]
→ Test framework?  [Vitest / Jest]
→ Extras?          [Docker / ESLint + Prettier / Git hooks]
```

Generates the full directory structure, installs all dependencies, creates the project map, and initializes git.

### `pillar create <file-path> -p <purpose>`

Create a file or directory with a registered purpose. The purpose is **required** — every file in a Pillar project has a documented reason to exist.

```bash
# Create a file (smart skeleton generated based on name + stack)
pillar create src/features/auth/auth.guard.ts -p "middleware that checks JWT validity"

# Create a directory
pillar create src/features/payments/ -p "handles payment processing and invoicing"

# Preview without creating
pillar create src/utils/cache.ts -p "in-memory cache wrapper" --dry-run
```

Short alias: `pillar c`

### `pillar add resource <name>`

Generate a complete resource with all associated files.

```bash
pillar add resource user
```

Generates (for feature-first architecture):

```
src/features/user/
├── user.model.ts        # Data model and type definitions
├── user.repository.ts   # Database queries and data access
├── user.service.ts      # Business logic
├── user.controller.ts   # HTTP request handlers
├── user.routes.ts       # Route definitions
├── user.validator.ts    # Input validation schemas
├── user.types.ts        # TypeScript interfaces
└── user.test.ts         # Unit and integration tests
```

Options:

```bash
--fields "name:string email:string age:number"   # Define fields
--no-test                                         # Skip test generation
--only service,controller                         # Generate specific files only
--dry-run                                         # Preview without creating
--force                                           # Overwrite existing files
```

### `pillar map`

View, refresh, or validate the project map.

```bash
# Display the map
pillar map

# Rebuild from filesystem (preserves existing purposes)
pillar map --refresh

# Check map matches actual files
pillar map --validate

# Export as JSON or markdown
pillar map --export json
pillar map --export markdown
```

Example output:

```
# Project Map: my-app

> Stack: express | Language: typescript | Architecture: feature-first

src/
├── features/              # Business features, each self-contained
│   ├── auth/              # Authentication: login, signup, JWT, sessions
│   │   ├── auth.controller.ts   # REST endpoints for auth flows
│   │   ├── auth.service.ts      # Business logic: token generation
│   │   └── auth.test.ts         # Unit + integration tests
│   └── user/              # User management and profiles
├── shared/                # Cross-feature utilities, no business logic
└── infra/                 # DB connections, middleware, error handling
```

### `pillar config`

View or modify project configuration.

```bash
pillar config list                        # Show full config
pillar config get project.stack           # Get a value
pillar config set generation.dryRun true  # Set a value
```

### `pillar doctor`

Run project health diagnostics.

```bash
pillar doctor

✔ pillar.config.json is valid
✔ All dependencies installed
✔ src/ directory exists
✔ All files are registered in the project map
✔ All map entries point to existing files
✔ Environment variables match .env.example
✔ .gitignore looks good

Health score: 100/100
```

### `pillar undo`

Revert the last generation operation. Deletes created files and restores modified ones.

```bash
pillar undo
```

## The Project Map

The project map is Pillar's core differentiator. It is a structured registry of every file and directory in your project, along with its purpose.

**Why it matters for AI:**

| Without map | With map |
|---|---|
| AI reads 50+ files to understand the project | AI reads 1 file |
| ~20,000 tokens of context | ~500 tokens |
| Slow, expensive, error-prone | Fast, cheap, accurate |

The map auto-updates whenever you use Pillar commands. Files created outside Pillar are flagged as "unmapped" by `pillar doctor`.

## Supported Stacks

| Stack | Category | Smart skeletons |
|---|---|---|
| Express | API | Controllers, routes, middleware |
| Fastify | API | Routes with Fastify plugin pattern |
| Hono | API | Hono router pattern |
| NestJS | API | Decorators, modules, DI |
| Next.js | Fullstack | App router, layouts, pages |

## Architecture Patterns

- **Feature-first** — each feature is self-contained in `src/features/<name>/`
- **Layered** — MVC-style separation: `src/controllers/`, `src/services/`, `src/repositories/`
- **Modular** — domain modules in `src/modules/<name>/`

## Safe Generation

Every generation command follows these rules:

- **No overwrite by default** — existing files are never silently replaced
- **Dry-run mode** — `--dry-run` on any command shows what would happen
- **Undo support** — `pillar undo` reverts the last operation
- **History tracking** — all operations are logged in `.pillar/history.json`

## Global Options

```bash
--verbose, -v    Enable debug logging
--version, -V    Show version
--help, -h       Show help
```

## Requirements

- Node.js >= 18.0.0

## License

MIT
