export type Role = 'super_admin' | 'admin' | 'committee' | 'student';
type TaskOperation = 'drafts.read'|'create'|'edit'|'publish'|'withdraw'|'archive'|'participants.read'|'participants.manage'|'submissions.read'|'export'|'exportFiles';
export type Permission = `${'homework'|'affairs'}.${TaskOperation}`
  | `timetable.${'templates.read'|'templates.create'|'templates.edit'|'templates.apply'|'current.edit'|'exceptions.write'|'exceptions.remove'}`
  | `resources.${'drafts.read'|'archived.read'|'history.read'|'create'|'edit'|'publish'|'archive'}`
  | `finance.${'read'|'history'|'entries.create'|'entries.edit'|'entries.void'|'fees.create'|'fees.edit'|'payments.create'|'payments.edit'|'payments.void'|'export'}`
  | `class.${'settings.edit'|'members.edit'|'duties.edit'}`
  | `accounts.${'read'|'create'|'edit'|'roles'|'status'|'resetPassword'}`;
export interface PermissionUser {role:Role; permissions?:Permission[]; financeManage?:boolean; inClass?:boolean}
type Definition = {key:Permission;group:string;label:string;requires:readonly Permission[]};
const item=(key:Permission,group:string,label:string,requires:readonly Permission[]=[]):Definition=>({key,group,label,requires});
const taskOperations:readonly [TaskOperation,string][] = [
  ['drafts.read','查看草稿'],['create','创建'],['edit','编辑内容'],['publish','发布 / 恢复发布'],['withdraw','撤回'],['archive','归档'],
  ['participants.read','查看参与名单'],['participants.manage','调整参与名单'],['submissions.read','查看全班提交'],['export','导出表格'],['exportFiles','打包提交附件'],
];
export const PERMISSIONS:readonly Definition[] = [
  ...(['homework','affairs'] as const).flatMap(kind=>taskOperations.map(([operation,label])=>item(`${kind}.${operation}`,kind==='homework'?'作业公告':'事务办理',label,
    operation==='edit'||operation==='publish'?[`${kind}.drafts.read`]:operation==='participants.manage'?[`${kind}.participants.read`]:operation==='export'?[`${kind}.submissions.read`,`${kind}.participants.read`]:operation==='exportFiles'?[`${kind}.submissions.read`]:[]))),
  item('timetable.templates.read','课程表','查看模板'),
  item('timetable.templates.create','课程表','新建备用模板'),
  item('timetable.templates.edit','课程表','编辑备用模板',['timetable.templates.read']),
  item('timetable.templates.apply','课程表','应用模板',['timetable.templates.read']),
  item('timetable.current.edit','课程表','编辑当前课表'),
  item('timetable.exceptions.write','课程表','新增 / 修改临时调整'),
  item('timetable.exceptions.remove','课程表','移除临时调整'),
  item('resources.drafts.read','资料中心','查看草稿'),
  item('resources.archived.read','资料中心','查看归档'),
  item('resources.history.read','资料中心','查看历史版本'),
  item('resources.create','资料中心','新增'),
  item('resources.edit','资料中心','编辑',['resources.drafts.read']),
  item('resources.publish','资料中心','发布 / 恢复发布',['resources.drafts.read']),
  item('resources.archive','资料中心','归档'),
  item('finance.read','班费','查看完整明细'),
  ...([['history','查看修订历史'],['entries.create','新增账目'],['entries.edit','修订账目'],['entries.void','作废账目'],['fees.create','新增缴费事项'],['fees.edit','编辑缴费事项'],['payments.create','新增实缴'],['payments.edit','修订实缴'],['payments.void','作废实缴'],['export','导出']] as const).map(([operation,label])=>item(`finance.${operation}`,'班费',label,['finance.read'])),
  item('class.settings.edit','班级信息','修改班级设置 / 简介 / 照片'),
  item('class.members.edit','班级信息','维护成员展示资料 / 头像'),
  item('class.duties.edit','班级信息','维护值日安排'),
  item('accounts.read','成员账号','查看班委和学生账号'),
  ...([['create','创建账号（含批量）'],['edit','编辑基本资料'],['roles','调整班委 / 学生身份'],['status','启用 / 停用'],['resetPassword','重置密码']] as const).map(([operation,label])=>item(`accounts.${operation}`,'成员账号',label,['accounts.read'])),
];
export const PERMISSION_KEYS:Permission[] = PERMISSIONS.map(p=>p.key);
const definitions=new Map(PERMISSIONS.map(p=>[p.key,p]));
const committeePermissions=PERMISSION_KEYS.filter(p=>!p.startsWith('accounts.')&&!p.startsWith('finance.'));
function grants(user:PermissionUser):ReadonlySet<Permission> {
  if(user.role==='super_admin')return new Set(PERMISSION_KEYS);
  if(user.role==='committee')return new Set([...committeePermissions,...(user.financeManage?PERMISSION_KEYS.filter(p=>p.startsWith('finance.')):[])]);
  return new Set(user.role==='admin'&&Array.isArray(user.permissions)?user.permissions:[]);
}
export function can(user:PermissionUser|null|undefined,permission:Permission):boolean {
  if(!user)return false;
  const held=grants(user);
  const check=(key:Permission):boolean=>held.has(key)&&!!definitions.get(key)&&definitions.get(key)!.requires.every(check);
  return check(permission);
}
export function effectivePermissions(user:PermissionUser):Permission[] {return PERMISSION_KEYS.filter(p=>can(user,p));}
export function validatePermissions(input:unknown):Permission[] {
  if(!Array.isArray(input)||input.some(p=>typeof p!=='string'||!definitions.has(p as Permission)))throw new Error('权限列表含有无效权限');
  if(new Set(input).size!==input.length)throw new Error('权限列表含有重复权限');
  const permissions=input as Permission[];
  if(permissions.some(p=>!can({role:'admin',permissions},p)))throw new Error('权限列表缺少必要的读取权限');
  return [...permissions];
}
export function addPermission(list:Permission[],permission:Permission):Permission[] {
  const result=new Set(list);
  const add=(key:Permission)=>{const definition=definitions.get(key);if(!definition)throw new Error('无效权限');definition.requires.forEach(add);result.add(key);};
  add(permission);return PERMISSION_KEYS.filter(p=>result.has(p));
}
export function removePermission(list:Permission[],permission:Permission):Permission[] {
  const result=list.filter(p=>p!==permission);
  return result.filter(p=>can({role:'admin',permissions:result},p));
}
export function isClassMember(user:PermissionUser):boolean {return user.role==='student'||user.role==='committee'||Boolean(user.inClass);}
