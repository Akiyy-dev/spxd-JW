// Keep the destination in the URL so reopening a login page does not depend on
// WebView history state, cookies, or browser storage.
function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/'
  try {
    const base = 'https://return-to.invalid'
    const url = new URL(value, base)
    const path = decodeURIComponent(url.pathname)
    if (url.origin !== base || path.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(path) || /^\/login\/*$/i.test(path)) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    return '/'
  }
}

export function loginReturnTo(search: string, state?: unknown): string {
  const params = new URLSearchParams(search)
  const previous = state && typeof state === 'object' && 'from' in state ? state.from : undefined
  return safeReturnTo(params.has('returnTo') ? params.get('returnTo') : previous)
}

export function authPath(page: '/login' | '/account', destination: string): string {
  const returnTo = safeReturnTo(destination)
  return page === '/login' && returnTo === '/' ? page : page + '?' + new URLSearchParams({returnTo})
}
