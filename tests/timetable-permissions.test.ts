import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import Fastify from 'fastify';
import {createStore} from '../server/db.ts';
import {registerTimetable} from '../server/timetable.ts';
import type {User} from '../server/common.ts';

async function fixture(t:TestContext){
  const db=createStore(),app=Fastify();
  const user={id:'m',username:'m',name:'管理员',role:'admin',inClass:false,financeManage:false,active:true,mustChangePassword:false,version:1,permissions:[]} as User;
  db.run('INSERT INTO users(id,username,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)','m','m','管理员','x','admin','2026-11-09');
  const data={name:'已应用',periods:[{id:1,label:'第1节',start:'08:00',end:'08:45'}],courses:[]};
  db.run('INSERT INTO timetable_templates VALUES(?,?,?,?,?)','active',null,JSON.stringify(data),1,'2026-11-09');
  db.run('INSERT INTO timetable_templates VALUES(?,?,?,?,?)','draft',null,JSON.stringify({...data,name:'备用'}),1,'2026-11-09');
  db.setSetting('timetable.selection',{templateId:'active',version:0});
  app.decorateRequest('user',null);app.addHook('onRequest',async req=>{req.user=user});
  app.setErrorHandler((e:any,_req,reply)=>reply.code(e.statusCode??500).send({message:e.message}));
  registerTimetable(app,db);t.after(async()=>{await app.close();db.close()});return{app,db,user,data};
}

test('template read, edit, apply and current edit are independent permissions',async t=>{
  const {app,db,user,data}=await fixture(t);
  assert.equal((await app.inject({url:'/api/public/timetable'})).statusCode,200);
  assert.equal((await app.inject({url:'/api/timetable/templates'})).statusCode,403);
  user.permissions=['timetable.templates.read','timetable.templates.edit'];
  assert.equal((await app.inject({url:'/api/timetable/templates'})).statusCode,200);
  const payload={...data,name:'新内容',version:1,selectionVersion:0};
  assert.equal((await app.inject({method:'PUT',url:'/api/timetable/templates/draft',payload})).statusCode,200);
  assert.equal((await app.inject({method:'PUT',url:'/api/timetable/templates/active',payload})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/timetable/templates/draft/apply',payload:{version:2,selectionVersion:0}})).statusCode,403);
  assert.equal(db.setting<any>('timetable.selection',{}).templateId,'active');
  user.permissions=['timetable.templates.read','timetable.current.edit'];
  assert.equal((await app.inject({method:'PUT',url:'/api/timetable',payload:{...payload,templateId:'active'}})).statusCode,200);
});
