import { useState, type Dispatch, type SetStateAction } from 'react'
import { KeyRound, Pencil, ShieldCheck, UserRoundPlus } from 'lucide-react'
import { api, useQuery } from './api'
import { Avatar } from './avatar'
import { roleNames, type Role, type User } from './types'
import { addPermission, can, effectivePermissions, PERMISSIONS, PERMISSION_KEYS, removePermission, type Permission } from '../shared/permissions'
import { AsyncForm, Badge, checked, Empty, Feedback, Field, Modal, PageTitle, Panel, val } from './ui'

const lines = (input: string) => input.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
const protectedRole = (role: Role) => role === 'admin' || role === 'super_admin'
const controlsTarget = (actor: User, target: Pick<User, 'role' | 'permissions' | 'financeManage'>) => actor.role === 'super_admin' || (!protectedRole(target.role) && effectivePermissions(target).every(permission => can(actor, permission)))

export function Accounts({user: actor, changed}: {user: User; changed: () => void}) {
  const users = useQuery<User[]>('/users')
  const [editor, setEditor] = useState<{action: 'new' | 'edit' | 'batch' | 'reset' | 'permissions'; user?: User}>()
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const results = users.data?.filter(user => `${user.username} ${user.name} ${roleNames[user.role]}`.toLowerCase().includes(query.trim().toLowerCase()))
  const close = () => setEditor(undefined)
  const saved = (message: string) => {close(); users.reload(); changed(); setNotice(message)}
  return <div className="stack">
    <PageTitle label="管理设置" title="账号与权限" detail={actor.role === 'super_admin' ? '管理成员账号，为每位管理员单独配置操作权限。' : '按已授权范围维护班委和学生账号。'} actions={can(actor, 'accounts.create') && <><button className="btn" onClick={() => setEditor({action: 'batch'})}>批量创建</button><button className="btn primary" onClick={() => setEditor({action: 'new'})}><UserRoundPlus size={18}/>创建账号</button></>}/>
    <Panel title="成员账号" actions={<input type="search" aria-label="搜索账号" placeholder="搜索姓名、用户名或身份" value={query} onChange={event => setQuery(event.target.value)}/>}>
      <Feedback {...users} retry={users.reload}/>
      {notice && <p className="feedback" role="status">{notice}</p>}
      {results && (results.length ? <div className="rows">{results.map(user => {
        const controls = controlsTarget(actor, user)
        const edit = can(actor, 'accounts.edit') || controls && (can(actor, 'accounts.roles') || can(actor, 'accounts.status'))
        return <div className="list-row account-row" key={user.id}>
          <Avatar id={user.avatarFileId} name={user.name}/><span><strong>{user.name}</strong><small>{user.username} · {roleNames[user.role]}</small></span>
          <div className="badge-group row-tail">{user.role === 'super_admin' ? <Badge tone="good"><ShieldCheck size={15}/>全部管理权限</Badge> : user.role === 'admin' ? <Badge>已授权 {effectivePermissions(user).length} 项</Badge> : user.role === 'committee' && user.financeManage && <Badge tone="good">班费维护</Badge>}{protectedRole(user.role) && <Badge>{user.inClass ? '已纳入班级名单' : '未纳入班级名单'}</Badge>}<Badge tone={user.active ? 'good' : 'bad'}>{user.active ? '启用' : '停用'}</Badge>{user.mustChangePassword && user.active && <Badge tone="warn">待改密</Badge>}</div>
          <div className="actions">{edit && <button className="btn quiet" onClick={() => setEditor({action: 'edit', user})}><Pencil size={16}/>编辑</button>}{actor.role === 'super_admin' && user.role === 'admin' && <button className="btn quiet" onClick={() => setEditor({action: 'permissions', user})}><ShieldCheck size={16}/>操作权限</button>}{controls && can(actor, 'accounts.resetPassword') && <button className="btn quiet" onClick={() => setEditor({action: 'reset', user})}><KeyRound size={16}/>重置密码</button>}</div>
        </div>
      })}</div> : <Empty>没有符合条件的账号。</Empty>)}
    </Panel>
    {(editor?.action === 'new' || editor?.action === 'edit') && <AccountEditor actor={actor} user={editor.user} close={close} saved={() => saved('账号已保存。')}/>}
    {editor?.action === 'reset' && editor.user && <ResetPassword user={editor.user} close={close} saved={() => saved('密码已重置，该成员需重新登录并修改临时密码。')}/>}
    {editor?.action === 'permissions' && editor.user && actor.role === 'super_admin' && <PermissionEditor user={editor.user} close={close} saved={() => saved('操作权限已更新。新请求立即按新权限校验。')}/>}
    {editor?.action === 'batch' && <BatchAccounts actor={actor} close={close} saved={count => saved(`已创建 ${count} 个账号。`)}/>}
  </div>
}

function PasswordInput({label, hint}: {label: string; hint: string}) {
  const [show, setShow] = useState(false)
  return <div className="stack wide">
    <Field label={label} hint={hint}><input type={show ? 'text' : 'password'} name="password" required minLength={8} maxLength={128} autoComplete="new-password"/></Field>
    <label className="check"><input type="checkbox" checked={show} onChange={event => setShow(event.target.checked)}/>显示本次输入的密码</label>
  </div>
}

export function AccountEditor({actor, user, close, saved}: {actor: User; user?: User; close: () => void; saved: () => void}) {
  const [role, setRole] = useState<Role>(user?.role || 'student')
  const root = actor.role === 'super_admin'
  const controls = !user || controlsTarget(actor, user)
  const editName = !user || can(actor, 'accounts.edit')
  const financeRoleLocked = !root && user?.role === 'committee' && user.financeManage
  const editRole = !user || controls && !financeRoleLocked && can(actor, 'accounts.roles')
  const editStatus = controls && can(actor, 'accounts.status')
  const roles = Object.entries(roleNames).filter(([key]) => root || key === user?.role || controlsTarget(actor, {role: key as Role, financeManage: false}))
  return <Modal title={user ? '编辑账号 · ' + user.name : '创建账号'} close={close}>
    <AsyncForm cancel={close} submit={async form => {
      const input = {
        name: editName ? val(form, 'name') : user!.name,
        role,
        inClass: protectedRole(role) ? (root && editName ? checked(form, 'inClass') : user?.inClass ?? false) : true,
        financeManage: role === 'committee' && (root ? checked(form, 'financeManage') : user?.financeManage ?? false),
      }
      if (user) await api('/users/' + user.id, 'PUT', {...input, ...(root ? {username: val(form, 'username')} : {}), active: editStatus ? checked(form, 'active') : user.active, version: user.version})
      else await api('/users', 'POST', {...input, username: val(form, 'username'), password: form.get('password')})
      saved()
    }}>
      <div className="form-grid">
        <Field label="账户名（登录用户名）" hint={user && root ? '修改后该账号的所有登录会话将失效。' : undefined}><input name="username" required maxLength={64} autoComplete="off" defaultValue={user?.username} readOnly={!!user && !root}/></Field>
        <Field label="姓名"><input name="name" required maxLength={80} defaultValue={user?.name} readOnly={!editName}/></Field>
        <Field label="身份" hint={financeRoleLocked ? '仅 Admin 可调整已获财务授权班委的身份。' : undefined}><select value={role} disabled={!editRole} onChange={event => setRole(event.target.value as Role)}>{roles.map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field>
        {!user && <PasswordInput label="初始密码" hint="至少 8 位，成员首次登录时需修改。"/>}
        {user && <label className="check wide"><input type="checkbox" name="active" defaultChecked={user.active} disabled={!editStatus}/>启用账号</label>}
        {root && role === 'committee' && <label className="check wide"><input type="checkbox" name="financeManage" defaultChecked={user?.financeManage}/>授予班费维护权限</label>}
        {protectedRole(role) && <>
          <label className="check wide"><input type="checkbox" name="inClass" defaultChecked={user && protectedRole(user.role) && user.inClass} disabled={!root || !editName}/>纳入班级名单</label>
          <p className="muted wide">纳入后可参与作业、事务提交和缴费登记。已有任务可在参与名单中补入；取消纳入后保留历史提交，未完成任务自动免交。</p>
        </>}
        {role === 'admin' && (!user || user.role !== 'admin') && <p className="feedback wide">新管理员默认没有管理操作权限。保存后请使用“操作权限”逐项授权。</p>}
        {role === 'super_admin' && <p className="feedback wide">Admin 拥有全部权限，并可管理其他管理员。系统会保留至少一名启用的 Admin。</p>}
      </div>
    </AsyncForm>
  </Modal>
}

export function ResetPassword({user, close, saved}: {user: User; close: () => void; saved: () => void}) {
  return <Modal title={'重置密码 · ' + user.username} close={close}>
    <p className="muted">原密码无法查看。可以设置新的临时密码，重置后该账号的所有登录会话将失效。</p>
    <AsyncForm button="重置密码" cancel={close} submit={async form => {
      await api('/users/' + user.id + '/reset-password', 'POST', {password: form.get('password'), version: user.version})
      saved()
    }}><PasswordInput label="新临时密码" hint="至少 8 位。成员重新登录后必须修改。"/></AsyncForm>
  </Modal>
}

export function PermissionOptions({selected, setSelected}: {selected: Permission[]; setSelected: Dispatch<SetStateAction<Permission[]>>}) {
  const groups = [...new Set(PERMISSIONS.map(item => item.group))]
  return <>{groups.map(group => {
    const items = PERMISSIONS.filter(item => item.group === group)
    return <fieldset className="permission-group" key={group}>
      <legend>{group}</legend>
      <div className="actions">
        <button type="button" className="btn quiet" aria-label={`全选${group}权限`} onClick={() => setSelected(current => items.reduce((result, item) => addPermission(result, item.key), current))}>全选</button>
        <button type="button" className="btn quiet" aria-label={`清空${group}权限`} onClick={() => setSelected(current => items.reduce((result, item) => removePermission(result, item.key), current))}>清空</button>
      </div>
      <div className="permission-options">{items.map(item => <label className="check" key={item.key}>
        <input type="checkbox" name={item.key} checked={selected.includes(item.key)} onChange={event => setSelected(current => event.target.checked ? addPermission(current, item.key) : removePermission(current, item.key))}/>
        <span>{item.label}{item.requires.length > 0 && <small className="muted">（需：{item.requires.map(key => PERMISSIONS.find(required => required.key === key)!.label).join('、')}）</small>}</span>
      </label>)}</div>
    </fieldset>
  })}</>
}

export function PermissionEditor({user, close, saved}: {user: User; close: () => void; saved: () => void}) {
  const [selected, setSelected] = useState<Permission[]>(() => effectivePermissions(user))
  return <Modal title={'操作权限 · ' + user.name} close={close} wide>
    <p className="muted">单独设置此管理员的操作范围。勾选写入或导出权限会同时选中必要的读取权限；取消读取权限会同时取消依赖它的操作。</p>
    <AsyncForm button="保存权限" cancel={close} submit={async () => {
      await api('/users/' + user.id + '/permissions', 'PUT', {permissions: selected, version: user.version})
      saved()
    }}>
      <div className="stack fields">
        <div className="split"><span role="status">已选择 {selected.length} / {PERMISSION_KEYS.length} 项</span><div className="actions"><button type="button" className="btn" onClick={() => setSelected([...PERMISSION_KEYS])}>全选</button><button type="button" className="btn" onClick={() => setSelected([])}>清空</button></div></div>
        <PermissionOptions selected={selected} setSelected={setSelected}/>
      </div>
    </AsyncForm>
  </Modal>
}

function BatchAccounts({actor, close, saved}: {actor: User; close: () => void; saved: (count: number) => void}) {
  const [show, setShow] = useState(false)
  return <Modal title="批量创建账号" close={close} wide>
    <AsyncForm cancel={close} button="批量创建" submit={async form => {
      const roles: Record<string, Role> = {Admin: 'super_admin', super_admin: 'super_admin', admin: 'admin', committee: 'committee', student: 'student', 管理员: 'admin', 班委: 'committee', 学生: 'student'}
      const users = lines(val(form, 'rows')).map((line, index) => {
        const values = line.split(line.includes('\t') ? '\t' : ',').map(value => value.trim())
        const [username, name, role, password] = values
        if (values.length !== 4 || !username || !name || !Object.hasOwn(roles, role) || !password || password.length < 8) throw new Error(`第 ${index + 1} 行格式不正确。请检查四列、身份和密码长度。`)
        if (!controlsTarget(actor, {role: roles[role], financeManage: false})) throw new Error(`第 ${index + 1} 行的身份权限超过您的授权，请联系 Admin。`)
        return {username, name, role: roles[role], password}
      })
      if (!users.length) throw new Error('请填写至少一个账号。')
      const result = await api<{count: number}>('/users/batch', 'POST', {users})
      saved(result.count)
    }}>
      <div className="stack fields"><p className="muted">每行四列：账户名、姓名、身份、初始密码。使用英文逗号或制表符分隔。{actor.role === 'super_admin' ? '身份可填 Admin、管理员、班委或学生。新管理员需要另行分配操作权限。' : '身份可填学生，或您有足够管理权限的班委。'}</p>
        <Field label="账号清单"><textarea name="rows" rows={8} required spellCheck={false} className={show ? '' : 'masked'} autoComplete="off"/></Field>
        <label className="check"><input type="checkbox" checked={show} onChange={event => setShow(event.target.checked)}/>显示输入内容</label>
      </div>
    </AsyncForm>
  </Modal>
}
