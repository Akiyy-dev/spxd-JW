import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {User,Resource,Member} from '../src/types.ts';
import type {Permission} from '../shared/permissions.ts';

// Node does not render CSS; component logic and markup remain the real modules.
registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'export default ""',shortCircuit:true}:next(url,context);}});
const {Resources,ResourceCard,MemberEditButton}=await import('../src/catalog.tsx');
const user=(permissions:Permission[]=[]):User=>({id:'a',username:'a',name:'a',role:'admin',permissions,inClass:false,financeManage:false,mustChangePassword:false,active:true,version:1});
const item:Resource={id:'r',title:'资料',description:'',category:'学习资料',url:'',attachments:[],pinned:false,status:'published',version:1,updatedAt:'2026-11-09',authorName:'老师'};
const noop=()=>{};

test('resources navigation exposes only authorized create, draft and archived entries',()=>{
  const empty=renderToStaticMarkup(createElement(Resources,{user:user()}));
  assert.doesNotMatch(empty,/添加资料|value="draft"|value="archived"/);
  const creator=renderToStaticMarkup(createElement(Resources,{user:user(['resources.create'])}));
  assert.match(creator,/添加资料/);assert.doesNotMatch(creator,/value="draft"|value="archived"/);
  const reader=renderToStaticMarkup(createElement(Resources,{user:user(['resources.drafts.read','resources.archived.read'])}));
  assert.match(reader,/value="draft"/);assert.match(reader,/value="archived"/);assert.doesNotMatch(reader,/添加资料/);
});

test('resource cards keep status operations independent and published edits require publish',()=>{
  const render=(permissions:Permission[],status:Resource['status']='published')=>renderToStaticMarkup(createElement(ResourceCard,{user:user(permissions),item:{...item,status},edit:noop,history:noop,changeStatus:noop}));
  assert.doesNotMatch(render(['resources.drafts.read','resources.edit']),/>编辑</);
  const archiver=render(['resources.archive']);assert.match(archiver,/>归档</);assert.doesNotMatch(archiver,/>编辑<|>历史版本</);
  const publisher=render(['resources.drafts.read','resources.publish'],'draft');assert.match(publisher,/>发布</);assert.doesNotMatch(publisher,/>编辑</);
  const editor=render(['resources.drafts.read','resources.edit','resources.publish']);assert.match(editor,/>编辑</);
  assert.match(render(['resources.history.read']),/>历史版本</);
});

test('member edit controls require member grant and protect elevated accounts from ordinary administrators',()=>{
  const member:Member={id:'b',name:'同学',role:'student',position:'',avatarFileId:null};
  const render=(actor:User,role:Member['role'])=>renderToStaticMarkup(createElement(MemberEditButton,{user:actor,member:{...member,role},edit:noop}));
  assert.equal(render(user(),'student'),'');
  const manager=user(['class.members.edit']);assert.match(render(manager,'student'),/编辑/);assert.match(render(manager,'committee'),/编辑/);
  assert.equal(render(manager,'admin'),'');assert.equal(render(manager,'super_admin'),'');
  assert.match(render({...manager,role:'super_admin'},'admin'),/编辑/);
});
