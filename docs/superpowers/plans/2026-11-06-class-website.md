# 班级网站 Implementation Plan

> **For agentic workers:** Use coordinated independent implementation tasks with shared interfaces. User has approved the design and explicitly requested direct implementation; no further planning approval is required.

**Goal:** Deliver the approved seven-module class website with real server permissions and persistent data.
**Architecture:** React SPA and Fastify same-origin API, SQLite persistence, private COS uploads and authorized downloads.
**Tech Stack:** React, TypeScript, Vite, Fastify, Node 24 built-in SQLite, COS Node SDK.
**Spec:** `../specs/2026-11-06-class-website-design.md`

## Global Constraints

- Exactly admin, committee, student, guest; guest is unauthenticated.
- Guest sees only login, public introduction and read-only timetable.
- Finance writes only committee with financeManage; admin reads and grants permission.
- All business files and generated exports use COS. Missing COS fails explicitly.
- No payments, public signup, or real-world personal data in demo fixtures.
- Passwords and sessions never returned in general APIs. All mutations checked server-side.
- Work in D:/spxd_web; user approved independent project, no Sites registration or deployment.

## Review Focus

- Direct unauthorized API/file access, including ownership and changed permissions.
- Repeat payment requests and payment-linked entry revisions.
- Deadline boundary and upload completed after closing.
- Withdrawn/archived content and old participant history.
- Responsive UI, stale optimistic versions, missing storage config.

## Task 1 Infrastructure and shared contracts

- [x] Read approved spec, choose interfaces and document defaults.
- [x] Install dependencies, create SQLite schema and common validation/auth helpers.
- [x] Verify database transactions and settings initialization.

## Task 2 Identity and coursework backend

Files: server/auth.ts, server/tasks.ts, server/app.ts, tests/auth.test.ts, tests/tasks.test.ts.
Consumes server/db.ts and server/common.ts; produces buildApp and identity/task routes per docs/api-contract.md.
- [x] Write failing behavioral tests for guest access, last admin, task submission privacy and deadlines.
- [x] Implement session cookies, account administration, task fields/snapshots/submissions/history/export.
- [x] Run targeted tests and fix failures; report concerns.

## Task 3 Finance backend

Files: server/finance.ts, tests/finance.test.ts.
Consumes db/common interfaces; registerFinance(app, db) adds routes from contract.
- [x] Write failing tests for finance permission, idempotency, cents, revisions.
- [x] Implement fee requests, payments, linked entries, audits and redacted summaries.
- [x] Verify targeted tests including rollback and private receipt metadata.

## Task 4 Frontend

Files: src/** only.
Consumes documented JSON APIs; implements app shell, public login/introduction/timetable, all seven modules, admin and account forms.
- [x] Build coherent responsive visual system and actual API-driven states.
- [x] Connect forms, history, task submissions, finance, file components and exports.
- [x] Typecheck and manually verify key flows with real API.

## Task 5 Remaining backend and COS

Files: server/db.ts, server/common.ts, server/files.ts, server/catalog.ts, server/timetable.ts, server/index.ts, scripts/**, tests/catalog.test.ts, tests/files.test.ts, tests/timetable.test.ts.
- [x] Create failing tests for resources/guest timetable/COS denial before implementation.
- [x] Implement catalogue/class settings, template versions/exceptions and shared date projection.
- [x] Implement signed upload, non-overwrite, verification, ACL, export and cleanup.
- [x] Supply production initialization, separate demo, backup and setup documentation.

## Task 6 Integrate and review

- [x] Run full tests and production build.
- [x] Inspect desktop/mobile browser flows and correct observed issues.
- [x] Independent review of authorization, persistence and functional completeness; fix material findings.
- [x] Record exact verification and COS external configuration limitation.

## Progress

Implementation completed after explicit user approval. All seven modules use the shared API and persistent SQLite storage. Final verification: 36/36 automated tests, TypeScript and Vite production build passed. Browser checks covered four identities, persisted student submission, committee publication, finance record creation, and desktop/mobile layouts. Scoped independent review findings were fixed. Real COS bucket integration remains external configuration work; see docs/verification.md.
