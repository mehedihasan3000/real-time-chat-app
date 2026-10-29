# Real-Time Chat and Calling

One-to-one real-time chat and audio/video calling web application.

## Status

This repository is at the application-scaffold and local-environment stage. The workspace,
local build, typecheck, lint, environment validation, database check, synthetic seed, and AI
mock are in place. Automated CI quality gates cover formatting, linting, typechecking, the
build, unit and contract tests, a dependency audit, and a tracked-file secret scan. Product
features, security controls, capacity evidence, and accessibility verification land in later
tasks. No security, capacity, or accessibility claim is made yet.

## Requirements

- Node.js 24 (`.nvmrc` pins the major version)
- npm 11 (declared in `packageManager`)
- MongoDB: either a free MongoDB Atlas M0 development cluster, or Docker for the optional
  local MongoDB service

## Workspace layout

| Path                  | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `apps/web/`           | Next.js App Router frontend (React, TypeScript, CSS Modules) |
| `apps/api/`           | Express 5 API (TypeScript, ESM, `tsx` in development)        |
| `packages/contracts/` | Shared transport-agnostic TypeScript contracts               |
| `scripts/`            | Local-development verification scripts                       |
| `docker-compose.yml`  | Optional local MongoDB and coturn test services              |
| `tsconfig.base.json`  | Shared strict TypeScript settings                            |
| `eslint.config.mjs`   | Flat ESLint configuration for the whole workspace            |

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create your local environment file from the committed example:

   ```bash
   cp .env.example .env
   ```

   On PowerShell, use `Copy-Item .env.example .env`.

3. Choose a development database:

   - **Local Docker (no cloud account):**

     ```bash
     docker compose up -d mongo
     ```

     The default `MONGODB_URI` in `.env.example` points at this service.

   - **MongoDB Atlas (free M0 development cluster):** create a cluster, create a
     development-only database user, allow your current IP, then set `MONGODB_URI` in `.env`
     to your Atlas connection string. Keep `MONGODB_DB=real_time_chat_dev`; the synthetic seed
     refuses database names that do not end in `_dev`, `_local`, or `_test`.

4. Verify the local environment:

   ```bash
   npm run verify:local
   ```

   This validates configuration, pings MongoDB, writes synthetic fixtures, and exercises the
   network-free AI mock. It never prints the database URI or credentials.

5. Start the stack:

   ```bash
   npm run dev
   ```

The web app runs at `http://localhost:3000` and the API at `http://localhost:3001`. The API
exposes `GET /health`, which returns a typed `HealthResponse` from `@chat/contracts`.

## Commands

| Command                | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `npm run dev`          | Run the web and API development servers                    |
| `npm run build`        | Build contracts, API, and web for production               |
| `npm start`            | Start the built web and API servers                        |
| `npm run typecheck`    | Typecheck every workspace, including tests                 |
| `npm run lint`         | Lint the repository with ESLint                            |
| `npm run format`       | Format with Prettier                                       |
| `npm run format:check` | Verify formatting without writing                          |
| `npm test`             | Run unit and contract tests with coverage thresholds       |
| `npm run test:watch`   | Run tests in watch mode                                    |
| `npm run audit:ci`     | Fail on low-or-higher dependency vulnerabilities           |
| `npm run secret:scan`  | Scan tracked files for high-confidence secret patterns     |
| `npm run ci:local`     | Run the same gates as CI locally                           |
| `npm run config:check` | Validate `.env` and print a redacted configuration summary |
| `npm run db:check`     | Connect to MongoDB and run a `ping`                        |
| `npm run seed`         | Upsert synthetic local fixtures into `dev_fixtures`        |
| `npm run smoke:ai`     | Exercise the local AI mock without a network request       |
| `npm run verify:local` | Run the config, database, seed, and AI checks together     |

## Configuration

Runtime configuration is environment-based. `.env.example` documents every local variable;
copy it to `.env` and keep `.env` out of Git. No production credentials are required or
included.

- `MONGODB_URI` and `MONGODB_DB` select the development database. The API and local scripts
  never log the URI.
- `BETTER_AUTH_SECRET` is a local-only placeholder until authentication lands in a later
  task. Generate your own value for any shared development environment.
- `AI_PROVIDER=mock` is the default. It makes no network request and requires no provider
  key. A real provider is not wired up yet.
- `TURN_*` values describe the optional local coturn test service. They are test credentials,
  not production relay credentials.
- The API validates configuration at startup and exits with a safe error when a required value
  is missing or invalid. `npm run config:check` performs the same validation without starting
  the server.

## Continuous integration

The `.github/workflows/ci.yml` workflow runs on every pull request, on pushes to `main`, and on
manual dispatch. The single `ci` job installs from the lockfile with `npm ci` and runs
formatting, linting, typechecking, the build, unit and contract tests with coverage, a
dependency audit, and a tracked-file secret scan. It requires no production credentials or
external services. JUnit and coverage reports are uploaded as the `test-reports` artifact.

`main` requires the `ci` status check. A pull request with a failing or missing `ci` run cannot
be merged, even when all other review settings pass.

## Branching

`main` is the protected default branch. Changes land through pull requests; direct pushes,
force pushes, and branch deletion are blocked.

## Security

Do not commit `.env`, credentials, production data, private message content, database dumps, or
backups. Do not open public issues containing secrets, private message content, or personal
data. The local TURN and AI mock values are for development only.
