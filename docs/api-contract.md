# API and implementation contracts

All JSON success data is returned directly (no wrapper); errors `{message, code?}` with correct HTTP status. Client uses credentials same-origin. Request bodies camelCase. IDs UUID strings. Times ISO UTC, dates YYYY-MM-DD Shanghai. Mutation resource version is required on updates. Default pages return arrays (single class modest size). POST create returns resource, DELETE returns `{ok:true}`.

## Shared server interfaces

`server/db.ts` exports `Store`, `createStore(path=':memory:')`; Store has `get<T>(sql,...params):T|undefined`, `all<T>(sql,...params):T[]`, `run(sql,...params)`, `transaction<T>(fn:()=>T):T`, `setting<T>(key,fallback):T`, `setSetting(key,value)`, `audit(actorId,action,entityId,details)`, `close()`. SQLite sync methods, all parameters scalar. `db.sqlite` raw DatabaseSync. SQL schema is defined in db.ts, read it before writing SQL.

`server/common.ts` exports `User` {id,username,name,role:'super_admin'|'admin'|'committee'|'student',permissions:Permission[],financeManage:boolean,inClass:boolean,avatarFileId?:string|null,mustChangePassword:boolean,active:boolean,version:number}, `HttpError(statusCode,message)`, `requireUser(req):User`, `requirePermission(req,key):User`, `uid()`, `now()`, `parse(zodSchema,input)`, `json(value,fallback)`, `shanghaiDate(date?)`. Decorated request.user:User|null. Mutations must use operation guards, not front-end role flags.

`shared/permissions.ts` is the authoritative operation catalog and dependency graph. `super_admin` displays **Admin** and has every permission; `admin` displays **管理员** and fails closed when its explicit grants are empty or missing. Committee grants are fixed, with finance available only when `financeManage=true`. Students/guests gain no management permissions. `can`, `effectivePermissions`, `addPermission`, `removePermission`, `validatePermissions` and `isClassMember` are shared by API and UI. Migration 4 gives existing admins an explicit legacy grant set once, while new admins default to none. Every request loads the user's current role/grants in preHandler after body parsing; origin checking remains onRequest. Asynchronous storage operations also recheck session/account/grants and file state after their awaits.

All module registrations `(app:FastifyInstance, db:Store) => void|Promise<void>`. Root modules: registerCatalog, registerTimetable, registerFiles. Finance agent registerFinance. Auth agent registerAuth; tasks agent registerTasks. Auth agent builds `buildApp({db?:Store, storage?:StorageAdapter, logger?:boolean}={})`; registers cookie, global auth hook (loads current user each request), error handler, auth/tasks/finance/catalog/timetable/files. Avoid closing caller-owned db. Storage interface defined in server/files.ts; until present use module imports as agreed. No backend modules modify package.json.

## Auth and settings

GET /api/auth/me -> `{user:User|null}`
POST /api/auth/login {username,password} -> `{user}` (HttpOnly session cookie)
POST /api/auth/logout -> {ok:true}
POST /api/auth/password {currentPassword,newPassword} -> {user}
PUT /api/auth/avatar {avatarFileId:string|null,version:number} -> {user}; authenticated and initial password change completed. Updates only the caller's avatar; null removes it. User responses expose avatarFileId from the display profile. A new file must be confirmed, have purpose avatar and belong to this target account. The mutation increments the account and class-profile versions to reject stale edits.
GET /api/public/config -> `{name,subtitle,introduction,academicYear,semesterStart,semesterEnd,holidays:string[],demo:boolean}`
GET /api/status (authenticated) -> `{cosConfigured:boolean}`
GET /api/users (`accounts.read`) -> User[]; Admin sees all accounts, ordinary admins see committee/student accounts only.
POST /api/users {username,name,role,password,financeManage?,inClass?,permissions?} -> User; `accounts.create` required.
PUT /api/users/:id {username?,name,role,active,financeManage,inClass?,version} -> User; actual changes require `accounts.edit`, `.roles`, `.status` respectively. Supplying username is Admin-only.
POST /api/users/:id/reset-password {password,version} -> {ok:true}; `accounts.resetPassword` required.
PUT /api/users/:id/permissions {permissions:Permission[],version} -> User; Admin-only, target must be an ordinary administrator. Unknown/duplicate grants or missing dependencies return 400.
POST /api/users/batch {users:[{username,name,role,password}]} -> {count}; atomic and duplicates reject.

Only Admin can create/manage protected Admin/administrator accounts, grant permissions, edit usernames, or change committee finance authorization. Sensitive lower-account operations (create/batch/role/status/reset) also require the target's management capabilities to be a subset of the actor's. Account mutations re-read actor/target inside their transaction. Disabling/demoting the last enabled Admin returns 409. Role changes clear explicit grants, rather than reviving historical ones. Username/role/status/finance authorization changes and password reset revoke target sessions; grant changes take effect on the next request. Passwords and hashes are never returned or logged in audit. In-class eligibility is student/committee or explicit `inClass` for elevated accounts.

## Homework and affairs (same task engine)

Paths /api/homework and /api/affairs. Task {id,kind,title,course,description,deadline:null|string,allowLate,requiresSubmission,attachmentRequired,status:'draft'|'published'|'archived',fields:Field[],attachments:string[],version,createdAt,updatedAt,authorName,participantCount,submittedCount,mySubmission:null|Submission,myParticipantStatus:null|'required'|'excused'}.
Field {id,label,type:'text'|'textarea'|'select'|'multiselect'|'file',required:boolean,options?:string[]}.
Submission {id,taskId,userId,name,text,answers:Record<string,unknown>,attachments:string[],fields:Field[],createdAt,late:boolean,version:number}. Submission fields are the form snapshot at submission time.
GET base -> Task[] filtered for role; GET base/:id -> Task.
POST base -> task input fields above (defaults allowed); creates draft or published.
PUT base/:id -> changed fields plus version; lifecycle changes allowed under rules.
GET base/:id/submissions -> Submission[] (`<kind>.submissions.read` for all, student own); ?history=1 includes historical. All members retain their own `mySubmission` and personal history. Aggregate participant/submission counts are returned only with the corresponding read grant; edit-only users receive `hasSubmissions` to enforce schema locking without disclosing counts.
POST base/:id/submissions {text,answers,attachments} -> Submission (students/committee, deadline checked, creates revision).
GET base/:id/participants -> [{userId,name,status,submitted:boolean}], requires `<kind>.participants.read`.
PUT base/:id/participants {userIds:string[],version} -> Task (explicit active participant set, retain excused history).
GET /api/submissions/history -> own historical submissions with taskTitle (all task kinds, including withdrawn).
POST base/:id/export -> `{fileId}` XLSX via shared `createExport(db,user,filename,Buffer,mime,scope)` from files.ts. Agent can implement export once helper exists.
POST base/:id/export-files with optional `{userIds?:string[]}` -> `{fileId}` ZIP, requires `<kind>.exportFiles`, containing the latest submission attachments per selected student. Omitting userIds selects all submissions. Empty selections and selections without attachments return 400.

## Timetable

GET /api/public/timetable?date=YYYY-MM-DD -> `Timetable {date,effectiveDate,templateId:null|string,templateName,selectionVersion,version,periods:[{id:number,label,start,end}],courses:[{id,name,teacher,room,day:number,startPeriod:number,endPeriod:number,color,notes}],exceptions:[{id,date,courseId,action:'cancel'|'replace',course?:Course}],config:{semesterStart,semesterEnd,holidays},today:Course[]}`. day=1..7. All dates use the single active weekly template, with date-specific exceptions and semester/holiday filtering. Guests see the same safe schedule. effectiveDate is legacy metadata, not a future activation rule.

Template = `{id,name,effectiveDate:null|string,version,periods,courses}`. Operations require their exact `timetable.*` permission: templates.read/create/edit/apply, current.edit, exceptions.write/remove. Editing an active template via the template endpoint also requires current.edit.
GET /api/timetable/templates -> `{templates:Template[],activeTemplateId:null|string,selectionVersion}`; drafts are not public.
PUT /api/timetable `{templateId:null|string,name,periods,courses,version,selectionVersion}` -> Timetable; updates the current template immediately, or creates the first active template when templateId is null.
POST /api/timetable/templates `{name,periods,courses,selectionVersion}` -> Template; saves an inactive draft without switching.
PUT /api/timetable/templates/:id `{name,periods,courses,version,selectionVersion}` -> Template; updates the named template in place.
POST /api/timetable/templates/:id/apply `{version,selectionVersion}` -> Timetable; explicitly switches the single active template.
POST /api/timetable/exceptions `{date,courseId,action,course?,templateId,version,selectionVersion}` -> exception.
DELETE /api/timetable/exceptions/:id with JSON body `{templateId,version,selectionVersion}` -> `{ok:true}`.

Writes check template content and active-selection versions in a transaction; stale writes return 409. Exceptions belong to their template, survive switches, and advance its version when changed. Weekly edits and applies validate all affected exceptions, including dates hidden by semester/holidays. Migration preserves legacy templates and associates each legacy exception with its formerly effective template. The first selection is initialized from the server's Shanghai date once; later dates never auto-switch it.

## Resources and class

Resource {id,title,description,category,url,attachments:string[],pinned:boolean,status:'draft'|'published'|'archived',version,updatedAt,authorName}.
GET /api/resources -> visible Resource[]; POST /api/resources -> resource (default draft; create grant, plus publish if published); PUT /api/resources/:id {changes,version} -> resource. Actual content changes require edit; changes to already published content also require publish. Status-only publish/archive require their own grants, independently of edit. Draft/archived reads require the corresponding grants. GET /api/resources/:id/history requires history.read, current resource visibility and filters each snapshot by its status visibility. Omitted update fields retain their stored values.
GET /api/class -> `{config, members:[{id,name,role,position,avatarFileId}],version}` authenticated.
PUT /api/class {config?,members?,version}; each supplied section requires its exact `class.settings.edit` or `class.members.edit` grant and the whole operation is atomic. Only display profiles (name/position/avatar) change, not account identity or role; protected account profiles require Admin. Config includes name,subtitle,introduction,academicYear,semesterStart,semesterEnd,holidays,photoFileId. User account name changes via users; member display can use displayName. Legacy requests containing duties are rejected atomically with a refresh/migration message after the duty permission check, so stale clients cannot overwrite the weekly schedule or partially update the class.

## Weekly duties

`Duty {id:string,weekday:1|2|3|4|5|6|7,area:string,names:string[]}`. Monday=1, Sunday=7; each weekday can have multiple areas, and the schedule repeats weekly. All seven days display even when empty.

GET /api/duties -> `{duties:Duty[],version:number}`; authenticated and initial password change completed.
PUT /api/duties `{duties:Duty[],version:number}` -> the updated schedule; requires existing `class.duties.edit`. Validates weekday, unique IDs, trimmed nonempty area, names and size limits. Uses a separate version/transaction/audit from class data; stale edits return 409, no partial writes.

Stored in settings.weekly_duties. Migration 5 copies legacy dated settings.duties records to corresponding civil-date weekdays and preserves the exact legacy setting as backup. It trims IDs and regenerates blank, oversized or duplicate normalized IDs without losing rows or display content. It never merges rows or overwrites an existing weekly schedule; reruns do not repeat migration. Invalid legacy data fails explicitly without silently deleting records. Frontend route `/duties` is hidden from guests; permission catalog groups the retained grant under 值日安排.

## Finance

GET /api/finance -> `{balance,income,expense,opening,entries:Entry[],fees:Fee[],payments:Payment[],canManage:boolean,canViewAll:boolean}` amounts integer cents.

`canManage` is compatibility metadata indicating any authorized finance mutation; it is never an authorization guard. `canViewAll` comes from finance.read. Every entry/fee/payment create/edit/void action requires its exact permission; history and export are separate, all depend on finance.read. Private current receipts require finance.read; historical removed receipts also require finance.history. Members without grants retain redacted summaries, their own payments and published receipts; guests have no finance access. Receipt uploads persist their exact mutation context and binding rechecks it.

Entry {id,type:'opening'|'income'|'expense',amount:number,category,description,date,receiptIds:string[],publicReceipt:boolean,paymentId:null|string,voided:boolean,version,createdAt,authorName}.
Fee {id,title,amount:number,deadline:null|string,userIds:string[],version,createdAt}; Payment {id,feeId,userId,name,amount,date,description,receiptIds:string[],version,voided:boolean}.
POST /api/finance/entries Entry input + idempotencyKey; PUT /api/finance/entries/:id fields+version+reason; POST /api/finance/entries/:id/void {version,reason}; payment-linked entry read-only.
POST /api/finance/fees {title,amount,deadline,userIds}; PUT /api/finance/fees/:id {title,amount,deadline,userIds,version}.
POST /api/finance/payments {feeId,userId,amount,date,description,receiptIds,idempotencyKey}; PUT /api/finance/payments/:id fields+version+reason; POST /api/finance/payments/:id/void {version,reason}.
GET /api/finance/history (`finance.history`) -> audit rows.
GET /api/finance/members (`finance.read`) -> [{id,name}] active class members, including explicitly enrolled elevated accounts.
POST /api/finance/export (`finance.export`) -> {fileId} XLSX via createExport; standard users can only see redacted summary and own payments. Fees userIds also redact to own for standard readers.

## Files

File {id,name,size,mime,status:'pending'|'ready',purpose,entityId,ownerId,createdAt}.
POST /api/files/upload {name,size,mime,purpose:'task-attachment'|'submission'|'resource'|'receipt'|'avatar'|'class-photo',entityId?,context?} -> {fileId,url,headers}. New task staging context is homework/affairs; receipts use finance.entries.create/edit or finance.payments.create/edit. Context is validated and persisted in files.scope. Existing records also derive their type/status from the database. Legacy context-free uploads require all relevant write grants. Submission staging requires an existing task and current participation. No COS -> 503 explicit.
Avatar uploads require an active target account in entityId. Activated users may upload for themselves; `class.members.edit` permits other ordinary members, while protected Admin/administrator targets require Admin. Avatars are limited to 5 MiB and JPEG/PNG/WebP/GIF. Staged avatars are visible only to their uploader; assigned avatars are visible to activated authenticated users. Replacing/removing an avatar expires the previous object for cleanup and immediately revokes new application access to it. GIF previews preserve the original bytes and animation.
POST /api/files/:id/confirm -> File; rechecks upload authorization and verifies storage content. Module mutations must use `validateAttachments(db,user,ids,purpose,entityId?,context?)` before `bindAttachments(db,ids,entityId)`. Staged files cannot cross business contexts or entities. Retained attachments on the same record may retain their original create context under the caller's current edit grant.
GET /api/files/:id -> safe File metadata, authorized.
POST /api/files/:id/download {preview?:boolean} -> {url,previewAvailable:boolean}; authorized. Downloads use short-lived COS links. For supported preview requests, url is the authenticated same-origin `/api/files/:id/preview` endpoint and previewAvailable is true without COS_PREVIEW_DOMAIN. Unsupported formats return a download link with previewAvailable false.
GET /api/files/:id/preview -> verified PDF/PNG/JPEG/WebP/GIF bytes; rechecks session, current file lifecycle and object-level visibility. Reads private COS, checks size (maximum 20 MiB), filename/type and signature; returns no-store, nosniff, attachment disposition and sandbox CSP. Frontend fetches bytes with session cookies and displays a disposable Blob URL; close aborts pending fetches and revokes the URL. No public permanent preview links.
PDF content is rendered to a bounded canvas by a dynamically imported PDF.js engine, with local worker/font/CMap/decoder assets and previous/next controls. Images use Blob URLs. Closing a preview cancels rendering/destroys its worker; Escape stops at the top dialog, preserving unsaved editor data underneath.
GET /api/public/photo/:id -> image bytes only for the currently configured public class photo; other files remain protected.
`StorageAdapter` methods `configured:boolean`, `uploadUrl(key,mime,size):Promise<{url,headers}>`, `head(key):Promise<{size,mime}>`, `readHead(key):Promise<Buffer>`, `read(key):Promise<Buffer>`, `downloadUrl(key,filename,preview?):Promise<string>`, `put(key,buffer,mime):Promise<void>`, `remove(key):Promise<void>`.
`createExport(db,user,filename,buffer,mime,scope,sources?,request?):Promise<{fileId}>` uses app-registered storage; HTTP callers pass the request for exact session revalidation after asynchronous work. `createBundle(db,user,ids,name,scope,request?)` carries that request through ZIP reads and export creation. scope {kind:'task'|'finance',id?:string,permission?:Permission}; new callers persist their exact export key, and metadata/download/preview access rechecks it. Legacy task scopes require both table and attachment export capabilities conservatively. GET /api/status returns config only, no secrets.
