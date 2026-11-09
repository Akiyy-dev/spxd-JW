import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {DUTY_LIMITS, type DutiesData, type Weekday} from '../shared/duties.ts';
import {conflict, parse, requirePermission, requireUser, versionSchema} from './common.ts';
import type {Store} from './db.ts';

const dutySchema=z.object({
  id:z.string().trim().min(1).max(DUTY_LIMITS.id),
  weekday:z.number().int().min(1).max(7).transform(value=>value as Weekday),
  area:z.string().trim().min(1).max(DUTY_LIMITS.area),
  names:z.array(z.string().trim().min(1).max(DUTY_LIMITS.name)).max(DUTY_LIMITS.names),
}).strict();
const updateSchema=z.object({
  duties:z.array(dutySchema).max(DUTY_LIMITS.rows).refine(rows=>new Set(rows.map(row=>row.id)).size===rows.length,'值日记录 ID 不能重复'),
  version:versionSchema,
}).strict();

function readDuties(db:Store):DutiesData {
  return db.setting<DutiesData>('weekly_duties',{duties:[],version:1});
}

export function registerDuties(app:FastifyInstance,db:Store) {
  app.get('/api/duties',async request=>{
    requireUser(request);
    return readDuties(db);
  });
  app.put('/api/duties',async request=>{
    const user=requirePermission(request,'class.duties.edit'), input=parse(updateSchema,request.body);
    return db.transaction(()=>{
      const current=readDuties(db);
      conflict(current.version,input.version);
      const next:DutiesData={duties:input.duties,version:current.version+1};
      db.setSetting('weekly_duties',next);
      db.audit(user.id,'duties.update','weekly_duties',{from:current.version,version:next.version});
      return next;
    });
  });
}
