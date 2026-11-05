import {existsSync} from 'node:fs';import {loadEnvFile} from 'node:process';import {createStore} from '../server/db.ts';import {cleanupFiles} from '../server/files.ts';
if(existsSync('.env'))loadEnvFile('.env');const db=createStore(process.env.DATABASE_PATH??'./data/classroom.sqlite');try{console.log(`已清理 ${await cleanupFiles(db)} 个过期文件`)}finally{db.close()}
