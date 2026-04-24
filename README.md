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
| `--stack <stack>` | `express`, `fastify`, `nestjs`, `hono`, `nextjs` |
| `--category <cat>` | `api` or `fullstack` |
| `--language <lang>` | `typescript` or `javascript` |
| `--database <db>` | `postgresql`, `mongodb`, `sqlite`, `none` |
| `--orm <orm>` | `prisma`, `drizzle`, `typeorm`, `mongoose`, `none` |
| `--architecture <arch>` | `feature-first`, `layered`, `modular` |
| `--package-manager <pm>` | `npm`, `yarn`, `pnpm` |
| `--test-framework <fw>` | `vitest` or `jest` |
| `--extras <list>` | Comma-separated: `docker,linting,gitHooks` |
| `--skip-install` | Skip `npm install` (useful for CI / E2E harnesses) |
| `--skip-git` | Skip git repository initialization |

Any flag presence auto-enables non-interactive mode — `-y` is optional when overrides are provided. Invalid values fail fast with the allowed list.

```bash
# Fully non-interactive — great for CI / scripts
pillar init my-api \
  --stack fastify --category api --language typescript \
  --database postgresql --orm drizzle \
  --architecture feature-first \
  --package-manager pnpm --test-framework vitest \
  --skip-install --skip-git
```

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
| `--preview` | Show a unified diff of every file the command would write — nothing touches disk |
| `--dry-run` | Deprecated alias for `--preview` |
| `-f, --force` | Overwrite existing files |

Supported field types: `string`, `number`, `boolean`, `date`, `int`, `float`, `uuid`, `json`

`--preview` is supported on `add resource`, `add field`, `add endpoint`, and `add relation`. The preview is byte-exact: the same plan is rendered as a diff and (without `--preview`) executed — what you see is what you get.

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

### `pillar add auth --strategy jwt`

Scaffold a complete, stack-aware JWT authentication module in one command.

```bash
pillar add auth --strategy jwt
```

Generates (paths vary by architecture — example is feature-first):

```
src/features/auth/
  auth.types.ts        # AuthUser, PublicUser, AuthResponse
  auth.validator.ts    # Zod schemas for register/login (+ inferred types)
  auth.repository.ts   # User persistence (in-memory stub — swap for your DB)
  jwt.util.ts          # Sign/verify JWTs (enforces a 16-char secret minimum)
  auth.service.ts      # register, login, token introspection (timing-safe)
  auth.controller.ts   # Stack-specific HTTP handlers
  auth.middleware.ts   # Bearer-token verification (Express/Fastify/Hono)
  auth.routes.ts       # POST /auth/register, POST /auth/login, GET /auth/me
```

Stack-aware emission:

| Stack | What you get |
|-------|--------------|
| **Express / Fastify / Hono** | controller + middleware + routes, auto-registered in `app.ts` |
| **NestJS** | controller + `AuthGuard` + `AuthModule` (auto-added to `AppModule.imports`) |
| **Next.js** | App Router handlers at `src/app/api/auth/{register,login,me}/route.ts` |

Side effects (all recorded in history — a single `pillar undo` reverses the entire scaffold):

- Adds `jsonwebtoken` + `bcryptjs` (+ `@types/*`) to `package.json`
- Adds `JWT_SECRET` + `JWT_EXPIRES_IN` to `.env` and `.env.example`
- Wires the router/module into the app entry

Security defaults:

- `bcrypt` with 12 rounds, 72-byte password cap (bcrypt truncates past that)
- Constant-time login — runs `bcrypt.compare` even when the user doesn't exist to prevent enumeration via timing
- `jwt.util` throws at startup if `JWT_SECRET` is missing or shorter than 16 chars

Options:

| Flag | Description |
|------|-------------|
| `-s, --strategy <strategy>` | Auth strategy (currently: `jwt`) |
| `--dry-run` | Preview files/deps/env changes without writing |
| `-f, --force` | Overwrite existing files |
| `--files-only` | Emit files only — skip `package.json` / env / app wiring |

---

### `pillar add middleware <name>`

Generates a middleware file. **Known production kinds** (`cors`, `rate-limit`, `helmet`, `request-id`) get a full stack-aware scaffold: template, npm deps, env keys, and AST wiring into the app entry. Any other name falls back to a generic stub with stack-aware type imports (Express `NextFunction`, Fastify `HookHandlerDoneFunction`, Hono `Next`).

```bash
pillar add middleware cors          # CORS with CORS_ORIGIN env-driven policy
pillar add middleware rate-limit    # Per-IP rate limiter (RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX)
pillar add middleware helmet        # Secure HTTP headers (CSP, HSTS, frame-options, …)
pillar add middleware request-id    # Correlation ID (honors inbound x-request-id)

pillar add middleware my-custom -p "Feature-flag gate"   # generic stub fallback
```

**Known kinds — stack-aware emission:**

| Kind | Express | Fastify | NestJS | Hono | Next.js |
|------|---------|---------|--------|------|---------|
| `cors` | `cors` + `@types/cors`, `app.use(corsMiddleware())` | `@fastify/cors` registered in factory | built-in `app.enableCors(corsOptions)` (no npm dep) | `hono/cors` (built-in) | helper only (no auto-wiring) |
| `rate-limit` | `express-rate-limit`, `app.use(rateLimiter)` | `@fastify/rate-limit` registered in factory | `express-rate-limit`, `app.use(rateLimiter)` in `main.ts` | `hono-rate-limiter` | in-memory token bucket helper |
| `helmet` | `helmet`, `app.use(securityHeaders())` | `@fastify/helmet` registered in factory | `helmet`, `app.use(securityHeaders())` in `main.ts` | no-dep header middleware | header helper only |
| `request-id` | no deps, `app.use(requestId())` | no deps, `onRequest` hook | no deps (structurally typed — no `@types/express` needed) | no deps, `app.use('*', requestId)` | `resolveRequestId(req)` helper |

**Side effects** (known kinds, unless `--files-only`):

- Writes `src/middleware/<kind>.middleware.ts`.
- Merges deps into `package.json` (never downgrades pinned versions).
- Adds env keys to `.env` and `.env.example` (idempotent) — `CORS_ORIGIN` for `cors`, `RATE_LIMIT_WINDOW_MS` + `RATE_LIMIT_MAX` for `rate-limit`.
- Splices `import` + registration statement into `src/app.ts` (Express/Fastify/Hono) or `src/main.ts` (NestJS) via AST — idempotent, so re-running is safe.
- Records a single history entry; `pillar undo` reverses the whole scaffold in one step.
- Next.js emissions are helper-only (no auto-wiring at the edge) — integrate from your `src/middleware.ts` or inside route handlers.

Options:

| Flag | Description |
|------|-------------|
| `-p, --purpose <text>` | Purpose (used by the generic fallback; ignored for known kinds) |
| `--dry-run` | Preview files, deps, env keys, and the wiring target without writing |
| `-f, --force` | Overwrite existing middleware file |
| `--files-only` | Emit files only — skip `package.json` / `.env` / app-entry wiring (known kinds only) |

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

### `pillar db`

Database migration commands with production-safety guards and a preview mode that prints the exact argv (and SQL diff, for Prisma) without touching the database.

```bash
pillar db generate --name add_user_role    # create a migration without applying it
pillar db migrate  --name add_user_role    # create + apply in development
pillar db deploy                           # apply pending migrations (production path)
pillar db status                           # show applied vs. pending migrations
pillar db reset   --confirm <project-name> # drop + re-apply from scratch (dev only)
pillar db rollback                         # revert the most recent migration (ORMs that support it)

# Preview any command — prints the exact argv, cwd, destructive/applies flags, and (Prisma) SQL diff
pillar db migrate --name add_role --preview
pillar db deploy --preview
```

**ORM support matrix** — operations return a typed `Unsupported` result (not a crash) when the ORM has no equivalent:

| Operation | Prisma | Drizzle | TypeORM | Mongoose | None |
|-----------|--------|---------|---------|----------|------|
| `generate` | `migrate dev --create-only` | `drizzle-kit generate` | `migration:generate` | hint: migrate-mongo | hint: config |
| `migrate`  | `migrate dev` | `drizzle-kit migrate` | `migration:run` | hint | hint |
| `deploy`   | `migrate deploy` | `drizzle-kit migrate` | `migration:run` | hint | hint |
| `status`   | `migrate status` | unsupported | `migration:show` | hint | hint |
| `reset`    | `migrate reset --force` | unsupported | custom (drop + run) | hint | hint |
| `rollback` | unsupported (no native) | unsupported | `migration:revert` | hint | hint |

**Production safety:**

- Destructive commands (`migrate`, `reset`, `rollback`) **refuse to run with `NODE_ENV=production`** unless you pass `--force-production`. `deploy` is always allowed — it's the production path by design.
- `reset` requires an explicit confirmation token: `--confirm <project-name>`. The token must match the `project.name` in `pillar.config.json`, which catches "wrong terminal" accidents that a bare `--yes` would miss.
- The command uses `spawn` (no shell), so there is no shell-injection surface from migration names.

**Preview mode** (`--preview`):

- Prints the exact argv, cwd, destructive flag, and applies-to-DB flag — nothing is executed.
- For Prisma, also prints the SQL diff of the next migration via `prisma migrate diff --script` (best-effort — falls back silently if the shadow DB isn't configured).

Options (all subcommands):

| Flag | Description |
|------|-------------|
| `--preview` | Print the plan and exit. No DB or filesystem writes. |
| `--name <slug>` | Migration name (required by `generate` / `migrate` on Prisma and TypeORM) |
| `--yes` | Skip confirmation prompts where applicable |
| `--confirm <token>` | Required for `reset` — must match `project.name` |
| `--force-production` | Allow destructive commands with `NODE_ENV=production` |

Configuration — an optional `database.migrations` block in `pillar.config.json` lets you override adapter defaults:

```json
{
  "database": {
    "type": "postgresql",
    "orm": "prisma",
    "migrations": {
      "directory": "prisma/migrations",
      "schema": "prisma/schema.prisma",
      "autoGenerateOnFieldAdd": false
    }
  }
}
```

The block is optional and backwards-compatible — projects created before `pillar db` existed continue to work with adapter defaults.

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

# Skip the confirm prompt (useful in scripts and CI)
pillar ai "wire health route into the app" --yes

# Dump the raw JSON plan the model returned (debugging)
pillar ai "add rate limiting" --print-plan

# Use a specific provider/model
pillar ai "add auth middleware" --provider anthropic --model claude-sonnet-4-6

# Last run's plan didn't type-check? Replay it with tsc errors as feedback
pillar ai --retry --yes
```

### Retry with type-checker feedback

Every successful `pillar ai` run writes a snapshot to `.pillar/ai-last.json` (request, provider, model, affected files, timestamp). Running `pillar ai --retry` replays that request — but first runs `tsc --noEmit`, captures the errors (capped at 60 lines / 8KB), and appends them to the prompt. The model sees both the original intent and the concrete failures it needs to fix.

Typical flow:

```bash
pillar ai "add a search method to products"    # AI generates, but tsc fails
pillar ai --retry --yes                        # auto-fix with tsc feedback
```

Falls back with a clear message when there's no snapshot, no `tsconfig.json`, or tsc reports no errors.

How it works:

1. **Pass 1**: Sends the project map (~500 tokens, capped at 200 entries) + your request to the AI
2. **Pass 2**: Reads the actual files that need modification (32 KB byte budget) and sends enriched context for a refined plan
3. **Preview**: Shows a unified diff and any structured warnings (`skip-existing`, `skip-missing`, `outside-root`, `noop-modify`)
4. **Confirm**: You approve or reject before any files are modified (or pass `--yes` to skip)
5. **Execute**: Creates/modifies files, updates the project map, records history for `pillar undo`

The AI understands your project's stack, architecture, and existing structure. It defers full CRUD scaffolding to the CLI (`pillar add resource`, `pillar add middleware`, `pillar add auth`) — the model is reserved for custom logic, integrations, and refactors. This keeps prompts under ~500 tokens of context.

**Safety:** the response is validated against a strict Zod schema before any file touches disk. Plan size, file count, content bytes, and path safety (no absolute paths, no `..`, no URL schemes, no NUL bytes) are all enforced. On schema-validation failure the model gets one chance to self-correct with the exact errors. Transient HTTP failures (timeouts, 429, 5xx) retry with exponential backoff and honor `Retry-After`.

**Token reporting:** real billed tokens are read from the provider's `usage` block (not estimated) and surfaced as `Provider usage: <N> tokens across <P> pass(es) — <provider>/<model>`.

Options:

| Flag | Description |
|------|-------------|
| `--provider <name>` | `openai` or `anthropic` (auto-detected from env if omitted) |
| `--model <name>` | Model override — defaults: `gpt-4o` (OpenAI), `claude-sonnet-4-6` (Anthropic) |
| `--dry-run` | Show the plan and diff without writing files |
| `-y, --yes` | Skip the confirm prompt — apply the plan immediately |
| `--print-plan` | Print the raw JSON plan returned by the model (debugging) |
| `--retry` | Replay the last AI request with `tsc --noEmit` errors fed back as extra context |

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

### `pillar lint architecture`

Static analysis that enforces the architectural pattern chosen at `init`. Catches layering violations, cross-feature imports, DB driver leaks, and circular dependencies before they reach review.

```bash
pillar lint architecture          # human-readable report; exits 1 on errors
pillar lint arch                  # short alias
pillar lint architecture --json   # machine-readable output for CI
pillar lint architecture --no-strict   # never fail the exit code
```

Rules applied:

| ID | Rule |
|----|------|
| `AL001` | Controllers must not import repositories directly (go through the service). |
| `AL002` | Repositories must not depend on services (wrong layer direction). |
| `AL003` | Feature-first projects: no cross-feature imports between `src/features/*`. |
| `AL004` | Modular projects: no cross-module imports between `src/modules/*`. |
| `AL005` | Database drivers (`pg`, `mongodb`, `@prisma/client`, `drizzle-orm/*`, `typeorm/*`, etc.) may only be imported from repositories or models. |
| `AL006` | No circular dependencies anywhere under `src/`. |

Test files (`*.test.*`, `*.spec.*`) are excluded so integration fixtures can legitimately cross layers.

Options:

| Flag | Description |
|------|-------------|
| `--no-strict` | Do not exit with code 1 on errors |
| `--json` | Emit machine-readable JSON for CI integration |

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
| `pillar add auth --strategy jwt` | Scaffold a JWT authentication module |
| `pillar add middleware <kind>` | Scaffold middleware — `cors`, `rate-limit`, `helmet`, `request-id` (stack-aware + wired), or any name (generic stub) |
| `pillar add linting` | Set up ESLint + Prettier |
| `pillar add git-hooks` | Set up Husky + lint-staged |
| `pillar db <op>` | Database migrations — `generate`, `migrate`, `deploy`, `status`, `reset`, `rollback` (Prisma/Drizzle/TypeORM; `--preview` everywhere) |
| `pillar map` | View/refresh/validate the project map |
| `pillar ai <request>` | AI-powered code generation |
| `pillar docs generate` | Generate OpenAPI spec |
| `pillar docs serve` | Launch Swagger UI |
| `pillar test generate <path>` | Generate test stubs |
| `pillar seed generate <resource>` | Generate seed data |
| `pillar seed run` | Execute all seed files |
| `pillar doctor` | Run health diagnostics |
| `pillar lint architecture` | Enforce the chosen architectural pattern |
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

## Development

```bash
npm run build          # Compile TypeScript to dist/
npm run dev            # Watch mode
npm test               # Run all unit tests (vitest)
npm run test:watch     # Watch mode
npm run test:e2e       # End-to-end smoke across all 5 stacks
npx tsc --noEmit       # Type-check without emitting
```

### E2E smoke harness

`scripts/e2e-smoke.mjs` is the canonical regression gate for generation. For every supported stack it runs:

1. `pillar init` (non-interactive, `--skip-install --skip-git`)
2. `npm install` inside the scaffolded project
3. `pillar add resource user --fields "name:string email:string"`
4. `pillar add auth --strategy jwt` (+ re-install for the new deps)
5. `tsc --noEmit` on the scaffolded project

A stack passes only when the generated project type-checks end-to-end. Unit tests alone can't catch stack-specific bugs (wrong type imports, Fastify route-generic omissions, NestJS missing DTOs, Next.js importing Express) — those only surface when the generated code is actually compiled.

```bash
npm run test:e2e                          # all stacks, serial
npm run test:e2e -- --jobs 3              # parallel
npm run test:e2e -- --only express,hono   # subset
npm run test:e2e -- --keep                # preserve failing temp dirs for debugging
```

Always run this before shipping changes to any skeleton, resource-generator, or extension code path.

---

## Requirements

- Node.js >= 18.0.0

## License

MIT
