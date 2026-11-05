import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, HttpError, json, now, parse, requireManager, requireUser, uid, versionSchema, type User } from './common.ts';
import type { Store } from './db.ts';
import { bindAttachments, createBundle, createExport, validateAttachments } from './files.ts';

const fieldSchema = z.object({
  id: z.string().regex(/^[\w-]{1,80}$/).refine(id => !['__proto__', 'prototype', 'constructor'].includes(id)),
  label: z.string().trim().min(1).max(120),
  type: z.enum(['text', 'textarea', 'select', 'multiselect', 'file']),
  required: z.boolean(),
  options: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
}).refine(field => {
  if (field.type !== 'select' && field.type !== 'multiselect') return field.options === undefined || field.options.length === 0;
  return Boolean(field.options?.length && new Set(field.options).size === field.options.length);
}, '选项字段需要提供唯一的选项');
const fieldsSchema = z.array(fieldSchema).max(50)
  .refine(fields => new Set(fields.map(field => field.id)).size === fields.length, '字段编号不能重复');
const fileId = z.string().uuid();
const attachmentSchema = z.array(fileId).max(5);
const taskInput = z.object({
  title: z.string().trim().min(1).max(160),
  course: z.string().trim().max(80),
  description: z.string().trim().max(20000),
  deadline: z.string().datetime({offset:true}).nullable(),
  allowLate: z.boolean(),
  requiresSubmission: z.boolean(),
  attachmentRequired: z.boolean(),
  status: z.enum(['draft', 'published', 'archived']),
  fields: fieldsSchema,
  attachments: attachmentSchema,
});
const submissionInput = z.object({
  text: z.string().trim().max(20000).default(''),
  answers: z.record(z.string(), z.unknown()).default({}),
  attachments: attachmentSchema.default([]),
});

type Kind = 'homework' | 'affairs';
type Status = z.infer<typeof taskInput>['status'];
type Field = z.infer<typeof fieldSchema>;
type TaskInput = z.infer<typeof taskInput>;
type TaskParams = {id:string};
type Participant = {userId:string; name:string; status:'required'|'excused'; submitted:number};

interface TaskRow {
  id: string;
  kind: Kind;
  title: string;
  course: string;
  description: string;
  deadline: string | null;
  allow_late: number;
  requires_submission: number;
  attachment_required: number;
  status: Status;
  fields: string;
  attachments: string;
  version: number;
  snapshot_created: number;
  created_at: string;
  updated_at: string;
  author_name: string;
}
interface SubmissionRow {
  id: string;
  task_id: string;
  user_id: string;
  name: string;
  text: string;
  answers: string;
  attachments: string;
  schema_snapshot: string;
  task_title: string;
  late: number;
  version: number;
  created_at: string;
}

const tasksSelect = 'SELECT t.*, u.name AS author_name FROM tasks t JOIN users u ON u.id=t.author_id';
const submissionsSelect = 'SELECT s.*, u.name FROM submissions s JOIN users u ON u.id=s.user_id';

function taskRow(db: Store, kind: Kind, id: string, user: User) {
  const row = db.get<TaskRow>(`${tasksSelect} WHERE t.id=? AND t.kind=?`, id, kind);
  if (!row || (user.role === 'student' && row.status === 'draft')) throw new HttpError(404, '任务不存在');
  return row;
}

function submissionView(row: SubmissionRow) {
  return {
    id:row.id, taskId:row.task_id, userId:row.user_id, name:row.name, text:row.text,
    answers:json<Record<string, unknown>>(row.answers, {}), attachments:json<string[]>(row.attachments, []),
    fields:json<Field[]>(row.schema_snapshot, []),
    createdAt:row.created_at, late:Boolean(row.late), version:row.version,
  };
}

function taskInputFromRow(row: TaskRow): TaskInput {
  return {
    title:row.title, course:row.course, description:row.description, deadline:row.deadline,
    allowLate:Boolean(row.allow_late), requiresSubmission:Boolean(row.requires_submission),
    attachmentRequired:Boolean(row.attachment_required), status:row.status,
    fields:json<Field[]>(row.fields, []), attachments:json<string[]>(row.attachments, []),
  };
}

function participantRows(db: Store, id: string) {
  return db.all<Participant>(`SELECT p.user_id AS userId, u.name, p.status,
    EXISTS (SELECT 1 FROM submissions s WHERE s.task_id=p.task_id AND s.user_id=p.user_id) AS submitted
    FROM participants p JOIN users u ON u.id=p.user_id WHERE p.task_id=? ORDER BY u.username`, id);
}

function taskView(db: Store, row: TaskRow, user: User) {
  const input = taskInputFromRow(row);
  const counts = db.get<{participants:number; submitted:number}>(`SELECT COUNT(*) AS participants,
    COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM submissions s WHERE s.task_id=p.task_id AND s.user_id=p.user_id)) AS submitted
    FROM participants p WHERE p.task_id=? AND p.status='required'`, row.id)!;
  const mine = db.get<{status:Participant['status']}>('SELECT status FROM participants WHERE task_id=? AND user_id=?', row.id, user.id);
  const latest = db.get<SubmissionRow>(`${submissionsSelect} WHERE s.task_id=? AND s.user_id=? ORDER BY s.version DESC LIMIT 1`, row.id, user.id);
  return {
    ...input, id:row.id, kind:row.kind, version:row.version, createdAt:row.created_at, updatedAt:row.updated_at,
    authorName:row.author_name, participantCount:input.requiresSubmission ? counts.participants : 0,
    submittedCount:input.requiresSubmission ? counts.submitted : 0, mySubmission:latest ? submissionView(latest) : null,
    myParticipantStatus:input.requiresSubmission ? mine?.status ?? null : null,
  };
}

function initializeParticipants(db: Store, id: string, requiresSubmission: boolean) {
  if (requiresSubmission) {
    db.run(`INSERT INTO participants(task_id, user_id)
      SELECT ?, id FROM users WHERE active=1 AND role IN ('student', 'committee')`, id);
  }
  db.run('UPDATE tasks SET snapshot_created=1 WHERE id=?', id);
}

function validateTaskUpdate(db: Store, row: TaskRow, next: TaskInput) {
  const previous = taskInputFromRow(row);
  if (next.status === 'archived' && !row.snapshot_created) throw new HttpError(409, '请先发布任务');
  if (row.status === 'archived' && next.status === 'draft') throw new HttpError(409, '归档任务须通过重新发布开放');
  if (row.status === 'archived' && next.status === 'published' && next.requiresSubmission &&
    next.deadline && Date.parse(next.deadline) < Date.now() && !next.allowLate) {
    throw new HttpError(409, '重新开放前请调整截止时间或允许补交');
  }
  if (row.snapshot_created && next.requiresSubmission && (!previous.requiresSubmission ||
    (next.attachmentRequired && !previous.attachmentRequired))) {
    throw new HttpError(409, '已开放的任务不能提高提交要求');
  }
  if (row.kind === 'affairs' && db.get('SELECT id FROM submissions WHERE task_id=? LIMIT 1', row.id)) {
    const oldFieldsMatch = previous.fields.every((field, index) => JSON.stringify(next.fields[index]) === JSON.stringify(field));
    if (!oldFieldsMatch || next.fields.slice(previous.fields.length).some(field => field.required)) {
      throw new HttpError(409, '已有提交后只能追加非必填字段');
    }
  }
}

function validatedTaskInput(input: TaskInput, kind: Kind): TaskInput {
  if (kind === 'homework' && input.fields.length) throw new HttpError(400, '作业不支持自定义事务表单');
  if (input.attachmentRequired && !input.requiresSubmission) throw new HttpError(400, '免交任务不能要求提交附件');
  return {...input, deadline:input.deadline ? new Date(input.deadline).toISOString() : null};
}

function getSubmissionRows(db: Store, id: string, userId?: string, history = false) {
  const params = userId ? [id, userId] : [id];
  const filterUser = userId ? 'AND s.user_id=?' : '';
  const filterLatest = history ? '' : `AND NOT EXISTS (
    SELECT 1 FROM submissions newer WHERE newer.task_id=s.task_id AND newer.user_id=s.user_id AND newer.version>s.version
  )`;
  return db.all<SubmissionRow>(`${submissionsSelect} WHERE s.task_id=? ${filterUser} ${filterLatest}
    ORDER BY s.created_at DESC, s.version DESC, s.id`, ...params);
}

function validateAnswers(fields: Field[], answers: Record<string, unknown>) {
  const definitions = new Map(fields.map(field => [field.id, field]));
  if (Object.keys(answers).some(id => !definitions.has(id))) throw new HttpError(400, '提交包含未知字段');
  const clean: Record<string, string | string[]> = {};
  const files: string[] = [];
  for (const field of fields) {
    const value = Object.hasOwn(answers, field.id) ? answers[field.id] : undefined;
    if (value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)) {
      if (field.required) throw new HttpError(400, `请填写：${field.label}`);
      continue;
    }
    switch (field.type) {
      case 'text':
      case 'textarea':
        clean[field.id] = parse(z.string().trim().max(field.type === 'text' ? 500 : 10000), value);
        break;
      case 'select':
        if (typeof value !== 'string' || !field.options?.includes(value)) throw new HttpError(400, `选项无效：${field.label}`);
        clean[field.id] = value;
        break;
      case 'multiselect': {
        const choices = parse(z.array(z.string()).max(100), value);
        if (choices.some(choice => !field.options?.includes(choice))) throw new HttpError(400, `选项无效：${field.label}`);
        clean[field.id] = [...new Set(choices)];
        break;
      }
      case 'file': {
        const ids = parse(z.union([fileId, attachmentSchema]), value);
        files.push(...(Array.isArray(ids) ? ids : [ids]));
        clean[field.id] = ids;
        break;
      }
    }
  }
  return {clean, files};
}

async function exportTask(db: Store, user: User, row: TaskRow) {
  const workbook = new ExcelJS.Workbook();
  const participants = workbook.addWorksheet('参与情况');
  const history = workbook.addWorksheet('提交历史');
  participants.addRow(['姓名', '参与状态', '完成状态', '最后提交时间', '说明', '答案', '附件编号']);
  history.addRow(['姓名', '版本', '提交时标题', '提交时间', '迟交', '说明', '答案', '附件编号']);
  const submissions = getSubmissionRows(db, row.id, undefined, true);
  const latest = new Map<string, SubmissionRow>();
  for (const submission of submissions) {
    if (!latest.has(submission.user_id)) latest.set(submission.user_id, submission);
    history.addRow([submission.name, submission.version, submission.task_title, submission.created_at,
      submission.late ? '是' : '否', submission.text, exportAnswers(submission), json<string[]>(submission.attachments, []).join('\n')]);
  }
  for (const participant of participantRows(db, row.id)) {
    const submission = latest.get(participant.userId);
    participants.addRow([participant.name, participant.status === 'excused' ? '免交' : '要求提交',
      submission ? (submission.late ? '补交' : '已交') : participant.status === 'excused' || !row.requires_submission ? '' : '未交',
      submission?.created_at, submission?.text, submission ? exportAnswers(submission) : '',
      json<string[]>(submission?.attachments, []).join('\n')]);
  }
  for (const sheet of [participants, history]) {
    sheet.getRow(1).font = {bold:true};
    sheet.views = [{state:'frozen', ySplit:1}];
    sheet.columns.forEach(column => { column.width = 26; column.alignment = {wrapText:true, vertical:'top'}; });
  }
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const filename = row.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 60);
  return createExport(db, user, `${filename}-提交汇总.xlsx`, buffer,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', {kind:'task', id:row.id});
}

function exportAnswers(submission: SubmissionRow) {
  const fields = json<Field[]>(submission.schema_snapshot, []);
  const answers = json<Record<string, unknown>>(submission.answers, {});
  return fields.filter(field => Object.hasOwn(answers, field.id)).map(field => {
    const answer = answers[field.id];
    return `${field.label}：${Array.isArray(answer) ? answer.join('、') : String(answer)}`;
  }).join('\n');
}

export function registerTasks(app: FastifyInstance, db: Store) {
  for (const kind of ['homework', 'affairs'] as const) {
    const base = `/api/${kind}`;
    app.get(base, async request => {
      const user = requireUser(request);
      return db.all<TaskRow>(`${tasksSelect} WHERE t.kind=? AND (?=0 OR t.status<>'draft')
        ORDER BY t.updated_at DESC, t.id`, kind, Number(user.role === 'student')).map(row => taskView(db, row, user));
    });
    app.get<{Params:TaskParams}>(`${base}/:id`, async request => {
      const user = requireUser(request);
      return taskView(db, taskRow(db, kind, request.params.id, user), user);
    });
    app.post(base, async (request, reply) => {
      const user = requireManager(request);
      const parsed = parse(taskInput.partial().required({title:true}), request.body);
      const input = validatedTaskInput({
        course:'', description:'', deadline:null, allowLate:false, requiresSubmission:true, attachmentRequired:false,
        status:'draft', fields:[], attachments:[], ...parsed,
      }, kind);
      if (input.status === 'archived') throw new HttpError(400, '新任务可以保存草稿或发布');
      const task = db.transaction(() => {
        const id = uid();
        validateAttachments(db, user, input.attachments, 'task-attachment');
        const createdAt = now();
        db.run(`INSERT INTO tasks (id, kind, title, course, description, deadline, allow_late, requires_submission,
          attachment_required, status, fields, attachments, author_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, kind, input.title, input.course,
        input.description, input.deadline, Number(input.allowLate), Number(input.requiresSubmission),
        Number(input.attachmentRequired), input.status, JSON.stringify(input.fields), JSON.stringify(input.attachments),
        user.id, createdAt, createdAt);
        bindAttachments(db, input.attachments, id);
        if (input.status === 'published') initializeParticipants(db, id, input.requiresSubmission);
        db.audit(user.id, `${kind}.create`, id, {status:input.status});
        return taskView(db, taskRow(db, kind, id, user), user);
      });
      return reply.code(201).send(task);
    });
    app.put<{Params:TaskParams}>(`${base}/:id`, async request => {
      const user = requireManager(request);
      const {version, ...changes} = parse(taskInput.partial().extend({version:versionSchema}), request.body);
      const {id} = request.params;
      return db.transaction(() => {
        const row = taskRow(db, kind, id, user);
        conflict(row.version, version);
        const next = validatedTaskInput({...taskInputFromRow(row), ...changes}, kind);
        validateTaskUpdate(db, row, next);
        if (changes.attachments) validateAttachments(db, user, next.attachments, 'task-attachment', id);
        db.run(`UPDATE tasks SET title=?, course=?, description=?, deadline=?, allow_late=?, requires_submission=?,
          attachment_required=?, status=?, fields=?, attachments=?, version=version+1, updated_at=? WHERE id=?`,
        next.title, next.course, next.description, next.deadline, Number(next.allowLate), Number(next.requiresSubmission),
        Number(next.attachmentRequired), next.status, JSON.stringify(next.fields), JSON.stringify(next.attachments), now(), id);
        if (changes.attachments) bindAttachments(db, next.attachments, id);
        if (next.status === 'published' && !row.snapshot_created) initializeParticipants(db, id, next.requiresSubmission);
        db.audit(user.id, `${kind}.update`, id, {version:row.version + 1, previousStatus:row.status, status:next.status});
        return taskView(db, taskRow(db, kind, id, user), user);
      });
    });
    app.get<{Params:TaskParams;Querystring:{history?:string}}>(`${base}/:id/submissions`, async request => {
      const user = requireUser(request);
      const task = taskRow(db, kind, request.params.id, user);
      return getSubmissionRows(db, task.id, user.role === 'student' ? user.id : undefined, request.query.history === '1').map(submissionView);
    });
    app.post<{Params:TaskParams}>(`${base}/:id/submissions`, async (request, reply) => {
      const user = requireUser(request);
      if (user.role === 'admin') throw new HttpError(403, '管理员不能提交');
      const input = parse(submissionInput, request.body);
      const {id} = request.params;
      const submission = db.transaction(() => {
        const task = taskRow(db, kind, id, user);
        if (task.status !== 'published' || !task.requires_submission) throw new HttpError(409, '该任务当前不接受提交');
        if (!db.get("SELECT user_id FROM participants WHERE task_id=? AND user_id=? AND status='required'", id, user.id)) {
          throw new HttpError(403, '您不在当前参与名单中');
        }
        const fields = json<Field[]>(task.fields, []);
        const {clean, files} = validateAnswers(fields, input.answers);
        const attachments = parse(attachmentSchema, [...new Set([...input.attachments, ...files])]);
        if (task.attachment_required && !attachments.length) throw new HttpError(400, '请添加必填附件');
        if (!input.text && !attachments.length && !Object.keys(clean).length && (kind === 'homework' || fields.length === 0)) {
          throw new HttpError(400, '请填写说明或添加附件');
        }
        validateAttachments(db, user, attachments, 'submission', id);
        const createdAt = now();
        const late = task.deadline !== null && Date.parse(createdAt) > Date.parse(task.deadline);
        if (late && !task.allow_late) throw new HttpError(409, '已超过截止时间');
        const version = 1 + (db.get<{version:number}>(
          'SELECT version FROM submissions WHERE task_id=? AND user_id=? ORDER BY version DESC LIMIT 1', id, user.id)?.version ?? 0);
        const submissionId = uid();
        db.run(`INSERT INTO submissions (id, task_id, user_id, text, answers, attachments, schema_snapshot,
          task_title, late, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        submissionId, id, user.id, input.text, JSON.stringify(clean), JSON.stringify(attachments), task.fields,
        task.title, Number(late), version, createdAt);
        bindAttachments(db, attachments, id);
        db.audit(user.id, `${kind}.submit`, id, {submissionId, version, late});
        return submissionView(db.get<SubmissionRow>(`${submissionsSelect} WHERE s.id=?`, submissionId)!);
      });
      return reply.code(201).send(submission);
    });
    app.get<{Params:TaskParams}>(`${base}/:id/participants`, async request => {
      const user = requireManager(request);
      const row = taskRow(db, kind, request.params.id, user);
      return participantRows(db, row.id).map(participant => ({...participant, submitted:Boolean(participant.submitted)}));
    });
    app.put<{Params:TaskParams}>(`${base}/:id/participants`, async request => {
      const user = requireManager(request);
      const input = parse(z.object({userIds:z.array(z.string().uuid()).max(1000), version:versionSchema}), request.body);
      const {id} = request.params;
      const userIds = [...new Set(input.userIds)];
      return db.transaction(() => {
        const row = taskRow(db, kind, id, user);
        conflict(row.version, input.version);
        if (!row.snapshot_created || !row.requires_submission) throw new HttpError(409, '首次发布需要提交的任务后才能调整名单');
        for (const userId of userIds) {
          if (!db.get("SELECT id FROM users WHERE id=? AND active=1 AND role<>'admin'", userId)) {
            throw new HttpError(400, '参与名单只能包含有效的学生或班委');
          }
        }
        db.run("UPDATE participants SET status='excused' WHERE task_id=? AND status='required'", id);
        for (const userId of userIds) {
          db.run(`INSERT INTO participants(task_id, user_id) VALUES (?, ?)
            ON CONFLICT(task_id, user_id) DO UPDATE SET status='required'`, id, userId);
        }
        db.run('UPDATE tasks SET version=version+1, updated_at=? WHERE id=?', now(), id);
        db.audit(user.id, `${kind}.participants`, id, {userIds});
        return taskView(db, taskRow(db, kind, id, user), user);
      });
    });
    app.post<{Params:TaskParams}>(`${base}/:id/export`, async request => {
      const user = requireManager(request);
      return exportTask(db, user, taskRow(db, kind, request.params.id, user));
    });
    app.post<{Params:TaskParams}>(`${base}/:id/export-files`, async request => {
      const user = requireManager(request);
      const task = taskRow(db, kind, request.params.id, user);
      const {userIds} = parse(z.object({userIds:z.array(z.string().uuid()).max(1000).optional()}), request.body ?? {});
      const selected = userIds && new Set(userIds);
      const fileIds = getSubmissionRows(db, task.id)
        .filter(submission => !selected || selected.has(submission.user_id))
        .flatMap(submission => json<string[]>(submission.attachments, []));
      if (!fileIds.length) throw new HttpError(400, '所选学生的最新提交没有附件');
      const title = task.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 60);
      return createBundle(db, user, fileIds, `${title}-提交附件`, {kind:'task', id:task.id});
    });
  }
  app.get('/api/submissions/history', async request => {
    const user = requireUser(request);
    return db.all<SubmissionRow>(`${submissionsSelect} WHERE s.user_id=? ORDER BY s.created_at DESC, s.version DESC, s.id`, user.id)
      .map(row => ({...submissionView(row), taskTitle:row.task_title}));
  });
}
