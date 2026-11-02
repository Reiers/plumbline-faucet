// SPDX-License-Identifier: MIT
//
// Small server-side cache for upstream JSON sources (Calix) used by the
// builder API v1.
//
//   - Fresh values are served for ttlMs.
//   - Concurrent refreshes are coalesced into one upstream request.
//   - When a refresh fails, the last good value is served with
//     stale: true for up to staleMaxMs. After that the caller gets an
//     UpstreamError and the API answers 502.
//   - After a failure, the upstream is not retried for errorBackoffMs
//     so an outage does not turn every client request into an upstream
//     request.

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UpstreamError'
  }
}

export interface CachedResult<T> {
  value: T
  /** Unix ms when the value was fetched from upstream. */
  fetchedAt: number
  /** Seconds since fetchedAt. */
  cacheAgeSec: number
  /** True when upstream is failing and this is the last good value. */
  stale: boolean
  /** Last upstream error, present when stale is true. */
  upstreamError?: string
}

export interface UpstreamCacheOptions {
  ttlMs: number
  staleMaxMs: number
  errorBackoffMs?: number
  now?: () => number
}

export class UpstreamCache<T> {
  private last: { value: T; fetchedAt: number } | null = null
  private lastError: { message: string; at: number } | null = null
  private inflight: Promise<void> | null = null
  private readonly now: () => number
  private readonly errorBackoffMs: number

  constructor(
    private readonly loader: () => Promise<T>,
    private readonly opts: UpstreamCacheOptions,
  ) {
    this.now = opts.now ?? Date.now
    this.errorBackoffMs = opts.errorBackoffMs ?? 5_000
  }

  async get(): Promise<CachedResult<T>> {
    const now = this.now()
    if (this.last && now - this.last.fetchedAt < this.opts.ttlMs) {
      return this.result(false)
    }
    const inBackoff =
      this.lastError !== null && now - this.lastError.at < this.errorBackoffMs
    if (!inBackoff) {
      await this.refresh()
    }
    const after = this.now()
    if (this.last && after - this.last.fetchedAt < this.opts.ttlMs) {
      return this.result(false)
    }
    if (this.last && after - this.last.fetchedAt <= this.opts.staleMaxMs) {
      return this.result(true)
    }
    throw new UpstreamError(this.lastError?.message ?? 'upstream unavailable')
  }

  private result(stale: boolean): CachedResult<T> {
    const last = this.last!
    const out: CachedResult<T> = {
      value: last.value,
      fetchedAt: last.fetchedAt,
      cacheAgeSec: Math.max(0, Math.floor((this.now() - last.fetchedAt) / 1000)),
      stale,
    }
    if (stale && this.lastError) out.upstreamError = this.lastError.message
    return out
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      try {
        const value = await this.loader()
        this.last = { value, fetchedAt: this.now() }
        this.lastError = null
      } catch (err) {
        this.lastError = {
          message: err instanceof Error ? err.message : String(err),
          at: this.now(),
        }
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}

/** GET a JSON document with a hard timeout. Throws on non-2xx or bad JSON. */
export async function fetchJson(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'plumbline-faucet/api-v1' },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error('timeout after ' + timeoutMs + 'ms')
    }
    throw new Error('unreachable: ' + (err instanceof Error ? err.message : String(err)))
  }
  if (!res.ok) throw new Error('HTTP ' + res.status)
  try {
    return await res.json()
  } catch {
    throw new Error('invalid JSON')
  }
}
