import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { ArrowDownRight, ArrowRight, ArrowUpRight, BookOpen, CalendarDays, ChevronRight, ClipboardList, FolderOpen, GitFork, GraduationCap, House, KeyRound, LogIn, LogOut, Menu, Settings2, UsersRound, Wallet, X } from 'lucide-react'
import { api, dateCN, dateLabel, errorMessage, timestamp, useQuery } from './api'
import { AsyncForm, Badge, Empty, Feedback, Field, PageTitle, Panel, val } from './ui'
import { roleNames, type Config, type Task, type Timetable, type User } from './types'
import { TimetablePage, DailyCourses } from './timetable'
import { Avatar, PersonalAvatar } from './avatar'
import { can, effectivePermissions, isClassMember, PERMISSIONS } from '../shared/permissions'
const Tasks = lazy(() => import('./tasks').then(module => ({default: module.Tasks})))
const Resources = lazy(() => import('./catalog').then(module => ({default: module.Resources})))
const ClassPage = lazy(() => import('./catalog').then(module => ({default: module.ClassPage})))
const Accounts = lazy(() => import('./accounts').then(module => ({default: module.Accounts})))
const Finance = lazy(() => import('./finance').then(module => ({default: module.Finance})))

const repositoryUrl = 'https://github.com/Akiyy-dev/spxd-JW'

function RepositoryLink({placement}: {placement: 'topbar' | 'footer'}) {
  return <a className={'repository-link repository-link-' + placement} href={repositoryUrl} target="_blank" rel="noopener noreferrer" aria-label="GitHub 仓库：Akiyy-dev/spxd-JW（在新标签页打开）" title="在新标签页打开 GitHub 仓库">
    <GitFork size={17} aria-hidden="true"/>
    <span>GitHub{placement === 'footer' && <span className="repository-name"> / spxd-JW</span>}</span>
    <ArrowUpRight className="repository-external" size={14} aria-hidden="true"/>
  </a>
}

const modules = [
  {path: '/', label: '班级首页', icon: House},
  {path: '/homework', label: '作业公告', icon: BookOpen},
  {path: '/timetable', label: '课程表', icon: CalendarDays},
  {path: '/affairs', label: '事务办理', icon: ClipboardList},
  {path: '/resources', label: '资料中心', icon: FolderOpen},
  {path: '/finance', label: '班费管理', icon: Wallet},
  {path: '/class', label: '班级信息', icon: UsersRound},
]

export function App() {
  const session = useQuery<{user: User | null}>('/auth/me')
  const config = useQuery<Config>('/public/config')
  const [identity, setIdentity] = useState<User | null>()
  const user = identity === undefined ? session.data?.user : identity
  const name = config.data?.name || '班级空间'
  const location = useLocation()
  const navigate = useNavigate()
  const [drawer, setDrawer] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const closeMenu = useRef<HTMLButtonElement>(null)
  const [error, setError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  const permissionKey = user ? JSON.stringify([user.id, user.role, user.inClass, user.financeManage, effectivePermissions(user)]) : 'guest'

  useEffect(() => {
    setDrawer(false)
    window.scrollTo(0, 0)
  }, [location.pathname])

  useEffect(() => {
    const expire = () => setIdentity(null)
    window.addEventListener('class-session-expired', expire)
    return () => window.removeEventListener('class-session-expired', expire)
  }, [])

  useEffect(() => {
    if (!drawer) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeMenu.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDrawer(false)
    }
    const onResize = () => {
      if (window.innerWidth > 900) setDrawer(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      menuButton.current?.focus()
    }
  }, [drawer])

  const currentTitle = modules.find(module => module.path !== '/' && location.pathname.startsWith(module.path))?.label
    || ({'/login': '成员登录', '/account': '个人账号', '/accounts': '账号与权限'}[location.pathname] ?? (user ? '班级首页' : '班级简介'))

  useEffect(() => {
    document.title = currentTitle + ' · ' + name
  }, [currentTitle, name])

  async function logout() {
    setError('')
    setSigningOut(true)
    try {
      await api('/auth/logout', 'POST')
      setIdentity(null)
      navigate('/')
    } catch (error) { setError(errorMessage(error)) } finally { setSigningOut(false) }
  }

  async function refreshIdentity() {
    setError('')
    try {
      const {user: refreshed} = await api<{user: User | null}>('/auth/me')
      setIdentity(refreshed)
    } catch (error) { setError(errorMessage(error)) }
  }

  useEffect(() => {
    if (!user) return
    const refresh = () => { if (document.visibilityState === 'visible') void refreshIdentity() }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('class-permissions-changed', refresh)
    const timer = window.setInterval(refresh, 30000)
    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('class-permissions-changed', refresh)
      window.clearInterval(timer)
    }
  }, [user?.id, location.pathname])

  const guard = (content: ReactNode, admin = false) => {
    if (session.loading && user === undefined) return <Feedback loading />
    if (session.error && user === undefined) return <Feedback error={session.error} retry={session.reload} />
    if (!user) return <Navigate to="/login" replace state={{from: location.pathname + location.search}} />
    if (user.mustChangePassword && location.pathname !== '/account') return <Navigate to="/account" replace />
    if (admin && !can(user, 'accounts.read')) return <Navigate to="/" replace />
    return content
  }

  const links = user ? modules : [{path: '/', label: '班级简介', icon: House}, modules[2]]
  return <div className="shell">
    <a href="#main" className="skip-link" hidden={drawer}>跳到主要内容</a>
    {drawer && <button className="drawer-overlay" aria-label="关闭导航" tabIndex={-1} onClick={() => setDrawer(false)} />}
    <aside id="navigation" className={'sidebar' + (drawer ? ' open' : '')}>
      <Link className="brand" to="/" onClick={() => setDrawer(false)}><span className="brand-icon"><GraduationCap size={24} aria-hidden="true"/></span><span><strong>{name}</strong><small>班级工作台</small></span></Link>
      <button ref={closeMenu} className="btn quiet icon mobile-close" aria-label="关闭导航" onClick={() => setDrawer(false)}><X size={20}/></button>
      <nav aria-label="主导航">
        <p className="nav-label">{user ? '工作台' : '公开信息'}</p>
        {links.map(({path, label, icon: Icon}) => <NavLink key={path} to={path} end={path === '/'} onClick={() => setDrawer(false)}><Icon size={19} aria-hidden="true"/>{label}</NavLink>)}
        {user && <><p className="nav-label">设置</p><NavLink to="/account" onClick={() => setDrawer(false)}><KeyRound size={19}/>个人账号</NavLink>{can(user, 'accounts.read') && <NavLink to="/accounts" onClick={() => setDrawer(false)}><Settings2 size={19}/>账号与权限</NavLink>}</>}
      </nav>
      <div className="sidebar-footer"><span className="sidebar-mark"/><span>{config.data?.academicYear || '班级工作台'}</span></div>
    </aside>
    <div className="body-shell" inert={drawer}>
      <header className="topbar">
        <button ref={menuButton} className="btn quiet icon menu-button" aria-label={drawer ? '关闭导航' : '打开导航'} aria-controls="navigation" aria-expanded={drawer} onClick={() => setDrawer(!drawer)}><Menu size={22}/></button>
        <div className="breadcrumb"><span>{name}</span><ChevronRight size={15}/><strong>{currentTitle}</strong></div>
        <div className="topbar-actions">
          {config.data?.demo && <Badge tone="warn">演示数据</Badge>}
          <RepositoryLink placement="topbar" />
          {user ? <><Link to="/account" className="user-chip"><Avatar id={user.mustChangePassword ? null : user.avatarFileId} name={user.name}/><span className="chip-name">{user.name}<small>{roleNames[user.role]}</small></span></Link><button className="btn quiet icon" title="退出登录" aria-label="退出登录" disabled={signingOut} onClick={() => void logout()}><LogOut size={18}/></button></> : <Link to="/login" className="btn"><LogIn size={17}/>登录</Link>}
        </div>
      </header>
      <main id="main" className="main-content" tabIndex={-1}>
        <Feedback error={error} />
        <Suspense fallback={<Feedback loading />}><Routes key={permissionKey}>
          <Route path="/" element={user ? guard(<Dashboard user={user} name={name}/>) : session.loading ? <Feedback loading /> : <PublicPage config={config} />} />
          <Route path="/login" element={user ? <Navigate to={user.mustChangePassword ? '/account' : '/'} replace /> : <Login authenticated={newUser => {
            setIdentity(newUser)
            const from = typeof location.state?.from === 'string' && /^\/(?!\/)/.test(location.state.from) ? location.state.from : '/'
            navigate(newUser.mustChangePassword ? '/account' : from, {replace: true})
          }} />} />
          <Route path="/timetable" element={<TimetablePage user={user?.mustChangePassword ? null : user} />} />
          <Route path="/homework/*" element={guard(user && <Tasks key="homework" user={user} kind="homework" />)} />
          <Route path="/affairs/*" element={guard(user && <Tasks key="affairs" user={user} kind="affairs" />)} />
          <Route path="/resources" element={guard(user && <Resources user={user} />)} />
          <Route path="/finance" element={guard(user && <Finance user={user} />)} />
          <Route path="/class" element={guard(user && <ClassPage user={user} changed={() => {config.reload(); void refreshIdentity()}} />)} />
          <Route path="/account" element={guard(user && <Account user={user} update={setIdentity} />)} />
          <Route path="/accounts" element={guard(user && <Accounts user={user} changed={() => {void refreshIdentity()}} />, true)} />
          <Route path="*" element={<PageTitle label="404" title="找不到页面" detail="该地址可能已经变更。" actions={<Link className="btn primary" to="/">返回首页</Link>} />} />
        </Routes></Suspense>
      </main>
      <footer className="footer">
        <div className="footer-brand"><GraduationCap size={17} aria-hidden="true"/>{name}</div>
        <div className="footer-links"><span>课程 · 学习 · 班级生活</span><RepositoryLink placement="footer" /></div>
      </footer>
    </div>
  </div>
}

function PublicPage({config}: {config: ReturnType<typeof useQuery<Config>>}) {
  return <div className="stack">
    <section className="hero public-hero">
      <div className="hero-content"><p className="eyebrow">班级简介</p><h1>{config.data?.name || '班级空间'}</h1><p>{config.data?.subtitle || '在这里查看班级简介与课程安排。'}</p><div className="actions"><Link className="btn primary" to="/login"><LogIn size={18}/>成员登录</Link><Link className="btn" to="/timetable"><CalendarDays size={18}/>查看课程表</Link></div></div>
      <div className="hero-decoration" aria-hidden="true"><GraduationCap size={108}/><span>CLASSROOM</span></div>
    </section>
    <Panel title="关于我们">
      <Feedback {...config} retry={config.reload}/>
      {config.data && <><p className="prose">{config.data.introduction || '班级简介待发布。'}</p>{config.data.academicYear && <Badge>{config.data.academicYear}</Badge>}{config.data.photoFileId && <img className="class-photo" src={'/api/public/photo/' + config.data.photoFileId} alt="班级照片"/>}</> }
    </Panel>
  </div>
}

function Login({authenticated}: {authenticated: (user: User) => void}) {
  return <div className="login-layout"><div className="login-art"><span className="brand-icon"><GraduationCap size={26}/></span><p className="eyebrow">班级工作台</p><h1>欢迎回来</h1><p>登录后查看作业、办理班级事务和查阅资料。</p><CalendarDays className="login-watermark" size={174} aria-hidden="true"/></div>
    <Panel title="成员登录" detail="使用管理员分配的账号进入班级。">
      <AsyncForm button="登录" submit={async data => {
        const {user} = await api<{user: User}>('/auth/login', 'POST', {username: val(data, 'username'), password: data.get('password')})
        authenticated(user)
      }}>
        <div className="stack fields">
          <Field label="用户名"><input name="username" autoComplete="username" required /></Field>
          <Field label="密码"><input type="password" name="password" autoComplete="current-password" required /></Field>
        </div>
      </AsyncForm>
      <Link className="text-link" to="/timetable">查看公开课表 <ArrowRight size={16}/></Link>
    </Panel>
  </div>
}

function Account({user, update}: {user: User; update: (user: User) => void}) {
  const [saved, setSaved] = useState(false)
  const navigate = useNavigate()
  return <div className="stack">
    <PageTitle label="设置" title="个人账号" detail="查看当前登录身份，管理账号密码。" />
    <Panel title={user.name} detail={user.username}><Badge>{roleNames[user.role]}</Badge> {user.role === 'super_admin' ? <Badge tone="good">全部管理权限</Badge> : user.role === 'admin' ? <Badge>已授权 {effectivePermissions(user).length} 项操作</Badge> : user.role === 'committee' && user.financeManage && <Badge tone="good">班费维护权限</Badge>}</Panel>
    {user.role === 'admin' && <Panel title="我的管理权限" detail="由 Admin 按具体操作授权；需要调整时请联系 Admin。">
      {effectivePermissions(user).length ? <div className="stack">{[...new Set(PERMISSIONS.filter(item => can(user, item.key)).map(item => item.group))].map(group => <div key={group}><strong>{group}</strong><p className="muted">{PERMISSIONS.filter(item => item.group === group && can(user, item.key)).map(item => item.label).join('、')}</p></div>)}</div> : <Empty>当前没有管理操作权限，可查看班级公开给成员的信息。</Empty>}
    </Panel>}
    <PersonalAvatar user={user} update={update}/>
    <Panel title="修改密码" detail={user.mustChangePassword ? '首次登录或密码被重置后，请先更新密码。' : '请使用长度至少 8 位的新密码。'}>
      {saved && <p role="status" className="feedback">密码已更新。</p>}
      <AsyncForm button="更新密码" submit={async data => {
        if (data.get('newPassword') !== data.get('confirm')) throw new Error('两次输入的新密码不一致。')
        const {user: changed} = await api<{user: User}>('/auth/password', 'POST', {currentPassword: data.get('currentPassword'), newPassword: data.get('newPassword')})
        update(changed)
        if (user.mustChangePassword) {
          navigate('/', {replace: true})
          return
        }
        setSaved(true)
      }}>
        <div className="form-grid">
          <Field label="当前密码" wide><input name="currentPassword" type="password" autoComplete="current-password" required /></Field>
          <Field label="新密码"><input name="newPassword" type="password" autoComplete="new-password" minLength={8} required /></Field>
          <Field label="确认新密码"><input name="confirm" type="password" autoComplete="new-password" minLength={8} required /></Field>
        </div>
      </AsyncForm>
    </Panel>
  </div>
}

function Dashboard({user, name}: {user: User; name: string}) {
  const today = dateCN()
  const lessons = useQuery<Timetable>('/public/timetable?date=' + today)
  const homework = useQuery<Task[]>('/homework')
  const affairs = useQuery<Task[]>('/affairs')
  const manager = can(user, 'homework.create')
  const member = isClassMember(user)
  const taskList = [...(homework.data || []), ...(affairs.data || [])]
  const tasks = taskList.filter(task => task.status === 'published' && task.requiresSubmission && task.myParticipantStatus === 'required' && !task.mySubmission)
    .sort((a, b) => (a.deadline || 'Z').localeCompare(b.deadline || 'Z'))
  const latest = (homework.data || []).filter(task => task.status === 'published').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4)
  return <div className="stack dashboard">
    <section className="hero dashboard-hero"><div className="hero-content"><p className="eyebrow"><CalendarDays size={16}/>{dateLabel(today)}</p><h1>你好，{user.name}</h1><p>欢迎来到{name}，从这里开始今天的班级活动。</p></div><div className="hero-decoration" aria-hidden="true"><BookOpen size={92}/><span>CLASSROOM</span></div></section>
    <div className={member ? 'dashboard-grid' : 'dashboard-grid manager-home'}>
      <Panel title="今日课程" detail={dateLabel(today)} actions={<Link className="text-link" to="/timetable">查看课表 <ArrowRight size={16}/></Link>}>
        <Feedback {...lessons} retry={lessons.reload}/>{lessons.data && <DailyCourses courses={lessons.data.today} periods={lessons.data.periods} />}
      </Panel>
      {member ? <Panel title="我的待办" detail="按截止时间排序" actions={<Badge>{tasks.length} 项</Badge>}>
        <Feedback error={homework.error || affairs.error} loading={homework.loading || affairs.loading} retry={() => {homework.reload(); affairs.reload()}}/>
        {homework.data && affairs.data && (tasks.length ? <div className="rows">{tasks.map(task => <Link className="list-row" key={task.id} to={'/' + task.kind + '/' + task.id}><span className="row-icon"><ClipboardList size={18}/></span><span><strong>{task.title}</strong><small>{task.deadline ? timestamp(task.deadline) : '无截止时间'}</small></span><ArrowRight className="row-tail" size={17}/></Link>)}</div> : <Empty>没有待办事项。新发布的任务会在这里显示。</Empty>)}
      </Panel> : <Panel title="办理进度" detail="近期已发布的作业和事务">
        <Feedback error={homework.error || affairs.error} loading={homework.loading || affairs.loading} retry={() => {homework.reload(); affairs.reload()}}/>
        {homework.data && affairs.data && (taskList.some(task => task.status === 'published' && task.requiresSubmission) ? <div className="rows">{taskList.filter(task => task.status === 'published' && task.requiresSubmission).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 4).map(task => <Link className="list-row" key={task.id} to={'/' + task.kind + '/' + task.id}><span><strong>{task.title}</strong><small>{task.submittedCount !== undefined && task.participantCount !== undefined ? `已完成 ${task.submittedCount} / ${task.participantCount}` : task.submittedCount !== undefined ? `已提交 ${task.submittedCount} 人` : task.participantCount !== undefined ? `参与 ${task.participantCount} 人` : '查看公告'}</small></span><ArrowRight className="row-tail" size={17}/></Link>)}</div> : <Empty>已发布事项的提交进度会在这里显示。</Empty>)}
      </Panel>}
    </div>
    <Panel title="最新作业" detail="最近发布或更新的作业公告" actions={<Link className="text-link" to={manager ? '/homework?create=1' : '/homework'}>{manager ? '新增作业' : '全部作业'} <ArrowRight size={16}/></Link>}>
      <Feedback {...homework} retry={homework.reload} />
      {homework.data && (latest.length ? <div className="rows">{latest.map(task => <Link className="list-row" key={task.id} to={'/homework/' + task.id}><span className="row-icon violet"><BookOpen size={19}/></span><span><strong>{task.title}</strong><small>{task.course || '作业公告'} · {task.deadline ? timestamp(task.deadline) : '无截止时间'}</small></span><ArrowRight className="row-tail" size={17}/></Link>)}</div> : <Empty>暂无已发布的作业公告。</Empty>)}
    </Panel>
    <Panel title="快捷入口"><div className="quick-grid">{modules.slice(1).map(({path, label, icon: Icon}) => <Link key={path} to={path}><span className="row-icon"><Icon size={20}/></span><strong>{label}</strong><ArrowDownRight size={15}/></Link>)}</div></Panel>
  </div>
}
