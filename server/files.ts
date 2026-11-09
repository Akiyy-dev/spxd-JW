import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {createHash} from 'node:crypto';
import type {Store} from './db.ts';
import type {User} from './common.ts';
import {HttpError,json,now,parse,requireUser,uid} from './common.ts';
import {can,isClassMember,type Permission} from '../shared/permissions.ts';
import {z} from 'zod';
import COS from 'cos-nodejs-sdk-v5';
import JSZip from 'jszip';
import {extname} from 'node:path';
export interface StorageAdapter { configured:boolean; uploadUrl(key:string,mime:string,size:number):Promise<{url:string,headers:Record<string,string>}>; head(key:string):Promise<{size:number,mime:string}>; readHead(key:string):Promise<Buffer>; read?(key:string):Promise<Buffer>; downloadUrl(key:string,filename:string,preview?:boolean):Promise<string>; put(key:string,buffer:Buffer,mime:string):Promise<void>; remove(key:string):Promise<void> }
const stores=new WeakMap<Store,StorageAdapter>();
export class CosStorage implements StorageAdapter {
  configured:boolean; private client:COS; private bucket:string; private region:string;
  constructor(){this.bucket=process.env.COS_BUCKET??'';this.region=process.env.COS_REGION??'';this.configured=!!(this.bucket&&this.region&&process.env.COS_SECRET_ID&&process.env.COS_SECRET_KEY);this.client=new COS({SecretId:process.env.COS_SECRET_ID??'',SecretKey:process.env.COS_SECRET_KEY??'',SecurityToken:process.env.COS_SESSION_TOKEN,Protocol:'https:'});}
  private params(key:string){return {Bucket:this.bucket,Region:this.region,Key:key};}
  private async call(method:string,params:Record<string,unknown>):Promise<any>{return new Promise((resolve,reject)=>(this.client as any)[method](params,(e:any,d:any)=>e?reject(e):resolve(d)));}
  async uploadUrl(key:string,mime:string,size:number){const headers={'Content-Type':mime,'x-cos-forbid-overwrite':'true'};const result=await this.call('getObjectUrl',{...this.params(key),Method:'PUT',Expires:600,Headers:{...headers,'Content-Length':String(size)}});return{url:result.Url,headers};}
  async head(key:string){const r=await this.call('headObject',this.params(key));return {size:Number(r.headers['content-length']),mime:String(r.headers['content-type']??'').split(';')[0]};}
  async readHead(key:string){const r=await this.call('getObject',{...this.params(key),Range:'bytes=0-1023'});return Buffer.isBuffer(r.Body)?r.Body:Buffer.from(r.Body);}
  async read(key:string){const r=await this.call('getObject',this.params(key));return Buffer.isBuffer(r.Body)?r.Body:Buffer.from(r.Body);}
  async downloadUrl(key:string,filename:string,preview=false){const inline=preview&&!!process.env.COS_PREVIEW_DOMAIN;const r=await this.call('getObjectUrl',{...this.params(key),Method:'GET',Expires:300,...(inline?{Domain:process.env.COS_PREVIEW_DOMAIN}:{}),Query:{'response-content-disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(filename.replace(/[\r\n]/g,''))}`}});return r.Url;}
  async put(key:string,buffer:Buffer,mime:string){await this.call('putObject',{...this.params(key),Body:buffer,ContentType:mime,ContentLength:buffer.length,Headers:{'x-cos-forbid-overwrite':'true'}});}
  async remove(key:string){await this.call('deleteObject',this.params(key));}
}
const types:Record<string,string>={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.txt':'text/plain','.csv':'text/csv','.zip':'application/zip','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
const previewTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const maxPreviewSize = 20 * 1024 * 1024;
export const maxAvatarSize = 5 * 1024 * 1024;
const avatarTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
function previewable(f: any) {
  return previewTypes.has(f.mime) && types[extname(f.name).toLowerCase()] === f.mime;
}
const financeRead=(u:User)=>can(u,'finance.read');
const receiptWrites=['finance.entries.create','finance.entries.edit','finance.payments.create','finance.payments.edit'] as const;
const taskWrites=['homework.create','homework.edit','homework.publish','affairs.create','affairs.edit','affairs.publish'] as const;
type TaskKind='homework'|'affairs';
type ExportScope={kind:string;id?:string;permission?:Permission};
// A request snapshot cannot authorize work after a storage await: grants,
// account state and the business association may have changed in the meantime.
function currentUser(db:Store,previous:User,request?:FastifyRequest):User {
  const row=db.get('SELECT * FROM users WHERE id=?',previous.id);
  if(!row||!row.active)throw new HttpError(401,'账号已停用，请重新登录');
  if(row.must_change_password)throw new HttpError(403,'请先修改初始密码');
  const token=request?.cookies?.class_session;
  if(token&&!db.get('SELECT user_id FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',createHash('sha256').update(token).digest('hex'),previous.id,now()))throw new HttpError(401,'登录状态已失效，请重新登录');
  return {...previous,username:row.username,name:row.name,role:row.role,permissions:json<Permission[]>(row.permissions,[]),
    financeManage:row.role==='committee'&&Boolean(row.finance_manage),inClass:isClassMember({role:row.role,inClass:Boolean(row.in_class)}),
    active:true,mustChangePassword:false,version:row.version};
}
function sameFile(previous:any,current:any) {
  if(['object_key','size','mime','purpose','entity_id','owner_id','scope'].some(key=>previous[key]!==current[key]))throw new HttpError(409,'文件关联已改变，请重新请求');
}
function readableFile(db:Store,user:User,id:string,previous?:any) {
  const file=db.get('SELECT * FROM files WHERE id=?',id);
  if(!file)throw new HttpError(404,'文件不存在');
  if(!canReadFile(db,user,file))throw new HttpError(403,'无权读取此文件');
  if(previous)sameFile(previous,file);
  return file;
}
function currentExportUser(db:Store,user:User,scope:ExportScope,sources:any[]=[],request?:FastifyRequest) {
  const current=currentUser(db,user,request);
  if(!exportAccess(db,current,scope))throw new HttpError(403,'无权导出');
  for(const source of sources)readableFile(db,current,source.id,source);
  return current;
}
function allowed(user:User,permission:Permission){if(!can(user,permission))throw new HttpError(403,'没有执行此文件操作的权限');}
function requireLegacy(user:User,purpose:string){
  const permissions=purpose==='receipt'?receiptWrites:taskWrites;
  if(!permissions.every(permission=>can(user,permission)))throw new HttpError(403,'请提供具有授权的上传业务上下文');
}
function scopeContext(file:any):string|undefined {return json<{context?:string}>(file.scope,{}).context;}
function taskVisible(user:User,task:any){return task.status!=='draft'||can(user,`${task.kind as TaskKind}.drafts.read`);}
function resourceVisible(user:User,resource:any){return resource.status==='published'||resource.status==='draft'&&can(user,'resources.drafts.read')||resource.status==='archived'&&can(user,'resources.archived.read');}
function uploadAccess(db:Store,u:User,purpose:string,entityId?:string|null,context?:string,binding=false):string|undefined {
  if(purpose==='avatar'){
    const target=entityId&&db.get('SELECT role FROM users WHERE id=? AND active=1',entityId);
    if(!target)throw new HttpError(400,'头像必须关联启用的账号');
    if(entityId!==u.id){
      allowed(u,'class.members.edit');
      if(u.role!=='super_admin'&&['admin','super_admin'].includes(target.role))throw new HttpError(403,'只有 Admin 可维护管理员头像');
    }
    return;
  }
  if(purpose==='receipt'){
    if(context&&!receiptWrites.includes(context as typeof receiptWrites[number]))throw new HttpError(403,'班费凭证上下文无效');
    if(context)allowed(u,context as Permission);else requireLegacy(u,purpose);
    if(entityId){
      const entry=db.get('SELECT * FROM finance_entries WHERE id=?',entityId),payment=db.get('SELECT * FROM payments WHERE id=?',entityId);
      const target=entry??payment;
      if(target){
        const expected=entry?'finance.entries.edit':'finance.payments.edit';
        if(context&&context!==expected)throw new HttpError(403,'凭证操作与记录不匹配');
        allowed(u,expected);
        if(target.voided||entry?.payment_id)throw new HttpError(409,'该记录当前不能修改凭证');
      }else if(!binding||context?.endsWith('.edit'))throw new HttpError(404,'班费记录不存在');
    }else if(context?.endsWith('.edit'))throw new HttpError(400,'修订凭证需要关联班费记录');
    return context;
  }
  if(purpose==='submission'){const task=db.get('SELECT * FROM tasks WHERE id=?',entityId??'');if(!task||task.status!=='published'||!task.requires_submission)throw new HttpError(400,'作业或事务当前不可提交');if(!isClassMember(u)||!db.get("SELECT 1 FROM participants WHERE task_id=? AND user_id=? AND status='required'",task.id,u.id))throw new HttpError(403,'你不在本次提交名单中');if(task.deadline&&task.deadline<now()&&!task.allow_late)throw new HttpError(400,'已超过提交截止时间');return}
  if(purpose==='task-attachment'){
    if(context&&context!=='homework'&&context!=='affairs')throw new HttpError(403,'任务附件上下文无效');
    const task=entityId&&db.get('SELECT * FROM tasks WHERE id=?',entityId);
    if(entityId&&!task)throw new HttpError(404,'任务不存在');
    if(task){
      if(context&&context!==task.kind)throw new HttpError(403,'任务附件类型不匹配');
      allowed(u,`${task.kind as TaskKind}.edit`);
      if(task.status==='published')allowed(u,`${task.kind as TaskKind}.publish`);
      return task.kind;
    }
    if(context)allowed(u,`${context as TaskKind}.create`);else requireLegacy(u,purpose);
    return context;
  }
  if(purpose==='resource'){
    const resource=entityId&&db.get('SELECT * FROM resources WHERE id=?',entityId);
    if(entityId&&!resource)throw new HttpError(404,'资料不存在');
    allowed(u,resource?'resources.edit':'resources.create');
    if(resource&&!resourceVisible(u,resource))throw new HttpError(403,'无权读取此资料');
    if(resource?.status==='published')allowed(u,'resources.publish');
    return;
  }
  if(purpose==='class-photo'){allowed(u,'class.settings.edit');return;}
  throw new HttpError(403,'不支持此文件用途');
}
function hasId(raw:unknown,id:string){return json<string[]>(raw,[]).includes(id)}
function currentAttachment(db:Store,f:any):boolean {
  if(!f.entity_id)return false;
  if(f.purpose==='task-attachment')return hasId(db.get('SELECT attachments FROM tasks WHERE id=?',f.entity_id)?.attachments,f.id);
  if(f.purpose==='resource')return hasId(db.get('SELECT attachments FROM resources WHERE id=?',f.entity_id)?.attachments,f.id);
  if(f.purpose==='receipt')return hasId(db.get('SELECT receipt_ids FROM finance_entries WHERE id=? OR payment_id=?',f.entity_id,f.entity_id)?.receipt_ids,f.id);
  if(f.purpose==='submission')return db.all('SELECT attachments FROM submissions WHERE task_id=? AND user_id=?',f.entity_id,f.owner_id).some(row=>hasId(row.attachments,f.id));
  if(f.purpose==='avatar')return json<any>(db.get('SELECT profile FROM users WHERE id=?',f.entity_id)?.profile,{}).avatarFileId===f.id;
  return f.purpose==='class-photo'&&db.setting<any>('class',{}).photoFileId===f.id;
}
function stagedRead(db:Store,user:User,file:any):boolean {
  if(file.owner_id!==user.id||file.entity_id&&!file.expires_at)return false;
  try{uploadAccess(db,user,file.purpose,file.entity_id,scopeContext(file));return true;}catch{return false;}
}
function exportAccess(db:Store,user:User,scope:ExportScope):boolean {
  if(scope.kind==='finance')return (!scope.permission||scope.permission==='finance.export')&&can(user,'finance.export');
  if(scope.kind!=='task'||!scope.id)return false;
  const task=db.get('SELECT kind,status FROM tasks WHERE id=?',scope.id);
  if(!task||!taskVisible(user,task))return false;
  const spreadsheet=`${task.kind as TaskKind}.export` as const,bundle=`${task.kind as TaskKind}.exportFiles` as const;
  return scope.permission?(scope.permission===spreadsheet||scope.permission===bundle)&&can(user,scope.permission):can(user,spreadsheet)&&can(user,bundle);
}
export function canReadFile(db:Store,u:User|null,f:any):boolean {
  if(f.status!=='ready'||(f.expires_at&&f.expires_at<now()))return false;
  const config=db.setting<any>('class',{});
  if(f.purpose==='class-photo'&&config.photoFileId===f.id)return true;
  if(!u||u.mustChangePassword)return false;
  if(f.purpose==='export')return f.owner_id===u.id&&exportAccess(db,u,json<ExportScope>(f.scope,{kind:''}));
  if(f.purpose==='receipt'){
    const entry = db.get('SELECT * FROM finance_entries WHERE id=? OR payment_id=?', f.entity_id, f.entity_id);
    const auditor = financeRead(u);
    if (!entry) return stagedRead(db,u,f);
    if (hasId(entry.receipt_ids, f.id)) return auditor || (!entry.voided && !!entry.public_receipt);
    if(stagedRead(db,u,f))return true;
    if (!can(u,'finance.history')) return false;
    const entityType = f.entity_id === entry.id ? 'entry' : 'payment';
    return db.all<{ data: string }>('SELECT data FROM finance_versions WHERE entity_type=? AND entity_id=?', entityType, f.entity_id)
      .some(row => {
        type Snapshot = { receiptIds?: unknown; receipt_ids?: unknown };
        const revision = json<(Snapshot & { before?: Snapshot }) | null>(row.data, null);
        const snapshot = revision?.before ?? revision;
        const ids = snapshot?.receiptIds ?? json<unknown>(snapshot?.receipt_ids, []);
        return Array.isArray(ids) && ids.includes(f.id);
      });
  }
  if(f.purpose==='submission'){
    if(currentAttachment(db,f)){
      if(f.owner_id===u.id)return true;
      const task=db.get('SELECT kind,status FROM tasks WHERE id=?',f.entity_id);
      return !!task&&taskVisible(u,task)&&can(u,`${task.kind as TaskKind}.submissions.read`);
    }
    return stagedRead(db,u,f);
  }
  if(f.purpose==='resource'){
    const resource=db.get('SELECT * FROM resources WHERE id=?',f.entity_id);
    if(!resource)return stagedRead(db,u,f);
    if(hasId(resource.attachments,f.id))return resourceVisible(u,resource);
    if(stagedRead(db,u,f))return true;
    return resourceVisible(u,resource)&&can(u,'resources.history.read')&&db.all('SELECT data FROM resource_versions WHERE resource_id=?',f.entity_id).some(row=>{
      const snapshot=json<{status?:string;attachments?:string[]}>(row.data,{});
      return resourceVisible(u,snapshot)&&snapshot.attachments?.includes(f.id);
    });
  }
  if(f.purpose==='task-attachment'){
    const task=db.get('SELECT * FROM tasks WHERE id=?',f.entity_id);
    if(task&&hasId(task.attachments,f.id))return taskVisible(u,task);
    return stagedRead(db,u,f);
  }
  if(f.purpose==='avatar'){
    const member=db.get('SELECT profile FROM users WHERE id=? AND active=1',f.entity_id);
    if(!member)return false;
    if(json<any>(member.profile,{}).avatarFileId===f.id)return true;
    return stagedRead(db,u,f);
  }
  return f.purpose==='class-photo'&&stagedRead(db,u,f);
}
function metadata(f: any, includeOwnership = true) {
  return { id: f.id, name: f.name, size: f.size, mime: f.mime, status: f.status, purpose: f.purpose,
    ...(includeOwnership && { entityId: f.entity_id, ownerId: f.owner_id }), createdAt: f.created_at };
}
function neededStorage(db:Store){const s=stores.get(db);if(!s?.configured)throw new HttpError(503,'尚未配置腾讯云 COS，请管理员完成存储配置后再上传或导出');return s;}
export function validateAttachments(db:Store,user:User,ids:string[],purpose:string,entityId?:string,context?:string){
  if(ids.length>5||new Set(ids).size!==ids.length)throw new HttpError(400,'每次最多5个不同附件');
  if(!ids.length)return;
  user=currentUser(db,user);
  for(const id of ids){
    const f=db.get('SELECT * FROM files WHERE id=?',id);
    if(!f||f.status!=='ready'||f.purpose!==purpose||(f.expires_at&&f.expires_at<now()))throw new HttpError(400,'附件尚未完成上传或用途不匹配');
    if(f.entity_id&&f.entity_id!==entityId)throw new HttpError(403,'附件属于其他记录');
    const retained=f.entity_id===entityId&&currentAttachment(db,f);
    if(f.owner_id!==user.id&&!(retained&&purpose!=='submission'&&purpose!=='avatar'))throw new HttpError(403,'不能使用其他人的附件');
    const targetContext=uploadAccess(db,user,purpose,entityId,context,true);
    if(!retained&&(purpose==='receipt'||purpose==='task-attachment')){
      const storedContext=scopeContext(f);
      if(storedContext){
        if(storedContext!==targetContext)throw new HttpError(403,'附件上传上下文与当前操作不匹配');
        // Recheck the staging capability as well as the target operation.
        if(purpose==='receipt')allowed(user,storedContext as Permission);
      }else requireLegacy(user,purpose);
    }
  }
}
// Callers validate in the same synchronous transaction before storing the association.
export function bindAttachments(db:Store,ids:string[],entityId:string){
  for(const id of ids){
    const file=db.get('SELECT * FROM files WHERE id=?',id);
    if(!file||file.entity_id&&file.entity_id!==entityId)throw new HttpError(403,'附件不能绑定到其他记录');
    const context=scopeContext(file);
    if(file.purpose==='task-attachment'&&context&&db.get('SELECT kind FROM tasks WHERE id=?',entityId)?.kind!==context)throw new HttpError(403,'附件业务类型不匹配');
    if(file.purpose==='receipt'&&context){
      const kind=db.get('SELECT id FROM payments WHERE id=?',entityId)?'payments':'entries';
      if(!context.startsWith(`finance.${kind}.`))throw new HttpError(403,'凭证业务类型不匹配');
    }
    db.run('UPDATE files SET entity_id=?,expires_at=NULL WHERE id=?',entityId,id);
  }
}

// Bind the replacement and retire the old object in the caller's database transaction.
// Storage deletion is deferred to the existing cleanup command.
export function replaceAvatar(db:Store,actor:User,userId:string,previousId:string|null,nextId:string|null){
  if(previousId===nextId)return;
  if(nextId){
    const file=db.get('SELECT * FROM files WHERE id=?',nextId);
    if(file&&file.owner_id!==actor.id)throw new HttpError(403,'不能使用其他人的头像上传');
    validateAttachments(db,actor,[nextId],'avatar',userId);
    if(file.size>maxAvatarSize||!avatarTypes.has(file.mime))throw new HttpError(400,'头像仅支持不超过 5 MiB 的 JPG、PNG、WebP 或 GIF 图片');
    bindAttachments(db,[nextId],userId);
  }
  if(previousId)db.run("UPDATE files SET expires_at=? WHERE id=? AND purpose='avatar' AND entity_id=?",new Date(Date.now()-1).toISOString(),previousId,userId);
}
function sniff(f:any,b:Buffer){const ext=extname(f.name).toLowerCase();if(ext==='.gif')return b.length>=13&&['GIF87a','GIF89a'].includes(b.subarray(0,6).toString())&&b.readUInt16LE(6)>0&&b.readUInt16LE(8)>0;if(ext==='.pdf')return b.subarray(0,5).toString()==='%PDF-';if(ext==='.png')return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));if(['.jpg','.jpeg'].includes(ext))return b[0]===255&&b[1]===216;if(ext==='.webp')return b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';if(['.zip','.docx','.xlsx','.pptx'].includes(ext))return b[0]===80&&b[1]===75;if(['.doc','.xls','.ppt'].includes(ext))return b.subarray(0,4).equals(Buffer.from([208,207,17,224]));return !b.includes(0);}
async function previewContent(db: Store, f: any) {
  if (!previewable(f)) throw new HttpError(415, '此文件类型暂不支持预览，请下载后打开');
  if (f.size <= 0 || f.size > maxPreviewSize) throw new HttpError(413, '预览文件须非空且不超过 20 MB');
  const storage = neededStorage(db);
  if (!storage.read) throw new HttpError(503, '当前存储不支持预览，请下载后打开');
  let bytes: Buffer;
  try { bytes = await storage.read(f.object_key); }
  catch { throw new HttpError(502, '附件读取失败，请稍后重试或下载'); }
  if (bytes.length !== f.size || !sniff(f, bytes)) throw new HttpError(502, '附件内容校验失败，请重新上传');
  return bytes;
}
function sendPreview(reply: FastifyReply, f: any, bytes: Buffer) {
  // Fetch into a browser Blob for the viewer; direct API navigation must not execute uploads.
  return reply.type(f.mime)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Content-Security-Policy', "default-src 'none'; sandbox")
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name.replace(/[\r\n]/g, ''))}`)
    .send(bytes);
}
export function registerFiles(app:FastifyInstance,db:Store,storage:StorageAdapter=new CosStorage()){
  stores.set(db,storage);
  app.get('/api/status',async req=>{requireUser(req);return {cosConfigured:storage.configured}});
  app.post('/api/files/upload',async req=>{
    const u=currentUser(db,requireUser(req),req),v=parse(z.object({name:z.string().trim().min(1).max(180).refine(s=>!/[\\/\x00-\x1f]/.test(s),'文件名无效'),size:z.number().int().positive().max(20*1024*1024),mime:z.string().max(200).default(''),purpose:z.enum(['task-attachment','submission','resource','receipt','avatar','class-photo']),entityId:z.string().optional(),context:z.string().max(100).optional()}),req.body);
    const context=uploadAccess(db,u,v.purpose,v.entityId,v.context),ext=extname(v.name).toLowerCase(),mime=types[ext];
    if(!mime)throw new HttpError(400,'不支持此文件类型');
    if(v.purpose==='avatar'&&(v.size>maxAvatarSize||!avatarTypes.has(mime)))throw new HttpError(400,'头像仅支持不超过 5 MiB 的 JPG、PNG、WebP 或 GIF 图片');
    const s=neededStorage(db);
    if(['avatar','class-photo'].includes(v.purpose)&&!mime.startsWith('image/'))throw new HttpError(400,'请选择图片');
    const id=uid(),key=`classroom/${v.purpose}/${uid()}${ext}`,signed=await s.uploadUrl(key,mime,v.size);
    return db.transaction(()=>{
      const current=currentUser(db,u,req);
      uploadAccess(db,current,v.purpose,v.entityId,context);
      db.run('INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,v.name,v.size,mime,key,v.purpose,v.entityId??null,u.id,'pending',context?JSON.stringify({context}):null,now(),new Date(Date.now()+86400000+600000).toISOString());
      return{fileId:id,...signed};
    });
  });
  app.post<{Params:{id:string}}>('/api/files/:id/confirm',async req=>{
    const u=currentUser(db,requireUser(req),req),f=db.get('SELECT * FROM files WHERE id=?',req.params.id);
    if(!f||f.owner_id!==u.id)throw new HttpError(404,'上传记录不存在');
    uploadAccess(db,u,f.purpose,f.entity_id,scopeContext(f));
    if(f.expires_at&&f.expires_at<now())throw new HttpError(400,'上传记录已过期');
    if(f.status==='ready')return metadata(f);
    if(f.status!=='pending')throw new HttpError(400,'上传记录已过期');
    const s=neededStorage(db),head=await s.head(f.object_key);
    if(head.size!==f.size||head.mime!==f.mime)throw new HttpError(400,'实际文件大小或类型与声明不符');
    if(!sniff(f,await s.readHead(f.object_key)))throw new HttpError(400,'文件内容与类型不符');
    return db.transaction(()=>{
      const current=currentUser(db,u,req),file=db.get('SELECT * FROM files WHERE id=?',f.id);
      if(!file||file.owner_id!==current.id)throw new HttpError(404,'上传记录不存在');
      sameFile(f,file);
      if(file.status!=='pending')throw new HttpError(409,'文件状态已改变，请重新上传');
      if(file.expires_at&&file.expires_at<now())throw new HttpError(400,'上传记录已过期');
      uploadAccess(db,current,file.purpose,file.entity_id,scopeContext(file));
      db.run("UPDATE files SET status='ready' WHERE id=? AND status='pending'",file.id);
      return metadata({...file,status:'ready'});
    });
  });
  app.get<{Params:{id:string}}>('/api/files/:id',async req=>{const u=currentUser(db,requireUser(req),req),f=readableFile(db,u,req.params.id);return metadata(f,f.purpose!=='receipt'||financeRead(u))});
  app.post<{Params:{id:string}}>('/api/files/:id/download',async req=>{
    const u=currentUser(db,requireUser(req),req),f=readableFile(db,u,req.params.id);
    const s=neededStorage(db),v=parse(z.object({preview:z.boolean().optional()}),req.body??{});
    const previewAvailable=previewable(f)&&f.size>0&&f.size<=maxPreviewSize&&!!s.read;
    const url=v.preview&&previewAvailable?`/api/files/${encodeURIComponent(f.id)}/preview`:await s.downloadUrl(f.object_key,f.name);
    readableFile(db,currentUser(db,u,req),f.id,f);
    return {url,previewAvailable};
  });
  app.get<{Params:{id:string}}>('/api/files/:id/preview',async(req,reply)=>{
    const u=currentUser(db,requireUser(req),req),f=readableFile(db,u,req.params.id);
    const bytes=await previewContent(db,f);
    const current=readableFile(db,currentUser(db,u,req),f.id,f);
    return sendPreview(reply,current,bytes);
  });
  app.get<{Params:{id:string}}>('/api/public/photo/:id',async(req,reply)=>{
    const f=db.get('SELECT * FROM files WHERE id=?',req.params.id);
    if(!f||f.purpose!=='class-photo'||!canReadFile(db,null,f)||!f.mime.startsWith('image/'))throw new HttpError(404,'图片不存在');
    const bytes=await previewContent(db,f),current=db.get('SELECT * FROM files WHERE id=?',f.id);
    if(!current||current.purpose!=='class-photo'||!canReadFile(db,null,current)||!current.mime.startsWith('image/'))throw new HttpError(404,'图片不存在');
    sameFile(f,current);
    return sendPreview(reply,current,bytes);
  });
}
export async function createExport(db:Store,user:User,filename:string,buffer:Buffer,mime:string,scope:ExportScope,sources:any[]=[],request?:FastifyRequest):Promise<{fileId:string}>{
  const s=neededStorage(db);currentExportUser(db,user,scope,sources,request);
  const id=uid(),key=`classroom/exports/${uid()}${extname(filename)}`;
  await s.put(key,buffer,mime);
  try {
    return db.transaction(()=>{
      currentExportUser(db,user,scope,sources,request);
      db.run('INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,filename,buffer.length,mime,key,'export',scope.id??null,user.id,'ready',JSON.stringify(scope),now(),new Date(Date.now()+86400000).toISOString());
      return{fileId:id};
    });
  } catch(error) {
    try {await s.remove(key);} catch {
      // Keep failed cleanup discoverable without making the object readable.
      db.run('INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,filename,buffer.length,mime,key,'export',scope.id??null,user.id,'cleaning',JSON.stringify(scope),now(),new Date(Date.now()-1).toISOString());
    }
    throw error;
  }
}
export async function cleanupFiles(db:Store,storage:StorageAdapter=new CosStorage()){
  if(!storage.configured)throw new HttpError(503,'COS 未配置');let count=0;
  const expired=db.all("SELECT * FROM files WHERE expires_at IS NOT NULL AND expires_at<? AND status IN ('pending','ready','cleaning')",now());
  for(const f of expired){const claimed=db.run("UPDATE files SET status='cleaning' WHERE id=? AND expires_at<? AND status IN ('pending','ready','cleaning')",f.id,now());if(!claimed.changes)continue;await storage.remove(f.object_key);db.run('DELETE FROM files WHERE id=? AND status=?',f.id,'cleaning');count++}return count;
}
function zipComponent(value: string) {
  const cleaned = value.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').replace(/[. ]+$/g, '');
  return cleaned || '附件';
}
export async function createBundle(db:Store,user:User,ids:string[],name:string,scope:ExportScope,request?:FastifyRequest){
  const s=neededStorage(db),current=currentExportUser(db,user,scope,[],request),rows=[...new Set(ids)].map(id=>readableFile(db,current,id));
  if(rows.reduce((sum,f)=>sum+f.size,0)>100*1024*1024)throw new HttpError(400,'本次附件超过100MiB，请按学生分批下载');
  const zip=new JSZip();for(const [i,f] of rows.entries()){let bytes:Buffer;if(s.read)bytes=await s.read(f.object_key);else{const res=await fetch(await s.downloadUrl(f.object_key,f.name));if(!res.ok)throw new HttpError(502,'文件读取失败');bytes=Buffer.from(await res.arrayBuffer())}currentExportUser(db,user,scope,rows,request);if(bytes.length!==f.size)throw new HttpError(502,'文件大小发生变化');const owner=db.get('SELECT name FROM users WHERE id=?',f.owner_id)?.name??'附件';zip.file(`${zipComponent(owner)}/${i+1}-${zipComponent(f.name)}`,bytes)}
  return createExport(db,user,`${zipComponent(name)}.zip`,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),'application/zip',scope,rows,request);
}
