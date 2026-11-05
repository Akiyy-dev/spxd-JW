import {loadEnvFile} from 'node:process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import staticPlugin from '@fastify/static';
import {createStore} from './db.ts';
import {buildApp} from './app.ts';
if(existsSync('.env'))loadEnvFile('.env');
if(process.env.NODE_ENV==='production'&&!/^https:\/\//.test(process.env.APP_ORIGIN??''))throw new Error('正式环境需要配置 HTTPS APP_ORIGIN');
const db=createStore(process.env.DATABASE_PATH??'./data/classroom.sqlite');
const app=await buildApp({db,logger:true});
if(existsSync('dist/index.html')){
  await app.register(staticPlugin,{root:resolve('dist'),prefix:'/'});
  app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({message:'接口不存在'}):reply.sendFile('index.html'));
}
app.addHook('onClose',async()=>db.close());
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0))});
await app.listen({port:Number(process.env.PORT??3001),host:process.env.HOST??'127.0.0.1'});
