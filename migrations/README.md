# Migrations

Versioned MongoDB schema migrations for the v0 data layer (`P1-04`).

- `v0001_initial` — establishes all v0 collections and indexes in
  `apps/api/src/db/schema.ts` (users/profiles, devices, conversations,
  messages, receipts, read progress, calls, key backups, blocks, reports,
  moderation/appeals, AI consent/requests, deletion journal,
  schema_migrations). Better Auth collections (`user`/`session`/`account`/
  `verification`) remain library-managed by P1-06.
- Migrations are additive and idempotent; rollback is documented per
  migration manifest. Destructive changes require a backup/restore plan and
  an explicit compatibility window (`DEC-023` §9.5; `DATA-012`).
- Run against a dev database with `npm run db:migrate --workspace @chat/api`
  (see `apps/api/src/db/migrate-cli.ts`). Never run against production.

Schema version: **1** (`SCHEMA_VERSION` in `apps/api/src/db/schema.ts`).
Release-gated fields are listed in `RELEASE_GATED_FIELDS` and remain
provisional until `DEC-023` production evidence exists.
