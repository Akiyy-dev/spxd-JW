# Admin role and granular permissions implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. User approved implementation; use parallel agents on disjoint modules, then independent integration review.

**Goal:** Introduce Admin and per-administrator operation grants, preserving existing membership, COS and business behavior while closing all privilege bypass paths.

**Architecture:** Shared permission catalog and pure checks consumed by API guards and React controls. Explicit database grants for administrators; fixed committee grants, full super_admin access. Auth reads current grants per request; module/file operations check actual state changes and ownership.

**Tech Stack:** Existing React/TypeScript/Fastify/SQLite, Node 24; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-admin-permissions-design.md` (approved).

## Global constraints

- `super_admin` displays Admin, `admin` displays 管理员. Authorized bootstrap target is existing enabled admin username Akiyy; the maintenance command requires an explicit username, preserving credentials and `inClass`.
- Never return/store plaintext or reversible passwords. Admin can view/update username and reset a password with input visibility toggle; no password/hash in audit.
- New admins default to empty grants; migrate old admins to an explicit list of existing business grants. Only Admin can grant, manage protected roles, or change committee finance authorization.
- Preserve role/student/committee behaviors, private COS, existing preview, finance record-only semantics, HTTP UUID compatibility and GIF avatars.
- Work in clean `dev/admin-permissions` branch already prepared by this task; do not touch actual databases or `.env`.

## Review focus

- A restricted admin resets/creates a committee account to gain missing powers: require target capability subset for sensitive lower-account mutations; test single and batch.
- A write permission leaks answers/roster via read endpoints or exports: test redaction and separate read dependencies.
- A file uploaded before revocation is confirmed/bound/downloaded afterward: recheck current grant and persisted context.
- An editor changes an active template through the template endpoint: enforce current-edit capability there too.
- Renaming own or another user's username must preserve relationships, reject duplicates and revoke affected sessions without ever returning passwords.

## Shared interfaces (task 1 owner)

`shared/permissions.ts` exports `Role`, `Permission`, `PermissionUser {role; permissions?: Permission[]; financeManage?:boolean; inClass?:boolean}`, `PERMISSIONS: readonly {key:Permission;group:string;label:string;requires:readonly Permission[]}[]`, `PERMISSION_KEYS:Permission[]`, `can(user,p):boolean`, `effectivePermissions(user):Permission[]`, `validatePermissions(input:unknown):Permission[]` (throws on unknown/duplicate/missing dependency), `addPermission(list,p):Permission[]` (transitive dependencies), `removePermission(list,p):Permission[]` (cascade dependents), `isClassMember(user):boolean`.

Keys (literal strings; all implementations use these):
- For each `homework` and `affairs`: `.drafts.read`, `.create`, `.edit`, `.publish`, `.withdraw`, `.archive`, `.participants.read`, `.participants.manage`, `.submissions.read`, `.export`, `.exportFiles`.
- `timetable.templates.read`, `.templates.create`, `.templates.edit`, `.templates.apply`, `timetable.current.edit`, `timetable.exceptions.write`, `timetable.exceptions.remove`.
- `resources.drafts.read`, `.archived.read`, `.history.read`, `.create`, `.edit`, `.publish`, `.archive`.
- `finance.read`, `.history`, `.entries.create`, `.entries.edit`, `.entries.void`, `.fees.create`, `.fees.edit`, `.payments.create`, `.payments.edit`, `.payments.void`, `.export`.
- `class.settings.edit`, `class.members.edit`, `class.duties.edit`.
- `accounts.read`, `.create`, `.edit`, `.roles`, `.status`, `.resetPassword` (only lower roles); username editing is Admin-only, never a grant.

`server/common.ts` exports `requirePermission(req,p):User`; User includes `permissions:Permission[]` (optional only if needed for legacy typed test fixtures; missing must fail closed). Frontend User same property. `can` checks dependencies transitively, never grants admin fallback for absent permissions. `isClassMember` = student/committee or explicit elevated `inClass`.

Files contract: `UploadFiles` gains optional `context?: string`; upload API persists validated context in `files.scope` (existing JSON column). Task staging context = `homework`/`affairs`; receipt context = `finance.entries.create/edit` or `finance.payments.create/edit`. Existing entity derives kind server-side; old manager uploads lacking context may be accepted only if caller has ALL relevant writing capabilities, never for a restricted admin. Binding rechecks target operation; edit/binding functions may gain optional context only by coordinated change. Export scope adds `permission: Permission` alongside existing kind/id and all consuming endpoints recheck it.

## Task 1 — shared catalog, accounts, migration (agent)

**Files:** create shared/permissions.ts, tests/permissions.test.ts, tests/admin-permissions.test.ts, scripts/promote-admin.ts; modify server/common.ts, server/auth.ts, server/db.ts, scripts/setup.ts, scripts/demo.ts, package.json, src/types.ts, tsconfig.json if needed.

- [x] Add failing tests: empty-grant admin cannot manage; two independently granted admins differ; real sessions reflect revoke; migration retains foreign keys/hash/profile/inClass and explicit legacy grants; last Admin protected; bootstrap only intended username; account batch/reset/role changes cannot escalate; Admin username rename uniqueness/session invalidation/no hash disclosure.
- [x] Run targeted tests and observe expected missing-role/grant failures.
- [x] Implement shared interface and migration (rebuild role constraint with SQLite FK-safe transaction), account guards and `PUT /api/users/:id/permissions {permissions,version}`, username optional in account PUT only for Admin. GET /users Admin sees all, granted admin only lower roles. Setup creates Admin; bootstrap command `npm run admin:promote -- --username Akiyy` rejects already initialized root set except safe idempotent same target.
- [x] Auth guards read latest grant every request; mutations validate current actor, target and version inside transaction; role change clears incompatible grants; audit sanitized before/after.
- [x] Target tests green; report exact contracts to other agents; no shared-file commits until root integration.

## Task 2 — tasks and submissions (agent)

**Files:** server/tasks.ts, src/tasks.tsx, tests/tasks.test.ts, tests/class-membership.test.ts for affected semantics; new tests/task-permissions.test.ts.

- [x] Add fail-first API cases: create-vs-publish, published edit needs edit+publish, drafts/private submissions denied, independent homework/affairs, roster/export dependencies, participant-qualified elevated submitters.
- [x] Replace role-based read/write branches by `can`/`requirePermission`, pass exact export scope permissions, return `hasSubmissions` only as editor locking metadata.
- [x] Frontend Tasks consumes `user:User`, controls exact operations and context on uploads; no full-answer query just to lock fields; preserve normal committee behavior.
- [x] Run targeted suites; communicate public props/type additions, do not edit root-owned app/types/ui/files.

## Task 3 — finance (agent)

**Files:** server/finance.ts, src/finance.tsx, tests/finance.test.ts; new tests/finance-permissions.test.ts.

- [x] Add fail-first cases for full-read without writes/export/history and isolated entry/fee/payment writes including void; keep redaction and committee finance flag behavior.
- [x] Backend exact guards, roster qualification via shared helper; scoped export. Frontend uses `can(user,...)` per button/modal and receipt upload context; canViewAll comes only from finance.read.
- [x] Targeted tests green, preserve idempotency, audit and integer amounts; communicate needs to root; no shared type/files edits.

## Task 4 — files, catalog, timetable, application UI (root; delegate files when a slot frees)

**Files:** server/files.ts, server/catalog.ts, server/timetable.ts, src/catalog.tsx, src/timetable.tsx, src/app.tsx, src/ui.tsx, src/api.ts; new src/permissions.tsx and styles if helpful; tests/files.test.ts/catalog.test.ts/timetable.test.ts plus dedicated permission cases.

- [x] Fail-first: revoked staged attachments and exports, private/historical file reads, different task kind contexts, own-avatar vs protected targets; preserve previews/public class photo.
- [x] Files reuse exact business operations/context; helper export readers check stored permission, legacy exports resolve conservative required permissions.
- [x] Catalog drafts and actual status transition permissions, segment-specific class PUT; protected user display/avatar checks; course template read/write/apply guards and active-template bypass test.
- [x] Implement per-operation UI, Admin role labels, account username editing and secure password visibility input. Admin grant editor groups all catalog entries, explicitly adds dependencies/cascades removal, shows count. Ordinary accounts show only authorized buttons.
- [x] Navigation and identity refresh on focus/navigation/permission failure; backend remains authoritative. Admin/member eligibility uses shared isClassMember.
- [x] Targeted tests then full npm test and npm run build; fix only integration failures and reviewer findings.

## Task 5 — release verification and docs

**Files:** README.md, docs/api-contract.md, docs/verification.md, spec/plan status.

- [x] Independent whole-diff review focuses on all direct role checks, file ACL, account elevation and migration. Resolve findings with regression coverage.
- [x] Verify build and full suite; browser tooling if available uses only isolated synthetic records, never live Akiyy passwords or production role updates.
- [x] Document maintenance-window backup/update/bootstrap Akiyy/build/restart, no password retrieval, per-operation semantics and verified limitations.
- [x] Commit implementation; integrate to main and sync authorized GitHub repository after clean checks, preserving branch/reflog and checking remote head. If external branch moved, reconcile before updating (never force overwrite).
