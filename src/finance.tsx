import { useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Banknote, History, Plus, Wallet } from 'lucide-react'
import { api, dateCN, timestamp, useQuery } from './api'
import { AsyncForm, Badge, checked, Empty, ExportButton, Feedback, Field, FileList, Modal, PageTitle, Panel, UploadFiles, val } from './ui'
import type { Entry, Fee, Ledger, Payment, User } from './types'

const base = '/finance'
const yuan = new Intl.NumberFormat('zh-CN', {style: 'currency', currency: 'CNY'})
const money = (cents: number) => yuan.format(cents / 100)
const entryTypes = {opening: '期初', income: '收入', expense: '支出'}
type LedgerMember = {id: string; name: string}
type Editor =
  | {kind: 'entry'; entry?: Entry}
  | {kind: 'fee'; fee?: Fee}
  | {kind: 'payment'; payment?: Payment; fee?: Fee}
  | {kind: 'void'; target: 'entries' | 'payments'; record: Entry | Payment}
  | {kind: 'history'}

export function Finance({user}: {user: User}) {
  const query = useQuery<Ledger>(base)
  const data = query.data
  const [tab, setTab] = useState<'ledger' | 'fees'>('ledger')
  const [editor, setEditor] = useState<Editor>()
  const [notice, setNotice] = useState('')
  const [type, setType] = useState('')
  const [from, setFrom] = useState('')
  const [until, setUntil] = useState('')
  const [showVoided, setShowVoided] = useState(false)
  const needsMembers = tab === 'fees' || editor?.kind === 'fee' || editor?.kind === 'payment'
  const members = useQuery<LedgerMember[]>(needsMembers && data?.canViewAll ? base + '/members' : null)
  const close = () => setEditor(undefined)
  const saved = () => {close(); query.reload(); setNotice('班费记录已保存。')}
  const canManage = !!data?.canManage
  const entries = data?.entries.filter(entry => (!type || entry.type === type) && (!from || entry.date >= from) && (!until || entry.date <= until) && (showVoided || !entry.voided))
  const feeTitle = (id: string) => data?.fees.find(item => item.id === id)?.title || '缴费事项'
  return <div className="stack">
    <PageTitle label="班级收支" title="班费管理" detail="查阅班费收支公示和已发生的缴费记录。" actions={data?.canViewAll && <>
      <button className="btn" onClick={() => setEditor({kind: 'history'})}><History size={17}/>修订记录</button>
      <ExportButton path={base + '/export'}/>
      {canManage && <button className="btn primary" onClick={() => setEditor({kind: 'entry'})}><Plus size={18}/>新增账目</button>}
    </>} />
    <Feedback {...query} retry={query.reload}/>
    {notice && <p className="feedback" role="status">{notice}</p>}
    {data && <>
      <div className="metrics-grid">{([
        ['当前余额', data.balance, Wallet], ['期初金额', data.opening, Banknote], ['有效收入', data.income, ArrowDownLeft], ['有效支出', data.expense, ArrowUpRight],
      ] as const).map(([label, amount, Icon], index) => <div className={'metric ' + (index === 0 ? 'metric-primary' : '')} key={label}><span><Icon size={18}/>{label}</span><strong>{money(amount)}</strong></div>)}</div>
      <div className="segments tabs" aria-label="班费内容"><button aria-pressed={tab === 'ledger'} onClick={() => setTab('ledger')}>收支台账</button><button aria-pressed={tab === 'fees'} onClick={() => setTab('fees')}>缴费事项与登记</button></div>
      {tab === 'ledger' ? <Panel title="收支台账" detail="按类别和发生日期查看账目。">
        <div className="toolbar">
          <select aria-label="账目类型" value={type} onChange={event => setType(event.target.value)}><option value="">全部类型</option>{Object.entries(entryTypes).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select>
          <label className="inline-label">开始日期<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label>
          <label className="inline-label">结束日期<input type="date" value={until} min={from || undefined} onChange={event => setUntil(event.target.value)}/></label>
          {data.canViewAll && <label className="check"><input type="checkbox" checked={showVoided} onChange={event => setShowVoided(event.target.checked)}/>显示作废</label>}
        </div>
        {entries?.length ? <div className="table-scroll" tabIndex={0} aria-label="收支台账表"><table><thead><tr><th>发生日期</th><th>类别及说明</th><th>金额</th><th>凭证与操作</th></tr></thead><tbody>{entries.map(entry => <tr key={entry.id}>
          <td className="nowrap">{entry.date}</td>
          <td><div className="badge-group"><Badge tone={entry.type === 'income' ? 'good' : ''}>{entryTypes[entry.type]}</Badge>{entry.voided && <Badge tone="bad">已作废</Badge>}{entry.paymentId && <Badge>缴费入账</Badge>}</div><strong>{entry.category || entryTypes[entry.type]}</strong>{entry.description && <p className="muted prose">{entry.description}</p>}</td>
          <td className="money nowrap">{entry.type === 'expense' ? '−' : ''}{money(entry.amount)}</td>
          <td><FileList ids={entry.receiptIds}/>{canManage && !entry.voided && !entry.paymentId && <div className="actions"><button className="btn quiet" onClick={() => setEditor({kind: 'entry', entry})}>修订</button><button className="btn quiet" onClick={() => setEditor({kind: 'void', target: 'entries', record: entry})}>作废</button></div>}</td>
        </tr>)}</tbody></table></div> : <Empty>当前筛选下没有收支记录。</Empty>}
      </Panel> : <>
        <Panel title="缴费事项" detail={data.canViewAll ? '查看应缴、实缴、待缴和超缴明细。' : '这里展示与你相关的应缴和实缴金额。'} actions={canManage && <button className="btn primary" onClick={() => setEditor({kind: 'fee'})}><Plus size={17}/>新增缴费事项</button>}>
          <Feedback {...members} retry={members.reload}/>
          {data.fees.length ? <div className="stack">{data.fees.map(fee => <FeeCard key={fee.id} fee={fee} ledger={data} members={members.data || []} user={user} actions={canManage && <>
            <button className="btn" onClick={() => setEditor({kind: 'fee', fee})}>编辑事项</button><button className="btn primary" onClick={() => setEditor({kind: 'payment', fee})}>登记实缴</button>
          </>}/>)}</div> : <Empty>暂无缴费事项。</Empty>}
        </Panel>
        <Panel title={data.canViewAll ? '实缴登记' : '我的实缴记录'} detail="每次实际到账保留一条登记记录。" actions={canManage && !!data.fees.length && <button className="btn" onClick={() => setEditor({kind: 'payment'})}><Plus size={17}/>新增登记</button>}>
          {data.payments.length ? <div className="rows">{data.payments.map(payment => <div key={payment.id} className="list-row payment-row">
            <span className="row-icon"><Banknote size={18}/></span><div><strong>{feeTitle(payment.feeId)}</strong><small>{payment.date}{data.canViewAll ? ' · ' + payment.name : ''}</small>{payment.description && <p className="muted prose">{payment.description}</p>}<FileList ids={payment.receiptIds}/></div>
            <div className="row-tail badge-group"><strong className="money">{money(payment.amount)}</strong>{payment.voided && <Badge tone="bad">已作废</Badge>}</div>
            {canManage && !payment.voided && <div className="actions"><button className="btn quiet" onClick={() => setEditor({kind: 'payment', payment})}>修订</button><button className="btn quiet" onClick={() => setEditor({kind: 'void', target: 'payments', record: payment})}>作废</button></div>}
          </div>)}</div> : <Empty>暂无实缴记录。</Empty>}
        </Panel>
      </>}
    </>}
    {canManage && editor?.kind === 'entry' && <EntryEditor entry={editor.entry} hasOpening={!!data?.entries.some(entry => entry.type === 'opening' && !entry.voided)} close={close} saved={saved}/>}
    {canManage && editor?.kind === 'fee' && <RosterModal title={editor.fee ? '编辑缴费事项' : '新增缴费事项'} members={members} close={close} render={roster => <FeeEditor fee={editor.fee} members={roster} close={close} saved={saved}/>}/>}
    {canManage && editor?.kind === 'payment' && data && <RosterModal title={editor.payment ? '修订实缴登记' : '登记实际到账'} members={members} close={close} render={roster => <PaymentEditor payment={editor.payment} initialFee={editor.fee} fees={data.fees} members={roster} close={close} saved={saved}/>}/>}
    {canManage && editor?.kind === 'void' && <Modal title="作废记录" close={close}>
      <AsyncForm danger cancel={close} button="确认作废" submit={async form => {
        await api(`${base}/${editor.target}/${editor.record.id}/void`, 'POST', {version: editor.record.version, reason: val(form, 'reason')})
        saved()
      }}><p className="muted">金额 {money(editor.record.amount)} 将从有效账目中移除，历史记录会保留。</p><Reason /></AsyncForm>
    </Modal>}
    {data?.canViewAll && editor?.kind === 'history' && <FinanceHistory close={close}/>}
  </div>
}

function FeeCard({fee, ledger, members, user, actions}: {fee: Fee; ledger: Ledger; members: LedgerMember[]; user: User; actions: React.ReactNode}) {
  const payments = ledger.payments.filter(payment => payment.feeId === fee.id && !payment.voided)
  const ids = ledger.canViewAll ? [...new Set([...fee.userIds, ...payments.map(payment => payment.userId)])] : [user.id]
  const amounts = ids.map(id => {
    const paid = payments.filter(payment => payment.userId === id).reduce((sum, payment) => sum + payment.amount, 0)
    const due = fee.userIds.includes(id) ? fee.amount : 0
    const name = members.find(member => member.id === id)?.name || payments.find(payment => payment.userId === id)?.name || (id === user.id ? user.name : '历史成员')
    return {id, name, paid, due, remaining: Math.max(0, due - paid), excess: Math.max(0, paid - due)}
  })
  const sums = amounts.reduce((sum, row) => ({due: sum.due + row.due, paid: sum.paid + row.paid, remaining: sum.remaining + row.remaining, excess: sum.excess + row.excess}), {due: 0, paid: 0, remaining: 0, excess: 0})
  return <article className="nested-panel fee-card">
    <div className="split"><div><h3>{fee.title}</h3><p className="muted">{fee.deadline ? '登记截止 ' + fee.deadline : '无登记截止日期'}{ledger.canViewAll && ` · ${fee.userIds.length} 位成员 · 每人 ${money(fee.amount)}`}</p></div><div className="actions">{actions}</div></div>
    <div className="mini-metrics">{[['应缴', sums.due], ['已缴', sums.paid], ['待缴', sums.remaining], ['超缴', sums.excess]].map(([label, amount]) => <div key={label}><span>{label}</span><strong>{money(Number(amount))}</strong></div>)}</div>
    {ledger.canViewAll && amounts.length > 0 && <details><summary>查看成员明细</summary><div className="table-scroll" tabIndex={0} aria-label="缴费成员明细"><table><thead><tr><th>成员</th><th>应缴</th><th>实缴</th><th>待缴</th><th>超缴</th></tr></thead><tbody>{amounts.map(row => <tr key={row.id}><td>{row.name}</td>{[row.due, row.paid, row.remaining, row.excess].map((amount, index) => <td key={index} className="nowrap">{money(amount)}</td>)}</tr>)}</tbody></table></div></details>}
  </article>
}

function RosterModal({title, close, members, render}: {title: string; close: () => void; members: ReturnType<typeof useQuery<LedgerMember[]>>; render: (members: LedgerMember[]) => React.ReactNode}) {
  return <Modal title={title} close={close}><Feedback {...members} retry={members.reload}/>{members.data && render(members.data)}</Modal>
}

function amountCents(raw: string): number {
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('请输入正数金额，最多保留两位小数。')
  const [whole, decimal = ''] = raw.split('.')
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('金额必须大于零且在可记录范围内。')
  return cents
}

function Amount({value}: {value?: number}) {
  return <Field label="金额（元）"><input inputMode="decimal" name="amount" required maxLength={20} defaultValue={value == null ? '' : (value / 100).toFixed(2)} placeholder="0.00"/></Field>
}

function Reason() {
  return <Field label="原因" wide><textarea name="reason" required rows={3} maxLength={1000}/></Field>
}

function EntryEditor({entry, hasOpening, close, saved}: {entry?: Entry; hasOpening: boolean; close: () => void; saved: () => void}) {
  const [receipts, setReceipts] = useState(entry?.receiptIds || [])
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  return <Modal title={entry ? '修订账目' : '新增账目'} close={close}>
    <AsyncForm cancel={close} submit={async form => {
      const body = {type: val(form, 'type'), amount: amountCents(val(form, 'amount')), category: val(form, 'category'), description: val(form, 'description'), date: val(form, 'date'), receiptIds: receipts, publicReceipt: checked(form, 'publicReceipt')}
      if (entry) await api(base + '/entries/' + entry.id, 'PUT', {...body, version: entry.version, reason: val(form, 'reason')})
      else await api(base + '/entries', 'POST', {...body, idempotencyKey})
      saved()
    }}>
      <div className="form-grid">
        <Field label="账目类型"><select name="type" defaultValue={entry?.type || 'expense'}>{Object.entries(entryTypes).filter(([key]) => key !== 'opening' || !hasOpening || entry?.type === 'opening').map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></Field>
        <Amount value={entry?.amount}/>
        <Field label="发生日期"><input type="date" name="date" required defaultValue={entry?.date || dateCN()}/></Field>
        <Field label="账目类别"><input name="category" maxLength={100} defaultValue={entry?.category}/></Field>
        <Field label="说明" wide><textarea name="description" rows={4} maxLength={2000} defaultValue={entry?.description}/></Field>
        <UploadFiles purpose="receipt" entityId={entry?.id} ids={receipts} setIds={setReceipts} label="账目凭证"/>
        <label className="check wide"><input type="checkbox" name="publicReceipt" defaultChecked={entry?.publicReceipt}/>公示凭证给班级成员</label>
        {entry && <Reason/>}
      </div>
    </AsyncForm>
  </Modal>
}

function FeeEditor({fee, members, close, saved}: {fee?: Fee; members: LedgerMember[]; close: () => void; saved: () => void}) {
  const [selected, setSelected] = useState(() => new Set(fee?.userIds || []))
  const historical = (fee?.userIds || []).filter(id => !members.some(member => member.id === id))
  return <AsyncForm cancel={close} submit={async form => {
    const body = {title: val(form, 'title'), amount: amountCents(val(form, 'amount')), deadline: val(form, 'deadline') || null, userIds: [...selected]}
    if (fee) await api(base + '/fees/' + fee.id, 'PUT', {...body, version: fee.version})
    else await api(base + '/fees', 'POST', body)
    saved()
  }}>
    <div className="form-grid">
      <Field label="事项名称" wide><input name="title" required maxLength={150} defaultValue={fee?.title}/></Field>
      <Amount value={fee?.amount}/>
      <Field label="登记截止日期"><input type="date" name="deadline" defaultValue={fee?.deadline || ''}/></Field>
      <div className="wide editor-section"><div className="split"><h3>缴费对象</h3><button type="button" className="btn quiet" onClick={() => setSelected(new Set([...historical, ...members.map(member => member.id)]))}>全选在册成员</button></div>
        <div className="checks roster-checks">{members.map(member => <label key={member.id}><input type="checkbox" checked={selected.has(member.id)} onChange={event => {
          const next = new Set(selected)
          if (event.target.checked) next.add(member.id)
          else next.delete(member.id)
          setSelected(next)
        }}/>{member.name}</label>)}</div>
        {historical.length > 0 && <label className="check"><input type="checkbox" checked={historical.every(id => selected.has(id))} onChange={event => setSelected(new Set([...selected].filter(id => !historical.includes(id)).concat(event.target.checked ? historical : [])))}/>保留 {historical.length} 位历史成员</label>}
        {!members.length && <Empty>暂无在册成员。</Empty>}
      </div>
    </div>
  </AsyncForm>
}

function PaymentEditor({payment, initialFee, fees, members, close, saved}: {payment?: Payment; initialFee?: Fee; fees: Fee[]; members: LedgerMember[]; close: () => void; saved: () => void}) {
  const [feeId, setFeeId] = useState(payment?.feeId || initialFee?.id || fees[0]?.id || '')
  const [payer, setPayer] = useState(payment?.userId || '')
  const [receipts, setReceipts] = useState(payment?.receiptIds || [])
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const selectedFee = fees.find(fee => fee.id === feeId)
  const selectable = members.filter(member => selectedFee?.userIds.includes(member.id))
  const historical = payment?.feeId === feeId && !selectable.some(member => member.id === payment?.userId)
  return <AsyncForm cancel={close} submit={async form => {
    const body = {feeId, userId: payer, amount: amountCents(val(form, 'amount')), date: val(form, 'date'), description: val(form, 'description'), receiptIds: receipts, publicReceipt: checked(form, 'publicReceipt')}
    if (payment) await api(base + '/payments/' + payment.id, 'PUT', {...body, version: payment.version, reason: val(form, 'reason')})
    else await api(base + '/payments', 'POST', {...body, idempotencyKey})
    saved()
  }}>
    <div className="form-grid">
      <Field label="缴费事项"><select required value={feeId} onChange={event => {setFeeId(event.target.value); setPayer('')}}><option value="">请选择</option>{fees.map(fee => <option key={fee.id} value={fee.id}>{fee.title}</option>)}</select></Field>
      <Field label="缴费成员"><select required value={payer} onChange={event => setPayer(event.target.value)}><option value="">请选择</option>{historical && payment && <option value={payment.userId}>{payment.name}（历史成员）</option>}{selectable.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></Field>
      <Amount value={payment?.amount}/>
      <Field label="到账日期"><input name="date" type="date" required defaultValue={payment?.date || dateCN()}/></Field>
      <Field label="到账说明" wide><textarea name="description" rows={3} maxLength={2000} defaultValue={payment?.description}/></Field>
      <UploadFiles purpose="receipt" entityId={payment?.id} ids={receipts} setIds={setReceipts} label="到账凭证"/>
      <label className="check wide"><input type="checkbox" name="publicReceipt" defaultChecked={payment?.publicReceipt}/>公示凭证给班级成员</label>
      {payment && <Reason/>}
    </div>
  </AsyncForm>
}

type Revision = {id: string; entityType: 'entry' | 'payment' | 'fee'; version: number; reason: string; actorName: string; createdAt: string; action?: 'update' | 'void'; data?: Partial<Entry & Payment & Fee>}
function FinanceHistory({close}: {close: () => void}) {
  const history = useQuery<Revision[]>(base + '/history')
  const entities = {entry: '收支账目', payment: '缴费登记', fee: '缴费事项'}
  return <Modal title="班费修订记录" close={close} wide><div className="stack">
    <Feedback {...history} retry={history.reload}/>
    {history.data && (history.data.length ? history.data.map(item => <article key={item.id} className="nested-panel">
      <div className="split"><strong>{entities[item.entityType]} · {item.action === 'void' ? '作废' : '修订'}</strong><Badge>原第 {item.version} 版</Badge></div>
      <p className="muted">{item.actorName} · {timestamp(item.createdAt)}</p><p className="prose">{item.reason}</p>
      {item.data && <div className="badge-group"><Badge>{item.data.title || item.data.category || item.data.name || '原记录'}</Badge>{item.data.amount != null && <Badge>{money(item.data.amount)}</Badge>}{item.data.date && <Badge>{item.data.date}</Badge>}</div>}
      <FileList ids={item.data?.receiptIds}/>
    </article>) : <Empty>暂无修订或作废记录。</Empty>)}
  </div></Modal>
}
