import {existsSync} from 'node:fs';
import {loadEnvFile} from 'node:process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createStore,type Store} from '../server/db.ts';

/** Maintenance-only first Admin bootstrap. Does not change password or profile. */
export function promoteAdmin(db:Store,username:string) {
  if(!username||username.trim()!==username)throw new Error('必须提供准确的现有登录账号');
  return db.transaction(()=>{
    const target=db.get('SELECT id,username,role,active FROM users WHERE username=?',username);
    if(!target||!target.active)throw new Error('指定账号必须已存在且启用');
    const roots=db.all("SELECT id FROM users WHERE role='super_admin'");
    if(roots.length===1&&roots[0].id===target.id)return {id:target.id,username,alreadyPromoted:true};
    if(roots.length)throw new Error('Admin 已初始化，请由现有 Admin 管理账号');
    if(target.role!=='admin')throw new Error('指定账号必须为现有管理员');
    db.run("UPDATE users SET role='super_admin',permissions='[]',version=version+1 WHERE id=?",target.id);
    db.run('DELETE FROM sessions WHERE user_id=?',target.id);
    db.audit(target.id,'user.bootstrap-admin',target.id,{username,before:'admin',after:'super_admin'});
    return {id:target.id,username,alreadyPromoted:false};
  });
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--username'||!args[1]) {
    console.error('用法：npm run admin:promote -- --username Akiyy');process.exitCode=1;
  } else {
    if(existsSync('.env'))loadEnvFile('.env');
    const db=createStore(process.env.DATABASE_PATH??'./data/classroom.sqlite');
    try {const result=promoteAdmin(db,args[1]);console.log(result.alreadyPromoted?'该账号已是首次指定的 Admin，未重复修改。':`已将 ${result.username} 提升为 Admin；密码和班级名单资格保持不变。`);}
    catch(error){console.error((error as Error).message);process.exitCode=1;}
    finally{db.close();}
  }
}
