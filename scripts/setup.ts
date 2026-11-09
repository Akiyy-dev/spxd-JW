import {existsSync} from 'node:fs';import {loadEnvFile} from 'node:process';import {randomBytes} from 'node:crypto';import {createInterface} from 'node:readline/promises';
import {createStore} from '../server/db.ts';import {createUser} from '../server/auth.ts';
if(existsSync('.env'))loadEnvFile('.env');
const db=createStore(process.env.DATABASE_PATH??'./data/classroom.sqlite');
if(db.get("SELECT id FROM users WHERE role IN ('super_admin','admin')")){console.error('管理员已存在；请使用 admin:promote 完成首次升级，或由现有 Admin 创建账号。');db.close();process.exit(1)}
const rl=createInterface({input:process.stdin,output:process.stdout});
const username=process.env.ADMIN_USERNAME??await rl.question('Admin 登录账号：');
const name=process.env.ADMIN_NAME??await rl.question('Admin 显示名称：');
const password=process.env.ADMIN_PASSWORD??randomBytes(15).toString('base64url');
try{createUser(db,{username,name,role:'super_admin',password});console.log('Admin 已创建，首次登录需要修改密码。');if(!process.env.ADMIN_PASSWORD)console.log(`本次初始密码（仅显示一次）：${password}`)}finally{rl.close();db.close()}
