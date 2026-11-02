// SPDX-License-Identifier: MIT
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UpstreamCache, UpstreamError } from '../src/upstream-cache.js'
import { FixedWindowLimiter } from '../src/api-v1.js'

test('UpstreamCache: fresh, coalesced, stale, then error', async () => {
  let now = 1_000_000
  let calls = 0
  let fail = false
  const c = new UpstreamCache(
    async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      if (fail) throw new Error('HTTP 503')
      return { n: calls }
    },
    { ttlMs: 30_000, staleMaxMs: 600_000, errorBackoffMs: 5_000, now: () => now },
  )
  const [a, b] = await Promise.all([c.get(), c.get()])
  assert.equal(calls, 1, 'concurrent misses coalesce')
  assert.deepEqual(a.value, { n: 1 })
  assert.equal(b.stale, false)
  now += 10_000
  assert.equal((await c.get()).cacheAgeSec, 10)
  assert.equal(calls, 1)
  now += 25_000
  fail = true
  const s = await c.get()
  assert.equal(s.stale, true)
  assert.equal(s.upstreamError, 'HTTP 503')
  assert.equal(calls, 2)
  now += 1_000
  await c.get()
  assert.equal(calls, 2, 'no retry during error backoff')
  now += 700_000
  await assert.rejects(c.get(), UpstreamError)
  fail = false
  now += 6_000
  const ok = await c.get()
  assert.equal(ok.stale, false)
})

test('UpstreamCache: no value and failing upstream throws', async () => {
  const c = new UpstreamCache(async () => { throw new Error('timeout after 5000ms') }, { ttlMs: 1000, staleMaxMs: 1000 })
  await assert.rejects(c.get(), /timeout after 5000ms/)
})

test('FixedWindowLimiter: per key budget and reset', () => {
  let now = 0
  const l = new FixedWindowLimiter(2, 60_000, () => now)
  assert.equal(l.hit('a').allowed, true)
  const second = l.hit('a')
  assert.equal(second.allowed, true)
  assert.equal(second.remaining, 0)
  const third = l.hit('a')
  assert.equal(third.allowed, false)
  assert.equal(third.resetSec, 60)
  assert.equal(l.hit('b').allowed, true)
  now += 60_000
  assert.equal(l.hit('a').allowed, true)
})
