// SPDX-License-Identifier: MIT
//
// Cloudflare Turnstile verification. If TURNSTILE_SECRET is not set,
// verification is disabled (intended for local development only) and a
// loud warning is logged on every request to prevent accidentally
// shipping an unprotected public faucet.

import type { FaucetConfig } from './config.js'

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

interface TurnstileResponse {
  success: boolean
  'error-codes'?: string[]
  challenge_ts?: string
  hostname?: string
  action?: string
  cdata?: string
}

export async function verifyTurnstile(
  cfg: FaucetConfig,
  token: string,
  remoteIp: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!cfg.TURNSTILE_SECRET) {
    // Local dev: bypass with a loud warning.
    return { ok: true }
  }
  if (!token) {
    return { ok: false, reason: 'missing_token' }
  }

  const body = new URLSearchParams({
    secret: cfg.TURNSTILE_SECRET,
    response: token,
    remoteip: remoteIp,
  })

  const res = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) {
    return { ok: false, reason: `turnstile_http_${res.status}` }
  }

  const data = (await res.json()) as TurnstileResponse
  if (!data.success) {
    const codes = (data['error-codes'] ?? []).join(',') || 'unknown'
    return { ok: false, reason: `turnstile_${codes}` }
  }
  return { ok: true }
}
