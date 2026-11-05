# API and implementation contracts

All JSON success data is returned directly (no wrapper); errors `{message, code?}` with correct HTTP status. Client uses credentials same-origin. Request bodies camelCase. IDs UUID strings. Times ISO UTC, dates YYYY-MM-DD Shanghai. Mutation resource version is required on updates. Default pages return arrays (single class modest size). POST create returns resource, DELETE returns `{ok:true}`.

## Shared server interfaces

`server/db.ts` exports `Store`, `createStore(path=':memory:')`; Store has `get<T>(sql,...params):T|undefined`, `all<T>(sql,...params):T[]`, `run(sql,...params)`, `transaction<T>(fn:()=>T):T`, `setting<T>(key,fallback):T`, `setSetting(key,value)`, `audit(actorId,action,entityId,details)`, `close()`. SQLite sync methods, all parameters scalar. `db.sqlite` raw DatabaseSync. SQL schema is defined in db.ts, read it before writing SQL.

`server/common.ts` exports `User` {id,username,name,role:'admin'|'committee'|'student',financeManage:boolean,mustChangePassword:boolean,active:boolean,version:number}, `HttpError(statusCode,message)`, `requireUser(req):User`, `requireManager(req):User`, `requireAdmin(req):User`, `requireFinance(req):User`, `uid()`, `now()`, `parse(zodSchema,input)`, `json(value,fallback)`, `shanghaiDate(date?)`. Decorated request.user:User|null. Mutations must use guard, not front-end role flags.

All module registrations `(app:FastifyInstance, db:Store) => void|Promise<void>`. Root modules: registerCatalog, registerTimetable, registerFiles. Finance agent registerFinance. Auth agent registerAuth; tasks agent registerTasks. Auth agent builds `buildApp({db?:Store, storage?:StorageAdapter, logger?:boolean}={})`; registers cookie, global auth hook (loads current user each request), error handler, auth/tasks/finance/catalog/timetable/files. Avoid closing caller-owned db. Storage interface defined in server/files.ts; until present use module imports as agreed. No backend modules modify package.json.

## Auth and settings

GET /api/auth/me -> `{user:User|null}`
POST /api/auth/login {username,password} -> `{user}` (HttpOnly session cookie)
POST /api/auth/logout -> {ok:true}
POST /api/auth/password {currentPassword,newPassword} -> {user}
GET /api/public/config -> `{name,subtitle,introduction,academicYear,semesterStart,semesterEnd,holidays:string[],demo:boolean}`
GET /api/status (authenticated) -> `{cosConfigured:boolean}`
GET /api/users (admin) -> User[]
POST /api/users {username,name,role,password,financeManage?} -> User
PUT /api/users/:id {name,role,active,financeManage,version} -> User
POST /api/users/:id/reset-password {password} -> {ok:true}
POST /api/users/batch {users:[{username,name,role,password}]} -> {count}; atomic and duplicates reject.

## Homework and affairs (same task engine)

Paths /api/homework and /api/affairs. Task {id,kind,title,course,description,deadline:null|string,allowLate,requiresSubmission,attachmentRequired,status:'draft'|'published'|'archived',fields:Field[],attachments:string[],version,createdAt,updatedAt,authorName,participantCount,submittedCount,mySubmission:null|Submission,myParticipantStatus:null|'required'|'excused'}.
Field {id,label,type:'text'|'textarea'|'select'|'multiselect'|'file',required:boolean,options?:string[]}.
Submission {id,taskId,userId,name,text,answers:Record<string,unknown>,attachments:string[],fields:Field[],createdAt,late:boolean,version:number}. Submission fields are the form snapshot at submission time.
GET base -> Task[] filtered for role; GET base/:id -> Task.
POST base -> task input fields above (defaults allowed); creates draft or published.
PUT base/:id -> changed fields plus version; lifecycle changes allowed under rules.
GET base/:id/submissions -> Submission[] (manager all, student own); ?history=1 includes historical.
POST base/:id/submissions {text,answers,attachments} -> Submission (students/committee, deadline checked, creates revision).
GET base/:id/participants -> [{userId,name,status,submitted:boolean}] managers.
PUT base/:id/participants {userIds:string[],version} -> Task (explicit active participant set, retain excused history).
GET /api/submissions/history -> own historical submissions with taskTitle (all task kinds, including withdrawn).
POST base/:id/export -> `{fileId}` XLSX via shared `createExport(db,user,filename,Buffer,mime,scope)` from files.ts. Agent can implement export once helper exists.
POST base/:id/export-files with optional `{userIds?:string[]}` -> `{fileId}` ZIP for managers, containing the latest submission attachments per selected student. Omitting userIds selects all submissions. Empty selections and selections without attachments return 400.

## Timetable

GET /api/public/timetable?date=YYYY-MM-DD -> `{date,effectiveDate,version,periods:[{id:number,label,start,end}],courses:[{id,name,teacher,room,day:number,startPeriod:number,endPeriod:number,color,notes}],exceptions:[{id,date,courseId,action:'cancel'|'replace',course?:Course}],config:{semesterStart,semesterEnd,holidays},today:Course[]}`. day=1..7. Public fields safe, guests see same renderable schedule.
PUT /api/timetable {effectiveDate,periods,courses,version} manager -> result same shape.
POST /api/timetable/exceptions {date,courseId,action,course?} manager -> exception.
DELETE /api/timetable/exceptions/:id manager -> {ok:true}.

## Resources and class

Resource {id,title,description,category,url,attachments:string[],pinned:boolean,status:'published'|'archived',version,updatedAt,authorName}.
GET /api/resources -> Resource[]; POST /api/resources -> resource; PUT /api/resources/:id {changes,version} -> resource. Manager can see archived and old versions GET /api/resources/:id/history.
GET /api/class -> `{config, members:[{id,name,role,position,avatarFileId}], duties:[{id,date,area,names:string[]}],version}` authenticated.
PUT /api/class {config?,members?,duties?,version} manager; only display profiles (name/position/avatar) changed, NOT user identity/role/login-name. config whitelist includes name,subtitle,introduction,academicYear,semesterStart,semesterEnd,holidays. User account name changes via users, members display can use displayName.

## Finance

GET /api/finance -> `{balance,income,expense,opening,entries:Entry[],fees:Fee[],payments:Payment[],canManage:boolean,canViewAll:boolean}` amounts integer cents.
Entry {id,type:'opening'|'income'|'expense',amount:number,category,description,date,receiptIds:string[],publicReceipt:boolean,paymentId:null|string,voided:boolean,version,createdAt,authorName}.
Fee {id,title,amount:number,deadline:null|string,userIds:string[],version,createdAt}; Payment {id,feeId,userId,name,amount,date,description,receiptIds:string[],version,voided:boolean}.
POST /api/finance/entries Entry input + idempotencyKey; PUT /api/finance/entries/:id fields+version+reason; POST /api/finance/entries/:id/void {version,reason}; payment-linked entry read-only.
POST /api/finance/fees {title,amount,deadline,userIds}; PUT /api/finance/fees/:id {title,amount,deadline,userIds,version}.
POST /api/finance/payments {feeId,userId,amount,date,description,receiptIds,idempotencyKey}; PUT /api/finance/payments/:id fields+version+reason; POST /api/finance/payments/:id/void {version,reason}.
GET /api/finance/history (admin or finance manager) -> audit rows.
GET /api/finance/members (admin or finance manager) -> [{id,name}] active student/committee.
POST /api/finance/export (admin or finance manager) -> {fileId} XLSX via createExport; standard users can only see redacted summary and own payments. Fees userIds also redact to own for standard readers.

## Files

File {id,name,size,mime,status:'pending'|'ready',purpose,entityId,ownerId,createdAt}.
POST /api/files/upload {name,size,mime,purpose:'task-attachment'|'submission'|'resource'|'receipt'|'avatar'|'class-photo',entityId?} -> {fileId,url,headers}. Draft new-resource files may use no entityId, manager-only; staged submission needs existing task ID. No COS -> 503 explicit.
POST /api/files/:id/confirm -> File; link only after verified successful upload, module mutation must validate binding ACL and change state (shared `validateAttachments(db,user,ids,purpose,entityId)` and `bindAttachments(db,ids,entityId)` exports).
GET /api/files/:id -> safe File metadata, authorized.
POST /api/files/:id/download {preview?:boolean} -> {url,previewAvailable:boolean}; authorized. Public class photos can use GET /api/public/photo/:id -> redirect.
`StorageAdapter` methods `configured:boolean`, `uploadUrl(key,mime,size):Promise<{url,headers}>`, `head(key):Promise<{size,mime}>`, `readHead(key):Promise<Buffer>`, `downloadUrl(key,filename,preview?):Promise<string>`, `put(key,buffer,mime):Promise<void>`, `remove(key):Promise<void>`.
`createExport(db,user,filename,buffer,mime,scope):Promise<{fileId}>` uses app-registered storage via Store or passed configuration; root will provide implementation. scope {kind:'task'|'finance',id?:string}. GET /api/status returns config only, no secrets.
