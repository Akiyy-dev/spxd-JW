import type {FastifyInstance} from 'fastify';
import type {Store} from './db.ts';
import {z} from 'zod';
import {conflict,dateSchema,HttpError,json,now,parse,requirePermission,requireUser,uid,type User} from './common.ts';
import {can} from '../shared/permissions.ts';
import {bindAttachments,replaceAvatar,validateAttachments} from './files.ts';
export const defaultConfig={name:'班级空间',subtitle:'在一起，向前走',introduction:'欢迎来到我们的班级空间。',academicYear:'2026—2027 学年',semesterStart:'2026-09-01',semesterEnd:'2027-01-31',holidays:[] as string[],demo:false,version:1};
const resourceSchema=z.object({title:z.string().trim().min(1).max(150),description:z.string().max(5000).default(''),category:z.string().trim().min(1).max(50).default('学习资料'),url:z.string().max(2000).refine(v=>!v||/^https?:\/\//i.test(v),'链接必须以 https:// 或 http:// 开头').default(''),attachments:z.array(z.string()).max(5).default([]),pinned:z.boolean().default(false),status:z.enum(['draft','published','archived']).default('draft')});
// Update omissions must retain stored values, rather than applying creation defaults.
const resourceChanges=z.object({title:resourceSchema.shape.title.optional(),description:resourceSchema.shape.description.removeDefault().optional(),category:resourceSchema.shape.category.removeDefault().optional(),url:resourceSchema.shape.url.removeDefault().optional(),attachments:resourceSchema.shape.attachments.removeDefault().optional(),pinned:resourceSchema.shape.pinned.removeDefault().optional(),status:resourceSchema.shape.status.removeDefault().optional()});
function resource(r:any){return{id:r.id,title:r.title,description:r.description,category:r.category,url:r.url,attachments:json(r.attachments,[]),pinned:!!r.pinned,status:r.status,version:r.version,createdAt:r.created_at,updatedAt:r.updated_at,authorName:r.author_name??''}}
const configSchema=z.object({name:z.string().trim().min(1).max(60).optional(),subtitle:z.string().max(150).optional(),introduction:z.string().max(10000).optional(),academicYear:z.string().max(60).optional(),semesterStart:dateSchema.optional(),semesterEnd:dateSchema.optional(),holidays:z.array(dateSchema).max(400).optional(),photoFileId:z.string().optional()});
function visible(u:User,status:string){return status==='published'||status==='draft'&&can(u,'resources.drafts.read')||status==='archived'&&can(u,'resources.archived.read')}
function classData(db:Store){const config=db.setting('class',defaultConfig);return{config,members:db.all("SELECT id,name,role,profile FROM users WHERE active=1 AND (role IN ('student','committee') OR in_class=1) ORDER BY role,name").map(r=>{const p=json<any>(r.profile,{});return{id:r.id,name:p.displayName||r.name,role:r.role,position:p.position??'',avatarFileId:p.avatarFileId??''}}),version:config.version}}

export function registerCatalog(app:FastifyInstance,db:Store){
  app.get('/api/resources',async req=>{const u=requireUser(req);return db.all('SELECT r.*,u.name author_name FROM resources r JOIN users u ON u.id=r.author_id ORDER BY pinned DESC,updated_at DESC').filter(r=>visible(u,r.status)).map(resource)});
  app.post('/api/resources',async req=>{
    const u=requirePermission(req,'resources.create'),v=parse(resourceSchema,req.body),id=uid();
    if(v.status==='published')requirePermission(req,'resources.publish');
    if(v.status==='archived')requirePermission(req,'resources.archive');
    validateAttachments(db,u,v.attachments,'resource');
    return db.transaction(()=>{
      db.run('INSERT INTO resources VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,v.title,v.description,v.category,v.url,JSON.stringify(v.attachments),+v.pinned,v.status,1,u.id,now(),now());
      bindAttachments(db,v.attachments,id);db.audit(u.id,'resource.create',id,{title:v.title});return resource(db.get('SELECT * FROM resources WHERE id=?',id));
    });
  });
  app.put<{Params:{id:string}}>('/api/resources/:id',async req=>{
    const u=requireUser(req),body=parse(z.object({version:z.number().int(),changes:resourceChanges}),req.body);
    return db.transaction(()=>{
      const old=db.get('SELECT * FROM resources WHERE id=?',req.params.id);if(!old)throw new HttpError(404,'资料不存在');
      if(!visible(u,old.status))throw new HttpError(403,'无权读取此资料');
      conflict(old.version,body.version);const before=resource(old),v=parse(resourceSchema,{...before,...body.changes});
      const contentChanged=Object.keys(v).some(key=>key!=='status'&&JSON.stringify(v[key as keyof typeof v])!==JSON.stringify(before[key as keyof typeof before]));
      if(contentChanged||v.status===old.status)requirePermission(req,'resources.edit');
      if(contentChanged&&(old.status==='published'||v.status==='published')||old.status!=='published'&&v.status==='published')requirePermission(req,'resources.publish');
      if(v.status!==old.status&&v.status!=='published')requirePermission(req,'resources.archive');
      if(contentChanged)validateAttachments(db,u,v.attachments,'resource',old.id);
      db.run('INSERT INTO resource_versions VALUES(?,?,?,?,?)',uid(),old.id,JSON.stringify(before),old.version,now());
      db.run('UPDATE resources SET title=?,description=?,category=?,url=?,attachments=?,pinned=?,status=?,version=version+1,updated_at=? WHERE id=?',v.title,v.description,v.category,v.url,JSON.stringify(v.attachments),+v.pinned,v.status,now(),old.id);
      bindAttachments(db,v.attachments,old.id);db.audit(u.id,'resource.update',old.id,{from:old.version});return resource(db.get('SELECT * FROM resources WHERE id=?',old.id));
    });
  });
  app.get<{Params:{id:string}}>('/api/resources/:id/history',async req=>{
    const u=requirePermission(req,'resources.history.read'),current=db.get('SELECT status FROM resources WHERE id=?',req.params.id);
    if(!current)throw new HttpError(404,'资料不存在');
    if(!visible(u,current.status))throw new HttpError(403,'无权读取此资料');
    return db.all('SELECT * FROM resource_versions WHERE resource_id=? ORDER BY version DESC',req.params.id).map(r=>json<{status:string}>(r.data,{status:''})).filter(r=>visible(u,r.status));
  });
  app.get('/api/class',async req=>{requireUser(req);return classData(db)});
  app.put('/api/class',async req=>{
    const u=requireUser(req),v=parse(z.object({version:z.number().int(),config:configSchema.optional(),members:z.array(z.object({id:z.string(),name:z.string().max(100).optional(),displayName:z.string().max(100).optional(),position:z.string().max(100).optional(),avatarFileId:z.string().optional()})).max(500).optional(),duties:z.unknown().optional()}),req.body);
    if(v.config!==undefined)requirePermission(req,'class.settings.edit');
    if(v.members!==undefined)requirePermission(req,'class.members.edit');
    if(Object.hasOwn(v,'duties')){
      requirePermission(req,'class.duties.edit');
      throw new HttpError(409,'值日安排已移至独立页面，请刷新后前往值日安排修改');
    }
    if(v.config===undefined&&v.members===undefined)throw new HttpError(400,'请填写要修改的内容');
    return db.transaction(()=>{
      const old=db.setting('class',defaultConfig);conflict(old.version,v.version);const next={...old,...v.config,version:old.version+1};
      if(next.semesterStart>next.semesterEnd)throw new HttpError(400,'学期结束日期不能早于开始日期');
      if(v.config?.photoFileId){validateAttachments(db,u,[v.config.photoFileId],'class-photo','class');bindAttachments(db,[v.config.photoFileId],'class')}
      for(const m of v.members??[]){
        const row=db.get('SELECT * FROM users WHERE id=?',m.id);if(!row)throw new HttpError(400,'成员不存在');
        if(u.role!=='super_admin'&&['admin','super_admin'].includes(row.role))throw new HttpError(403,'只有 Admin 可维护管理员资料');
        const p=json<any>(row.profile,{});if(m.avatarFileId!==undefined)replaceAvatar(db,u,m.id,p.avatarFileId||null,m.avatarFileId||null);
        db.run('UPDATE users SET profile=?,version=version+1 WHERE id=?',JSON.stringify({...p,displayName:m.displayName??m.name??p.displayName,position:m.position??p.position,avatarFileId:m.avatarFileId??p.avatarFileId}),m.id);
      }
      db.setSetting('class',next);db.audit(u.id,'class.update','class',{version:next.version});return classData(db);
    });
  });
}
