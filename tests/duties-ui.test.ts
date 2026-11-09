import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {User} from '../src/types.ts';
import type {Permission,Role} from '../shared/permissions.ts';

registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'export default ""',shortCircuit:true}:next(url,context);}});
const {DutiesSchedule,DutyEditor,serializeDutyDrafts}=await import('../src/duties.tsx');
const user=(role:Role='student',permissions:Permission[]=[]):User=>({id:'u',username:'u',name:'同学',role,permissions,inClass:true,financeManage:false,mustChangePassword:false,active:true,version:1});
const noop=()=>{};

test('weekly schedule keeps all seven days and explicitly displays empty days',()=>{
  const html=renderToStaticMarkup(createElement(DutiesSchedule,{user:user(),data:{duties:[],version:1},edit:noop}));
  assert.deepEqual([...html.matchAll(/<h2>(周[一二三四五六日])<\/h2>/g)].map(match=>match[1]),['周一','周二','周三','周四','周五','周六','周日']);
  assert.equal((html.match(/暂无值日安排/g)||[]).length,7);
  assert.match(html,/每周重复/);
});

test('weekly schedule groups multiple areas by weekday and puts Sunday last regardless of input order',()=>{
  const html=renderToStaticMarkup(createElement(DutiesSchedule,{user:user(),edit:noop,data:{version:1,duties:[
    {id:'sun',weekday:7,area:'周日走廊',names:['王同学']},
    {id:'mon-a',weekday:1,area:'周一教室',names:['张同学','李同学']},
    {id:'mon-b',weekday:1,area:'周一黑板',names:['赵同学']},
  ]}}));
  assert.ok(html.indexOf('周一教室')<html.indexOf('周一黑板'));
  assert.ok(html.indexOf('周一黑板')<html.indexOf('<h2>周二</h2>'));
  assert.ok(html.indexOf('<h2>周日</h2>')<html.indexOf('周日走廊'));
  assert.match(html,/张同学/);assert.match(html,/李同学/);
  assert.equal((html.match(/暂无值日安排/g)||[]).length,5);
});

test('weekly schedule exposes editing only to Admin, committee, and granted administrators',()=>{
  const render=(actor:User)=>renderToStaticMarkup(createElement(DutiesSchedule,{user:actor,data:{duties:[],version:1},edit:noop}));
  for(const actor of [user(),user('admin'),user('admin',['class.settings.edit'])]){
    assert.doesNotMatch(render(actor),/编辑安排|添加区域/);
  }
  for(const actor of [user('super_admin'),user('committee'),user('admin',['class.duties.edit'])]){
    const html=render(actor);
    assert.match(html,/编辑安排/);
    assert.equal((html.match(/>添加区域<\/button>/g)||[]).length,7);
  }
});

test('weekly duty editor uses weekday choices and keeps existing rows without calendar dates',()=>{
  const html=renderToStaticMarkup(createElement(DutyEditor,{data:{version:4,duties:[{id:'d',weekday:7,area:'图书角',names:['张同学','李同学']}]},close:noop,saved:noop}));
  assert.match(html,/<select[^>]*name="weekday-d"/);
  assert.deepEqual([...html.matchAll(/<option value="([1-7])"/g)].map(match=>Number(match[1])),[1,2,3,4,5,6,7]);
  assert.match(html,/<option value="7" selected="">周日<\/option>/);
  assert.match(html,/图书角/);assert.match(html,/张同学、李同学/);
  assert.doesNotMatch(html,/type="date"/);
});

test('adding from a weekday initializes the new row on that day while keeping existing rows',()=>{
  const html=renderToStaticMarkup(createElement(DutyEditor,{data:{version:2,duties:[{id:'existing',weekday:1,area:'教室',names:['小王']}]},initialWeekday:6,close:noop,saved:noop}));
  assert.equal((html.match(/<select /g)||[]).length,2);
  assert.match(html,/<option value="6" selected="">周六<\/option>/);
  assert.match(html,/教室/);
});

test('adding a weekly duty works on HTTP pages where crypto.randomUUID is unavailable',()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis.crypto,'randomUUID');
  Object.defineProperty(globalThis.crypto,'randomUUID',{value:undefined,configurable:true});
  try {
    const html=renderToStaticMarkup(createElement(DutyEditor,{data:{version:1,duties:[]},initialWeekday:3,close:noop,saved:noop}));
    assert.match(html,/<option value="3" selected="">周三<\/option>/);
  } finally {
    if(descriptor)Object.defineProperty(globalThis.crypto,'randomUUID',descriptor);
    else Reflect.deleteProperty(globalThis.crypto,'randomUUID');
  }
});

test('editor preserves row identities while trimming areas and splitting manually entered names',()=>{
  assert.deepEqual(serializeDutyDrafts([
    {id:'a',weekday:1,area:' 教室 ',names:' 张同学, 李同学，王同学、赵同学 '},
    {id:'b',weekday:7,area:'黑板',names:''},
  ]),[
    {id:'a',weekday:1,area:'教室',names:['张同学','李同学','王同学','赵同学']},
    {id:'b',weekday:7,area:'黑板',names:[]},
  ]);
});

test('editor rejects whitespace-only areas, too many names, and oversized names before saving',()=>{
  assert.throws(()=>serializeDutyDrafts([{id:'a',weekday:1,area:'  ',names:'同学'}]),/区域/);
  assert.throws(()=>serializeDutyDrafts([{id:'a',weekday:1,area:'区'.repeat(101),names:''}]),/区域.*100/);
  assert.throws(()=>serializeDutyDrafts(Array.from({length:1001},(_,index)=>({id:String(index),weekday:1,area:'教室',names:''}))),/1000/);
  assert.throws(()=>serializeDutyDrafts([{id:'a',weekday:1,area:'教室',names:Array.from({length:101},()=> '同学').join('、')}]),/100/);
  assert.throws(()=>serializeDutyDrafts([{id:'a',weekday:1,area:'教室',names:'张'.repeat(101)}]),/100/);
});
