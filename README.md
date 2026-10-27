# Real-Time Chat and Calling

One-to-one real-time chat and audio/video calling web application.

## Status

This repository is at the application-scaffold stage. The workspace, local build, typecheck,
and lint tooling are in place. Product features, security controls, capacity evidence, and
accessibility verification land in later tasks. No security, capacity, or accessibility claim
is made yet.

## Requirements

- Node.js 24 (`.nvmrc` pins the major version)
- npm 11 (declared in `packageManager`)

## Workspace layout

| Path                  | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `apps/web/`           | Next.js App Router frontend (React, TypeScript, CSS Modules) |
| `apps/api/`           | Express 5 API (TypeScript, ESM, `tsx` in development)        |
| `packages/contracts/` | Shared transport-agnostic TypeScript contracts               |
| `tsconfig.base.json`  | Shared strict TypeScript settings                            |
| `eslint.config.mjs`   | Flat ESLint configuration for the whole workspace            |

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` builds the shared contracts package, then starts the web app at
`http://localhost:3000` and the API at `http://localhost:3001`. The API exposes
`GET /health`, which returns a typed `HealthResponse` from `@chat/contracts`.

## Commands

| Command                | Description                                  |
| ---------------------- | -------------------------------------------- |
| `npm run dev`          | Run the web and API development servers      |
| `npm run build`        | Build contracts, API, and web for production |
| `npm start`            | Start the built web and API servers          |
| `npm run typecheck`    | Typecheck every workspace                    |
| `npm run lint`         | Lint the repository with ESLint              |
| `npm run format`       | Format with Prettier                         |
| `npm run format:check` | Verify formatting without writing            |

## Configuration

Runtime configuration is environment-based. `.env.example`, validated configuration, and the
local development stack are added by the local-environment task. Do not commit credentials,
production data, private message content, database dumps, or backups.

## Branching

`main` is the protected default branch. Changes land through pull requests; direct pushes,
force pushes, and branch deletion are blocked.

## Security

Do not open public issues containing secrets, private message content, or personal data.
