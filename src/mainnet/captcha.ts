// SPDX-License-Identifier: MIT
//
// Cloudflare Turnstile verification for the mainnet preview. Unlike the
// calibration helper there is no "secret not set" bypass: config
// loading refuses to start without a secret. The expected action
// (default "mainnet-drip") stops tokens minted by the calibration
// widget from being replayed here when both share a site key.

export type CaptchaVerifier = (token: string, remoteIp: string) => Promise<{ ok: true } | { ok: false; reason: string }>

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export function turnstileVerifier(secret: string, expectedAction: string): CaptchaVerifier {
  return async (token, remoteIp) => {
    if (!token) return { ok: false, reason: 'missing_token' }
    let res: Response
    try {
      res = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token, remoteip: remoteIp }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      return { ok: false, reason: `turnstile_unreachable: ${String(err)}` }
    }
    if (!res.ok) return { ok: false, reason: `turnstile_http_${res.status}` }
    const data = (await res.json()) as { success: boolean; action?: string; 'error-codes'?: string[] }
    if (!data.success) return { ok: false, reason: `turnstile_${(data['error-codes'] ?? []).join(',') || 'unknown'}` }
    if (expectedAction && data.action !== expectedAction) {
      return { ok: false, reason: `turnstile_action_mismatch` }
    }
    return { ok: true }
  }
}
