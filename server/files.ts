import type {FastifyInstance,FastifyReply} from 'fastify';
import type {Store} from './db.ts';
import type {User} from './common.ts';
import {canManageFinance,HttpError,json,now,parse,requireUser,uid} from './common.ts';
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
const types:Record<string,string>={'.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.txt':'text/plain','.csv':'text/csv','.zip':'application/zip','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation'};
const previewTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const maxPreviewSize = 20 * 1024 * 1024;
function previewable(f: any) {
  return previewTypes.has(f.mime) && types[extname(f.name).toLowerCase()] === f.mime;
}
const isManager=(u:User)=>u.role==='admin'||u.role==='committee';
const financeRead=canManageFinance;
function uploadAccess(db:Store,u:User,purpose:string,entityId?:string|null){
  if(purpose==='receipt'){if(!canManageFinance(u))throw new HttpError(403,'仅管理员或指定班委可上传班费凭证');return}
  if(purpose==='submission'){const task=db.get('SELECT * FROM tasks WHERE id=?',entityId??'');if(!task||task.status!=='published'||!task.requires_submission)throw new HttpError(400,'作业或事务当前不可提交');if(u.role==='admin'||!db.get("SELECT 1 FROM participants WHERE task_id=? AND user_id=? AND status='required'",task.id,u.id))throw new HttpError(403,'你不在本次提交名单中');if(task.deadline&&task.deadline<now()&&!task.allow_late)throw new HttpError(400,'已超过提交截止时间');return}
  if(!isManager(u))throw new HttpError(403,'仅管理员或班委可以上传该资料');
  if(purpose==='task-attachment'&&entityId&&!db.get('SELECT id FROM tasks WHERE id=?',entityId))throw new HttpError(404,'作业不存在');
  if(purpose==='resource'&&entityId&&!db.get('SELECT id FROM resources WHERE id=?',entityId))throw new HttpError(404,'资料不存在');
}
function hasId(raw:unknown,id:string){return json<string[]>(raw,[]).includes(id)}
export function canReadFile(db:Store,u:User|null,f:any):boolean {
  if(f.status!=='ready'||(f.expires_at&&f.expires_at<now()))return false;
  const config=db.setting<any>('class',{});
  if(f.purpose==='class-photo'&&config.photoFileId===f.id)return true;
  if(!u||u.mustChangePassword)return false;
  if(f.purpose==='export'){const s=json<any>(f.scope,{});return f.owner_id===u.id&&(s.kind==='finance'?financeRead(u):isManager(u))}
  if(f.purpose==='receipt'){
    const entry = db.get('SELECT * FROM finance_entries WHERE id=? OR payment_id=?', f.entity_id, f.entity_id);
    const auditor = financeRead(u);
    if (!entry) return !f.entity_id && f.owner_id === u.id && auditor;
    if (hasId(entry.receipt_ids, f.id)) return auditor || (!entry.voided && !!entry.public_receipt);
    if (!auditor) return false;
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
  if(f.purpose==='submission'){return f.owner_id===u.id||isManager(u)&&db.all('SELECT attachments FROM submissions WHERE task_id=?',f.entity_id).some(r=>hasId(r.attachments,f.id))}
  if(f.purpose==='resource'){const r=db.get('SELECT * FROM resources WHERE id=?',f.entity_id);if(!r)return !f.entity_id&&f.owner_id===u.id&&isManager(u);return (isManager(u)||r.status==='published'&&hasId(r.attachments,f.id))}
  if(f.purpose==='task-attachment'){const t=db.get('SELECT * FROM tasks WHERE id=?',f.entity_id);if(!t)return !f.entity_id&&f.owner_id===u.id&&isManager(u);return isManager(u)||['published','archived'].includes(t.status)&&hasId(t.attachments,f.id)}
  if(f.purpose==='avatar'){const m=db.get('SELECT profile FROM users WHERE id=? AND active=1',f.entity_id);return !!m&&json<any>(m.profile,{}).avatarFileId===f.id||!f.entity_id&&f.owner_id===u.id&&isManager(u)}
  return !f.entity_id&&f.owner_id===u.id&&isManager(u);
}
function metadata(f: any, includeOwnership = true) {
  return { id: f.id, name: f.name, size: f.size, mime: f.mime, status: f.status, purpose: f.purpose,
    ...(includeOwnership && { entityId: f.entity_id, ownerId: f.owner_id }), createdAt: f.created_at };
}
function neededStorage(db:Store){const s=stores.get(db);if(!s?.configured)throw new HttpError(503,'尚未配置腾讯云 COS，请管理员完成存储配置后再上传或导出');return s;}
export function validateAttachments(db:Store,user:User,ids:string[],purpose:string,entityId?:string){
  if(ids.length>5||new Set(ids).size!==ids.length)throw new HttpError(400,'每次最多5个不同附件');
  for(const id of ids){const f=db.get('SELECT * FROM files WHERE id=?',id);if(!f||f.status!=='ready'||f.purpose!==purpose||(f.expires_at&&f.expires_at<now()))throw new HttpError(400,'附件尚未完成上传或用途不匹配');if(f.entity_id&&f.entity_id!==entityId)throw new HttpError(403,'附件属于其他记录');if(f.owner_id!==user.id&&!(isManager(user)&&f.entity_id===entityId&&purpose!=='submission'))throw new HttpError(403,'不能使用其他人的附件');uploadAccess(db,user,purpose,entityId)}
}
export function bindAttachments(db:Store,ids:string[],entityId:string){for(const id of ids)db.run('UPDATE files SET entity_id=?,expires_at=NULL WHERE id=?',entityId,id);}
function sniff(f:any,b:Buffer){const ext=extname(f.name).toLowerCase();if(ext==='.pdf')return b.subarray(0,5).toString()==='%PDF-';if(ext==='.png')return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));if(['.jpg','.jpeg'].includes(ext))return b[0]===255&&b[1]===216;if(ext==='.webp')return b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP';if(['.zip','.docx','.xlsx','.pptx'].includes(ext))return b[0]===80&&b[1]===75;if(['.doc','.xls','.ppt'].includes(ext))return b.subarray(0,4).equals(Buffer.from([208,207,17,224]));return !b.includes(0);}
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
  app.post('/api/files/upload',async req=>{const u=requireUser(req),v=parse(z.object({name:z.string().trim().min(1).max(180).refine(s=>!/[\\/\x00-\x1f]/.test(s),'文件名无效'),size:z.number().int().positive().max(20*1024*1024),mime:z.string().max(200).default(''),purpose:z.enum(['task-attachment','submission','resource','receipt','avatar','class-photo']),entityId:z.string().optional()}),req.body);uploadAccess(db,u,v.purpose,v.entityId);const s=neededStorage(db),ext=extname(v.name).toLowerCase(),mime=types[ext];if(!mime)throw new HttpError(400,'不支持此文件类型');if(['avatar','class-photo'].includes(v.purpose)&&!mime.startsWith('image/'))throw new HttpError(400,'请选择图片');const id=uid(),key=`classroom/${v.purpose}/${uid()}${ext}`,signed=await s.uploadUrl(key,mime,v.size);db.run('INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,v.name,v.size,mime,key,v.purpose,v.entityId??null,u.id,'pending',now(),new Date(Date.now()+86400000+600000).toISOString());return{fileId:id,...signed}});
  app.post<{Params:{id:string}}>('/api/files/:id/confirm',async req=>{const u=requireUser(req),f=db.get('SELECT * FROM files WHERE id=?',req.params.id);if(!f||f.owner_id!==u.id)throw new HttpError(404,'上传记录不存在');uploadAccess(db,u,f.purpose,f.entity_id);if(f.status==='ready')return metadata(f);if(f.status!=='pending'||f.expires_at<now())throw new HttpError(400,'上传记录已过期');const s=neededStorage(db),head=await s.head(f.object_key);if(head.size!==f.size||head.mime!==f.mime)throw new HttpError(400,'实际文件大小或类型与声明不符');if(!sniff(f,await s.readHead(f.object_key)))throw new HttpError(400,'文件内容与类型不符');uploadAccess(db,u,f.purpose,f.entity_id);const result=db.run("UPDATE files SET status='ready' WHERE id=? AND status='pending'",f.id);if(!result.changes)throw new HttpError(409,'文件状态已改变，请重新上传');return metadata({...f,status:'ready'})});
  app.get<{Params:{id:string}}>('/api/files/:id',async req=>{const u=requireUser(req),f=db.get('SELECT * FROM files WHERE id=?',req.params.id);if(!f)throw new HttpError(404,'文件不存在');if(!canReadFile(db,u,f))throw new HttpError(403,'无权读取此文件');return metadata(f,f.purpose!=='receipt'||financeRead(u))});
  app.post<{Params:{id:string}}>('/api/files/:id/download',async req=>{
    const u=requireUser(req),f=db.get('SELECT * FROM files WHERE id=?',req.params.id);
    if(!f)throw new HttpError(404,'文件不存在');
    if(!canReadFile(db,u,f))throw new HttpError(403,'无权下载此文件');
    const s=neededStorage(db),v=parse(z.object({preview:z.boolean().optional()}),req.body??{});
    const previewAvailable=previewable(f)&&f.size>0&&f.size<=maxPreviewSize&&!!s.read;
    return {url:v.preview&&previewAvailable?`/api/files/${encodeURIComponent(f.id)}/preview`:await s.downloadUrl(f.object_key,f.name),previewAvailable};
  });
  app.get<{Params:{id:string}}>('/api/files/:id/preview',async(req,reply)=>{
    const u=requireUser(req),f=db.get('SELECT * FROM files WHERE id=?',req.params.id);
    if(!f)throw new HttpError(404,'文件不存在');
    if(!canReadFile(db,u,f))throw new HttpError(403,'无权预览此文件');
    return sendPreview(reply,f,await previewContent(db,f));
  });
  app.get<{Params:{id:string}}>('/api/public/photo/:id',async(req,reply)=>{
    const f=db.get('SELECT * FROM files WHERE id=?',req.params.id);
    if(!f||f.purpose!=='class-photo'||!canReadFile(db,null,f)||!f.mime.startsWith('image/'))throw new HttpError(404,'图片不存在');
    return sendPreview(reply,f,await previewContent(db,f));
  });
}
export async function createExport(db:Store,user:User,filename:string,buffer:Buffer,mime:string,scope:{kind:string,id?:string}):Promise<{fileId:string}>{
  const s=neededStorage(db);if(scope.kind==='finance'?!financeRead(user):!isManager(user))throw new HttpError(403,'无权导出');const id=uid(),key=`classroom/exports/${uid()}${extname(filename)}`;await s.put(key,buffer,mime);db.run('INSERT INTO files(id,name,size,mime,object_key,purpose,entity_id,owner_id,status,scope,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,filename,buffer.length,mime,key,'export',scope.id??null,user.id,'ready',JSON.stringify(scope),now(),new Date(Date.now()+86400000).toISOString());return{fileId:id};
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
export async function createBundle(db:Store,user:User,ids:string[],name:string,scope:{kind:string,id?:string}){
  const s=neededStorage(db);if(!isManager(user))throw new HttpError(403,'无权导出');const rows=[...new Set(ids)].map(id=>db.get('SELECT * FROM files WHERE id=?',id));
  if(rows.some(f=>!f||!canReadFile(db,user,f)))throw new HttpError(403,'存在不可访问的文件');
  if(rows.reduce((sum,f)=>sum+f.size,0)>100*1024*1024)throw new HttpError(400,'本次附件超过100MiB，请按学生分批下载');
  const zip=new JSZip();for(const [i,f] of rows.entries()){let bytes:Buffer;if(s.read)bytes=await s.read(f.object_key);else{const res=await fetch(await s.downloadUrl(f.object_key,f.name));if(!res.ok)throw new HttpError(502,'文件读取失败');bytes=Buffer.from(await res.arrayBuffer())}if(bytes.length!==f.size)throw new HttpError(502,'文件大小发生变化');const owner=db.get('SELECT name FROM users WHERE id=?',f.owner_id)?.name??'附件';zip.file(`${zipComponent(owner)}/${i+1}-${zipComponent(f.name)}`,bytes)}
  return createExport(db,user,`${zipComponent(name)}.zip`,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),'application/zip',scope);
}
