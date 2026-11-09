import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import Fastify from 'fastify';
import {createStore} from '../server/db.ts';
import {registerCatalog} from '../server/catalog.ts';
import type {User} from '../server/common.ts';

async function fixture(t:TestContext, permissions:string[]=[]){
  const db=createStore(),app=Fastify();
  const user={id:'manager',username:'manager',name:'管理员',role:'admin',inClass:false,financeManage:false,active:true,mustChangePassword:false,version:1,permissions} as User;
  for(const id of ['manager','protected'])db.run('INSERT INTO users(id,username,name,password_hash,role,created_at,must_change_password) VALUES(?,?,?,?,?,?,0)',id,id,id,'hash','admin','2026-11-09');
  app.decorateRequest('user',null);app.addHook('onRequest',async req=>{db.run('UPDATE users SET permissions=? WHERE id=?',JSON.stringify(user.permissions),'manager');req.user=user});
  app.setErrorHandler((e:any,_req,reply)=>reply.code(e.statusCode??500).send({message:e.message}));
  registerCatalog(app,db);t.after(async()=>{await app.close();db.close()});
  function seed(status:string){db.run('INSERT INTO resources(id,title,description,category,url,attachments,pinned,status,version,author_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',status,status,'','资料','','[]',0,status,1,'manager','2026-11-09','2026-11-09')}
  return {db,app,user,seed};
}

test('an administrator with no grants sees only published resources and cannot mutate the class',async t=>{
  const {app,seed}=await fixture(t);for(const status of ['draft','published','archived'])seed(status);
  assert.deepEqual((await app.inject({url:'/api/resources'})).json().map((x:any)=>x.id),['published']);
  assert.equal((await app.inject({method:'POST',url:'/api/resources',payload:{title:'不允许'}})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:'/api/class',payload:{version:1,config:{name:'不允许'}}})).statusCode,403);
});

test('resource creation and editing cannot publish without publish permission',async t=>{
  const {app,db,seed}=await fixture(t,['resources.drafts.read','resources.create','resources.edit']);seed('published');
  const draft=await app.inject({method:'POST',url:'/api/resources',payload:{title:'草稿',status:'draft'}});
  assert.equal(draft.statusCode,200,draft.body);assert.equal(draft.json().status,'draft');
  assert.equal((await app.inject({method:'POST',url:'/api/resources',payload:{title:'越权发布',status:'published'}})).statusCode,403);
  assert.equal((await app.inject({method:'PUT',url:'/api/resources/published',payload:{version:1,changes:{title:'修改公开内容'}}})).statusCode,403);
  assert.equal(db.get('SELECT title FROM resources WHERE id=?','published').title,'published');
});

test('class updates check every section atomically and protect elevated accounts',async t=>{
  const {app,db,user}=await fixture(t,['class.settings.edit']);
  assert.equal((await app.inject({method:'PUT',url:'/api/class',payload:{version:1,config:{name:'不应部分保存'},duties:[]}})).statusCode,403);
  assert.equal(db.setting<any>('class',{}).name,undefined);
  user.permissions=['class.members.edit'];
  assert.equal((await app.inject({method:'PUT',url:'/api/class',payload:{version:1,members:[{id:'protected',displayName:'接管'}]}})).statusCode,403);
  assert.equal(db.get('SELECT profile FROM users WHERE id=?','protected').profile,'{}');
});

test('resource history obeys current and historical visibility grants',async t=>{
  const {app,db,user,seed}=await fixture(t,['resources.history.read']);seed('published');seed('draft');
  for(const id of ['published','draft'])for(const [i,status] of ['draft','published','archived'].entries())db.run('INSERT INTO resource_versions VALUES(?,?,?,?,?)',id+i,id,JSON.stringify({id,title:'secret-'+status,status}),i+1,'2026-11-09');
  assert.equal((await app.inject({url:'/api/resources/draft/history'})).statusCode,403);
  const history=await app.inject({url:'/api/resources/published/history'});
  assert.deepEqual(history.json().map((v:any)=>v.title),['secret-published']);
  user.permissions!.push('resources.drafts.read');
  assert.deepEqual((await app.inject({url:'/api/resources/draft/history'})).json().map((v:any)=>v.title),['secret-published','secret-draft']);
});

test('archiving a published resource cannot bundle an unauthorized content edit',async t=>{
  const {app,db,seed}=await fixture(t,['resources.drafts.read','resources.edit','resources.archive']);seed('published');
  const update=await app.inject({method:'PUT',url:'/api/resources/published',payload:{version:1,changes:{status:'archived',title:'changed'}}});
  assert.equal(update.statusCode,403);
  assert.equal(db.get('SELECT title FROM resources WHERE id=?','published').title,'published');
  assert.equal((await app.inject({method:'PUT',url:'/api/resources/published',payload:{version:1,changes:{status:'archived'}}})).statusCode,200);
});

test('status-only publication retains non-default content without requiring edit permission',async t=>{
  const {app,db,seed}=await fixture(t,['resources.drafts.read','resources.publish']);seed('draft');
  db.run('UPDATE resources SET description=?,category=?,url=?,pinned=1 WHERE id=?','课程说明','参考材料','https://example.com/course','draft');
  const response=await app.inject({method:'PUT',url:'/api/resources/draft',payload:{version:1,changes:{status:'published'}}});
  assert.equal(response.statusCode,200,response.body);
  const item=response.json();assert.equal(item.status,'published');assert.equal(item.title,'draft');assert.equal(item.description,'课程说明');assert.equal(item.category,'参考材料');assert.equal(item.url,'https://example.com/course');assert.equal(item.pinned,true);
});
