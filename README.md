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

# Generate a full resource with fields
pillar add resource user --fields "name:string email:string age:number"

# Start the dev server
npm run dev

# Check project health
pillar doctor
```

---

## Commands

### `pillar init [project-name]`

Interactive wizard that scaffolds a complete project.

```bash
pillar init my-app
```

Prompts:

```
-> Platform?        [Web]
-> Category?        [API / Fullstack]
-> Stack?           [Express / Fastify / NestJS / Hono / Next.js]
-> Language?        [TypeScript / JavaScript]
-> Database?        [PostgreSQL / MongoDB / SQLite / None]
-> ORM?             [Prisma / Drizzle / TypeORM / Mongoose / None]
-> Architecture?    [Feature-first / Layered / Modular]
-> Package manager? [npm / yarn / pnpm]
-> Test framework?  [Vitest / Jest]
-> Extras?          [Docker / ESLint + Prettier / Git hooks]
```

What it does:

- Generates the full directory structure with purpose-annotated files
- Creates `app.ts`, `server.ts`, infrastructure stubs
- Installs all dependencies
- Creates the project map (`.pillar/map.json`)
- Initializes git with an initial commit

Options:

| Flag | Description |
|------|-------------|
| `-y, --yes` | Skip prompts and use defaults |

---

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

The skeleton generator is context-aware — a file named `*.controller.ts` gets a controller scaffold, `*.service.ts` gets a service scaffold, `*.middleware.ts` gets a middleware scaffold with proper stack-specific type imports (Express, Fastify, Hono, or NestJS), etc.

Options:

| Flag | Description |
|------|-------------|
| `-p, --purpose <purpose>` | Purpose of the file **(required)** |
| `-f, --force` | Overwrite if file already exists |
| `--dry-run` | Preview content without creating |

---

### `pillar add resource <name>`

Generate a complete resource with all associated files, wire routes into the app entry file, and register everything in the project map.

```bash
pillar add resource user --fields "name:string email:string age:number isActive:boolean"
```

Generates (example for feature-first Express):

```
src/features/user/
  user.model.ts        # Data model + CreateInput + UpdateInput (with fields)
  user.repository.ts   # Database queries and data access (imports model type)
  user.service.ts      # Business logic (imports model type)
  user.controller.ts   # HTTP request handlers (stack-specific types)
  user.routes.ts       # Route definitions (GET, POST, PUT, DELETE)
  user.validator.ts    # Zod validation schemas (with field rules)
  user.types.ts        # TypeScript interfaces
  user.test.ts         # Unit and integration test stubs
```

For layered architecture, files are placed in their respective directories (`src/models/`, `src/services/`, `src/controllers/`, etc.) with correct cross-directory imports.

Auto-updates `src/app.ts` with stack-correct wiring:

```ts
// Express
import { userRouter } from './features/user/user.routes.js';
app.use('/users', userRouter);

// Fastify
import { userRoutes } from './features/user/user.routes.js';
app.register(userRoutes);

// Hono
import { userRoutes } from './features/user/user.routes.js';
app.route('/users', userRoutes);
```

Options:

| Flag | Description |
|------|-------------|
| `--fields <fields>` | Field definitions (e.g., `"name:string email:string age:number"`) |
| `--no-test` | Skip test file generation |
| `--only <types>` | Generate specific files only (e.g., `"service,controller"`) |
| `--dry-run` | Preview without creating |
| `-f, --force` | Overwrite existing files |

Supported field types: `string`, `number`, `boolean`, `date`, `int`, `float`, `uuid`, `json`

Field modifiers: `optional`, `unique` (e.g., `email:string:unique`)

---

### `pillar add field <resource> <fields...>`

Add fields to an existing resource. Updates the model, types, and validator files.

```bash
# Multiple fields as separate arguments
pillar add field user role:string department:string

# Or as a quoted string
pillar add field user "role:string department:string"
```

Options:

| Flag | Description |
|------|-------------|
| `-u, --unique` | Mark all fields as unique |
| `-o, --optional` | Mark all fields as optional |

---

### `pillar add endpoint <resource> <definition>`

Add a custom endpoint to a resource's controller and routes files.

```bash
pillar add endpoint user "GET /users/:id/posts"
pillar add endpoint user "POST /users/:id/avatar" -p "Upload user avatar"
```

The resource prefix is automatically stripped from the path to avoid duplication (since the router is already mounted at `/<resource>s`).

Options:

| Flag | Description |
|------|-------------|
| `-p, --purpose <text>` | Purpose/description of this endpoint |

---

### `pillar add relation <source> <target>`

Add a relation between two resources. Updates models, types, and repository on both sides. Adds proper import statements for the related types.

```bash
pillar add relation user post --type one-to-many
pillar add relation user profile --type one-to-one
pillar add relation student course --type many-to-many
```

What it does:

- Adds the relation field to the source model (e.g., `posts?: Post[]`)
- Adds the inverse field to the target model (e.g., `user?: User`)
- Adds `import type` statements with correct relative paths (works across layered directories)
- Adds a finder method to the source repository (with proper return type imports)

Options:

| Flag | Description |
|------|-------------|
| `-t, --type <type>` | `one-to-one`, `one-to-many`, or `many-to-many` (default: `one-to-many`) |

---

### `pillar add middleware <name>`

Generate a middleware file with stack-aware type imports (Express `NextFunction`, Fastify `HookHandlerDoneFunction`, Hono `Next`).

```bash
pillar add middleware auth
pillar add middleware rate-limit -p "Rate limiting per IP"
```

Options:

| Flag | Description |
|------|-------------|
| `-p, --purpose <text>` | Purpose of this middleware |
| `--dry-run` | Preview without creating |
| `-f, --force` | Overwrite if file exists |

---

### `pillar add linting`

Set up ESLint + Prettier with recommended configs.

```bash
pillar add linting
```

What it does:

- Creates `eslint.config.mjs` (flat config) and `.prettierrc`
- Installs `eslint`, `prettier`, `eslint-config-prettier`, `@typescript-eslint/*`
- Adds `lint`, `lint:fix`, `format`, and `format:check` scripts to `package.json`

---

### `pillar add git-hooks`

Set up Husky + lint-staged for pre-commit checks.

```bash
pillar add git-hooks
```

What it does:

- Installs `husky` and `lint-staged`
- Initializes husky
- Configures pre-commit hook to run ESLint and Prettier on staged files

---

### `pillar map`

View, refresh, or validate the project map.

```bash
# Display the map as a tree
pillar map

# Rebuild from filesystem (preserves existing purposes)
pillar map --refresh

# Check map matches actual files
pillar map --validate

# Export as JSON or Markdown
pillar map --export json
pillar map --export markdown

# Set the purpose of a specific file or directory
pillar map --purpose src/utils "Shared utility functions"
```

Example output:

```
# Project Map: my-app

> Stack: express | Language: typescript | Architecture: feature-first

src/
  features/              # Business features, each self-contained
    user/
      user.controller.ts   # HTTP request handlers for user
      user.service.ts      # Business logic for user
      user.routes.ts       # Route definitions for user endpoints
      user.model.ts        # Data model and type definitions for user
      ...
  shared/                # Cross-feature utilities
  infra/                 # Infrastructure layer: DB, middleware, external services
    database.ts            # Database connection and configuration
    middleware.ts          # Global middleware setup
  app.ts                 # Express application setup and middleware configuration
  server.ts              # HTTP server bootstrap and port binding
```

Options:

| Flag | Description |
|------|-------------|
| `--refresh` | Rebuild map from filesystem |
| `--validate` | Check map against actual files |
| `--export <format>` | Export as `json` or `markdown` |
| `--purpose <path> <text>` | Set the purpose of a file or directory |

---

### `pillar ai <request>`

AI-powered feature generation using the project map for context. Supports OpenAI and Anthropic.

```bash
# Requires OPENAI_API_KEY or ANTHROPIC_API_KEY env var
pillar ai "add a search endpoint to product that filters by name and price range"

# Preview the plan without applying
pillar ai "add pagination to all list endpoints" --dry-run

# Use a specific provider/model
pillar ai "add auth middleware" --provider anthropic --model claude-sonnet-4-20250514
```

How it works:

1. **Pass 1**: Sends the project map (~500 tokens) + your request to the AI
2. **Pass 2**: Reads the actual files that need modification, sends enriched context for a refined plan
3. **Preview**: Shows a unified diff of all planned changes
4. **Confirm**: You approve or reject before any files are modified
5. **Execute**: Creates/modifies files, updates the project map, records history

The AI understands your project's stack, architecture, and existing structure. It modifies controllers, services, repositories, and routes with proper patterns for your chosen framework.

Options:

| Flag | Description |
|------|-------------|
| `--provider <name>` | `openai` or `anthropic` |
| `--model <name>` | Model name override (e.g., `gpt-4o`, `claude-sonnet-4-20250514`) |
| `--dry-run` | Show the plan and diff without executing |

---

### `pillar docs`

API documentation generation and serving.

#### `pillar docs generate`

Generate an OpenAPI 3.0.3 spec from your routes and models.

```bash
pillar docs generate
pillar docs generate -o api-spec.json
```

What it does:

- Scans the project map to discover resources
- Extracts fields from model/types files
- Generates paths for standard CRUD endpoints
- Produces component schemas for each resource

Options:

| Flag | Description |
|------|-------------|
| `-o, --output <path>` | Output file path (default: `docs/openapi.json`) |

#### `pillar docs serve`

Launch a Swagger UI to browse the API documentation.

```bash
pillar docs serve
pillar docs serve --port 8080
```

Options:

| Flag | Description |
|------|-------------|
| `-p, --port <port>` | Port to serve on (default: `4000`) |
| `-o, --output <path>` | OpenAPI spec file path (default: `docs/openapi.json`) |

---

### `pillar test generate <path>`

Generate test files for a file or directory. Creates test stubs that import the correct modules and set up describe/it blocks for each method.

```bash
# Generate tests for an entire resource
pillar test generate src/features/user

# Generate tests for a specific file
pillar test generate src/features/user/user.service.ts
```

Options:

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview without creating |
| `-f, --force` | Overwrite existing test files |

---

### `pillar seed`

Generate and run deterministic seed data.

#### `pillar seed generate <resource>`

Generate a seed file with fake data generators. Field-aware: reads the resource's model to generate appropriate fake values (emails get email-shaped data, ages get numbers in the 18-80 range, etc.).

```bash
pillar seed generate user
pillar seed generate user --count 100
```

Options:

| Flag | Description |
|------|-------------|
| `-c, --count <number>` | Number of records to generate (default: `20`) |
| `--dry-run` | Preview without creating |

#### `pillar seed run`

Execute all seed files.

```bash
pillar seed run
```

---

### `pillar doctor`

Run project health diagnostics. Checks config, dependencies, project structure, map integrity, environment variables, gitignore, TypeScript config, circular dependencies, and type errors.

```bash
pillar doctor

  Pillar Doctor

  ✔ pillar.config.json is valid
  ✔ All dependencies installed
  ✔ src/ directory exists
  ✔ All files are registered in the project map
  ✔ All map entries point to existing files
  ✔ Environment variables match .env.example
  ✔ .gitignore looks good
  ✔ tsconfig.json is valid
  ✔ No circular dependencies detected
  ✔ No TypeScript errors

  Health score: 100/100
```

Use `--fix` to auto-fix fixable issues (stale map entries, unmapped files, missing .gitignore entries, missing env keys).

```bash
pillar doctor --fix
```

Options:

| Flag | Description |
|------|-------------|
| `--fix` | Auto-fix fixable issues |

Checks performed:

| Check | What it verifies |
|-------|-----------------|
| Configuration | `pillar.config.json` exists and is valid |
| Dependencies | All `package.json` deps are installed in `node_modules` |
| Project structure | `src/` directory exists |
| Unmapped files | All `src/` files are registered in the project map |
| Missing files | All map entries point to files that exist on disk |
| Environment | `.env` keys match `.env.example` |
| .gitignore | Contains `node_modules`, `.env`, `dist` |
| TypeScript config | `tsconfig.json` is valid JSON |
| Circular dependencies | No import cycles in `src/` |
| Type checking | `tsc --noEmit` reports no errors |

---

### `pillar env`

Manage environment variables.

#### `pillar env validate`

Check that `.env` contains all keys from `.env.example`.

```bash
pillar env validate
```

#### `pillar env sync`

Copy missing keys from `.env.example` to `.env` with empty values.

```bash
pillar env sync
```

#### `pillar env add <key>`

Add a new environment variable to both `.env` and `.env.example`.

```bash
pillar env add DATABASE_URL -d "postgresql://localhost:5432/mydb" -c "Primary database" -r
```

Options:

| Flag | Description |
|------|-------------|
| `-d, --default <value>` | Default value (written to `.env.example`) |
| `-c, --comment <text>` | Comment describing the variable |
| `-r, --required` | Mark as required |

---

### `pillar explain <path>`

Explain what a file or folder does based on the project map. Shows the file's purpose, its location in the hierarchy, and (for directories) its contents.

```bash
pillar explain src/features/user
pillar explain src/app.ts
```

---

### `pillar rename <old-name> <new-name>`

Rename a resource: folder, all files, class names, variable names, import paths, and map entries.

```bash
# Preview first
pillar rename post article --dry-run

# Apply
pillar rename post article
```

What it renames:

- Resource directory or individual files (supports all architecture patterns including layered)
- All contained files (`post.controller.ts` -> `article.controller.ts`)
- PascalCase identifiers (`PostController` -> `ArticleController`, `PostService` -> `ArticleService`)
- camelCase identifiers (`postService` -> `articleService`, `postRouter` -> `articleRouter`)
- Import paths in files that reference the resource
- Project map entries

Safe against false positives: HTTP methods like `router.post()` are not renamed.

Options:

| Flag | Description |
|------|-------------|
| `--dry-run` | Preview all changes without applying |

---

### `pillar undo`

Revert the last generation operation. Deletes created files and restores modified ones to their previous content.

```bash
pillar undo
```

Works for all operations: `add resource`, `add field`, `add endpoint`, `add relation`, `rename`, `ai`, `create`, etc.

---

### `pillar eject`

Remove all Pillar metadata files (`.pillar/` directory and `pillar.config.json`), leaving your generated source code completely intact.

```bash
pillar eject
```

You can re-initialize at any time with `pillar init`.

---

### `pillar config`

View or modify project configuration.

```bash
pillar config list                        # Show full config
pillar config get project.stack           # Get a value
pillar config set database.type postgresql  # Set a value (validated)
```

Configuration is stored in `pillar.config.json` and covers:

| Section | Keys |
|---------|------|
| `project` | `name`, `platform`, `category`, `stack`, `language`, `architecture`, `packageManager` |
| `database` | `type`, `orm` |
| `generation` | `overwrite`, `dryRun`, `testFramework`, `purposeRequired` |
| `map` | `autoUpdate`, `format` |
| `extras` | `docker`, `linting`, `gitHooks` |

---

## The Project Map

The project map is Pillar's core differentiator. It is a structured registry of every file and directory in your project, along with its purpose.

**Why it matters for AI:**

| Without map | With map |
|---|---|
| AI reads 50+ files to understand the project | AI reads 1 file |
| ~20,000 tokens of context | ~500 tokens |
| Slow, expensive, error-prone | Fast, cheap, accurate |

The map is stored in `.pillar/map.json` and auto-updates whenever you use Pillar commands. Files created outside Pillar are flagged as "unmapped" by `pillar doctor`.

---

## Supported Stacks

| Stack | Category | Smart Skeletons |
|---|---|---|
| **Express** | API | Controllers with `Request`/`Response` types, `Router`-based routes, middleware with `NextFunction` |
| **Fastify** | API | Routes with `FastifyInstance` plugin pattern, `FastifyRequest`/`FastifyReply` typing, scoped route registration |
| **Hono** | API | `Hono` router, `Context`-based handlers with `c.json()`/`c.req.param()` |
| **NestJS** | API | Decorators (`@Controller`, `@Get`, `@Post`), modules, dependency injection |
| **Next.js** | Fullstack | App router, layouts, pages, components |

---

## Architecture Patterns

| Pattern | Structure | Best for |
|---------|-----------|----------|
| **Feature-first** | `src/features/<name>/` — each feature is self-contained | Most projects, scales well |
| **Layered** | `src/controllers/`, `src/services/`, `src/models/`, `src/repositories/` — files grouped by type | Simple CRUD APIs |
| **Modular** | `src/modules/<name>/` — domain modules | Large apps, DDD |

All commands (`add resource`, `add field`, `add endpoint`, `add relation`, `rename`, `seed`, `test generate`) work correctly across all three architecture patterns. Cross-directory imports are resolved automatically.

---

## Safe Generation

Every generation command follows these rules:

- **No overwrite by default** — existing files are never silently replaced
- **Dry-run mode** — `--dry-run` on any command shows what would happen
- **Undo support** — `pillar undo` reverts the last operation
- **Diff preview** — AI generation shows a full unified diff before applying
- **Confirmation prompts** — destructive operations (rename, AI apply, eject) require confirmation
- **History tracking** — all operations are logged in `.pillar/history.json`

---

## Global Options

```
--verbose, -v    Enable debug logging
--version, -V    Show version
--help, -h       Show help for any command
```

---

## Full Command Reference

| Command | Description |
|---------|-------------|
| `pillar init [name]` | Scaffold a new project |
| `pillar create <path> -p <purpose>` | Create a file/directory with purpose |
| `pillar add resource <name>` | Generate a full resource (8 files + route wiring) |
| `pillar add field <resource> <fields...>` | Add fields to an existing resource |
| `pillar add endpoint <resource> <def>` | Add a custom endpoint |
| `pillar add relation <source> <target>` | Add a relation between resources |
| `pillar add middleware <name>` | Generate a middleware file |
| `pillar add linting` | Set up ESLint + Prettier |
| `pillar add git-hooks` | Set up Husky + lint-staged |
| `pillar map` | View/refresh/validate the project map |
| `pillar ai <request>` | AI-powered code generation |
| `pillar docs generate` | Generate OpenAPI spec |
| `pillar docs serve` | Launch Swagger UI |
| `pillar test generate <path>` | Generate test stubs |
| `pillar seed generate <resource>` | Generate seed data |
| `pillar seed run` | Execute all seed files |
| `pillar doctor` | Run health diagnostics |
| `pillar env validate` | Check .env against .env.example |
| `pillar env sync` | Sync missing env keys |
| `pillar env add <key>` | Add an environment variable |
| `pillar explain <path>` | Explain a file/folder's purpose |
| `pillar rename <old> <new>` | Rename a resource everywhere |
| `pillar undo` | Revert the last operation |
| `pillar eject` | Remove Pillar metadata |
| `pillar config list` | Show full configuration |
| `pillar config get <key>` | Get a config value |
| `pillar config set <key> <value>` | Set a config value |

---

## Requirements

- Node.js >= 18.0.0

## License

MIT
