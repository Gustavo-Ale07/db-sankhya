# 0006 — TypeScript monorepo

- Status: accepted

## Decision

- pnpm workspace with `apps/api`, `apps/web` and focused packages (`sql-engine`, `sankhya-client`,
  `database`, `shared`), so the engine and the gateway client can be tested without HTTP or a
  browser.
- **Fastify 5** for the API: fast, typed, with mature plugins for cookies, security headers, rate
  limiting and static files.
- **React 19 + Vite + Tailwind CSS** for the UI, Monaco for the editor, TanStack Query and
  TanStack Virtual for data fetching and large grids.
- **PostgreSQL + Drizzle ORM** with versioned migrations; **PGlite** for development and tests,
  so no database server is needed locally or in CI.
- **node-sql-parser** for parsing, converted into our own small AST so the rest of the engine
  does not depend on the parser output format.
- **Vitest** for unit and integration tests, **Playwright** for end-to-end tests.
- The API is bundled with esbuild into one file; the Docker image ships that bundle, the web build
  and production dependencies only.

## Consequences

One language and one toolchain across the stack, with types shared between server and UI.
