import {existsSync,mkdirSync} from 'node:fs';import {loadEnvFile} from 'node:process';import {resolve} from 'node:path';import {DatabaseSync} from 'node:sqlite';
if(existsSync('.env'))loadEnvFile('.env');
const source=process.env.DATABASE_PATH??'./data/classroom.sqlite';if(!existsSync(source))throw new Error('数据库尚未初始化');
mkdirSync('data/backups',{recursive:true});const target=resolve('data/backups',`classroom-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);const db=new DatabaseSync(source);try{db.prepare('VACUUM INTO ?').run(target);console.log(`一致性备份已生成：${target}`)}finally{db.close()}
