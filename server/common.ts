import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {can, type Permission, type Role} from '../shared/permissions.ts';
export interface User { id:string; username:string; name:string; role:Role; permissions?:Permission[]; financeManage:boolean; inClass:boolean; avatarFileId?:string|null; mustChangePassword:boolean; active:boolean; version:number }
declare module 'fastify' { interface FastifyRequest { user: User | null } }
export class HttpError extends Error { constructor(public statusCode:number, message:string) { super(message); } }
export function requireUser(req: FastifyRequest): User { if (!req.user) throw new HttpError(401,'请先登录'); if(req.user.mustChangePassword) throw new HttpError(403,'请先修改初始密码'); return req.user; }
export function requirePermission(req:FastifyRequest,permission:Permission):User { const u=requireUser(req);if(!can(u,permission))throw new HttpError(403,'没有执行此操作的权限');return u; }
export const uid=()=>randomUUID();
export const now=()=>new Date().toISOString();
export function parse<T>(schema:z.ZodType<T>,input:unknown):T { const r=schema.safeParse(input); if(!r.success) throw new HttpError(400,r.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；')); return r.data; }
export function json<T>(value:unknown,fallback:T):T { try { return typeof value==='string'?JSON.parse(value):fallback; } catch { return fallback; } }
export function shanghaiDate(date=new Date()):string { return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date); }
export const dateSchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!Number.isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s,'日期无效');
export const versionSchema=z.number().int().positive();
export function conflict(current:number,given:number) { if(current!==given) throw new HttpError(409,'内容已被修改，请刷新后重试'); }
