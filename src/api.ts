import { useCallback, useEffect, useState } from 'react'

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message)
  }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api' + path, {
    method, credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
  })
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('class-session-expired'))
    if (response.status === 403 && path !== '/auth/me') window.dispatchEvent(new Event('class-permissions-changed'))
    const data = await response.json().catch(() => null)
    throw new ApiError(data?.message || `请求失败（${response.status}）`, response.status)
  }
  return response.json()
}

export function useQuery<T>(path: string | null) {
  const [epoch, setEpoch] = useState(0)
  const [result, setResult] = useState<{path: string; data?: T; error?: string}>()
  const reload = useCallback(() => setEpoch(value => value + 1), [])
  useEffect(() => {
    if (!path) return
    let active = true
    api<T>(path).then(
      data => { if (active) setResult({path, data}) },
      error => { if (active) setResult({path, error: errorMessage(error)}) },
    )
    return () => { active = false }
  }, [path, epoch])
  const value = result?.path === path ? result : undefined
  return {data: value?.data, error: value?.error, loading: !!path && !value, reload}
}

export const errorMessage = (error: unknown) =>
  error instanceof TypeError ? '连接失败，请检查网络后重试。' : error instanceof Error ? error.message : '操作失败，请重试。'

export const dateCN = (date = new Date()) => date.toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'})
export const dateLabel = (date: string) => new Date(date.length === 10 ? date + 'T00:00:00+08:00' : date).toLocaleDateString('zh-CN', {timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long'})
export const timestamp = (date: string) => new Date(date).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false})
export const datetimeInput = (date?: string | null) => date ? new Date(new Date(date).getTime() + 8 * 3600000).toISOString().slice(0, 16) : ''
export const datetimeISO = (value: string) => value ? new Date(value + '+08:00').toISOString() : null
