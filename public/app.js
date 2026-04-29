/* SPDX-License-Identifier: MIT
 *
 * Plumbline / Calibration Faucet front-end controller.
 *
 * One Turnstile widget for the whole page, rendered above the asset
 * panels. Both buttons stay disabled until the captcha resolves; on
 * each successful submit the captcha resets so the next one re-locks
 * the buttons until re-solved (Turnstile tokens are single-use).
 */

const $ = (id) => document.getElementById(id)
const filfox = (tx) => `https://calibration.filfox.info/en/message/${tx}?t=1`

const fmtSec = (s) => {
  if (s >= 86400) return `${Math.round(s / 86400)}h`
  if (s >= 3600)  return `${Math.round(s / 3600)}h`
  if (s >= 60)    return `${Math.round(s / 60)}m`
  return `${s}s`
}
const fmtNum = (n) => {
  const num = Number(n)
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B'
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M'
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K'
  return num.toLocaleString()
}
const fmtAge = (unix) => {
  const s = Math.floor(Date.now() / 1000) - unix
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
const truncAddr = (a) => a.length > 24 ? `${a.slice(0,8)}…${a.slice(-6)}` : a
const truncTx   = (tx) => `${tx.slice(0,10)}…${tx.slice(-6)}`

let info = null
let captchaToken = ''
let captchaWidgetId = null
let captchaSolved = false

/* ── Captcha gate ─────────────────────────────────────────────────── */
function setUnlocked(on) {
  captchaSolved = on
  $('captcha-section').classList.toggle('solved', on)
  document.querySelectorAll('button.primary').forEach((b) => {
    b.disabled = !on
    if (on) {
      const asset = b.classList.contains('fil-btn') ? 'tFIL' : 'USDFC'
      b.textContent = `Send ${asset}`
    } else {
      b.textContent = 'Solve captcha to unlock'
    }
  })
}

function renderCaptcha(siteKey) {
  if (!siteKey) {
    // Local dev: pretend captcha is solved.
    setUnlocked(true)
    return
  }
  const draw = () => {
    captchaWidgetId = window.turnstile.render('#captcha-mount', {
      sitekey: siteKey,
      callback: (t) => {
        captchaToken = t
        setUnlocked(true)
      },
      'error-callback':   () => { captchaToken = ''; setUnlocked(false) },
      'expired-callback': () => { captchaToken = ''; setUnlocked(false) },
      theme: 'dark',
    })
  }
  if (window.turnstile) draw()
  else window.addEventListener('load', () => setTimeout(draw, 80))
}

/* ── Modal ────────────────────────────────────────────────────────── */
const modal = {
  open(asset, recipient) {
    $('modal').hidden = false
    $('modal-icon').className = 'modal-icon'
    $('modal-icon').innerHTML = '<div class="spinner"></div>'
    $('modal-title').textContent = `Sending ${asset === 'fil' ? 'tFIL' : 'USDFC'}…`
    $('modal-text').textContent = 'Submitting transaction to Filecoin Calibration. This usually takes ~30 seconds.'
    $('modal-details').hidden = true
    $('md-asset').textContent = asset === 'fil' ? 'tFIL' : 'USDFC'
    $('md-amount').textContent = '—'
    $('md-recipient').textContent = recipient
    $('md-tx').textContent = '—'
    $('md-filfox').textContent = '—'
    $('md-verified').textContent = '—'
    $('md-verified').className = ''
    $('modal-close').disabled = true
  },
  done(asset, amount, recipient, txHash, verified) {
    const ok = verified
    $('modal-icon').className = `modal-icon ${ok ? 'success' : 'error'}`
    $('modal-icon').innerHTML = ok
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="color:#4ade80"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="color:#f87171"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    $('modal-title').textContent = ok ? 'Drip complete' : 'Drip submitted (verification mismatch)'
    $('modal-text').textContent = ok
      ? `${fmtNum(amount)} ${asset === 'fil' ? 'tFIL' : 'USDFC'} landed in the recipient's wallet.`
      : 'Transaction was included but the recipient balance did not move by the expected amount. Check the tx on filfox.'
    $('modal-details').hidden = false
    $('md-amount').textContent = `${fmtNum(amount)} ${asset === 'fil' ? 'tFIL' : 'USDFC'}`
    $('md-tx').innerHTML = `<a href="${filfox(txHash)}" target="_blank" rel="noopener">${truncTx(txHash)}</a>`
    $('md-filfox').innerHTML = `<a href="${filfox(txHash)}" target="_blank" rel="noopener">view ↗</a>`
    $('md-verified').textContent = ok ? '✓ confirmed' : '✗ mismatch'
    $('md-verified').className = ok ? 'ok' : 'err'
    $('modal-close').disabled = false
  },
  error(asset, recipient, message) {
    $('modal-icon').className = 'modal-icon error'
    $('modal-icon').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="color:#f87171"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    $('modal-title').textContent = 'Drip failed'
    $('modal-text').innerHTML = message
    $('modal-details').hidden = true
    $('modal-close').disabled = false
  },
  close() { $('modal').hidden = true },
}
$('modal-close').addEventListener('click', () => modal.close())
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal-close').disabled) modal.close()
})

/* ── Loaders ──────────────────────────────────────────────────────── */
async function loadInfo() {
  try {
    const res = await fetch('/api/info', { cache: 'no-store' })
    info = await res.json()
    $('m-fil').textContent   = `${fmtNum(info.filDrip)} per drip`
    $('m-usdfc').textContent = `${fmtNum(info.usdfcDrip)} per drip`
    const dispShort = `${info.dispenser.slice(0,8)}…${info.dispenser.slice(-6)}`
    $('dispenser-link').innerHTML =
      `dispenser: <a href="https://calibration.filfox.info/en/address/${info.dispenser}" target="_blank" rel="noopener">${dispShort}</a>`
    if (info.brandUrl) $('brand-link').innerHTML = `<a href="${info.brandUrl}">${info.brand}</a>`
    else $('brand-link').textContent = info.brand
    if (captchaWidgetId === null) renderCaptcha(info.turnstileSiteKey)

    const filWhole   = Number(BigInt(info.filBalanceWei)   / 10n**18n)
    const usdfcWhole = Number(BigInt(info.usdfcBalanceWei) / 10n**18n)
    $('b-fil').textContent   = fmtNum(filWhole)   + ' tFIL'
    $('b-usdfc').textContent = fmtNum(usdfcWhole) + ' USDFC'

    const filDripsLeft   = Math.max(0, Math.floor((filWhole   - Number(info.minReserveFil))   / Number(info.filDrip)))
    const usdfcDripsLeft = Math.max(0, Math.floor((usdfcWhole - Number(info.minReserveUsdfc)) / Number(info.usdfcDrip)))
    const barFil   = Math.min(100, filDripsLeft   * 10)
    const barUsdfc = Math.min(100, usdfcDripsLeft * 10)
    $('meter-fil').querySelector('div').style.width   = barFil + '%'
    $('meter-usdfc').querySelector('div').style.width = barUsdfc + '%'
    $('meter-fil').className   = 'meter' + (barFil   < 20 ? ' err' : barFil   < 50 ? ' warn' : '')
    $('meter-usdfc').className = 'meter' + (barUsdfc < 20 ? ' err' : barUsdfc < 50 ? ' warn' : '')
  } catch {}
}
async function loadRecent() {
  try {
    const res = await fetch('/api/recent?limit=10', { cache: 'no-store' })
    const { drips } = await res.json()
    const tbody = $('recent-body')
    if (!drips || drips.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty">No drips yet — be the first ✨</td></tr>`
      return
    }
    tbody.innerHTML = drips.map((d) => `
      <tr>
        <td class="muted">${fmtAge(d.unix)}</td>
        <td><span class="asset-tag ${d.asset}">${d.asset === 'fil' ? 'tFIL' : 'USDFC'}</span></td>
        <td><a href="https://calibration.filfox.info/en/address/${d.address}" target="_blank" rel="noopener">${truncAddr(d.address)}</a></td>
        <td><a href="${filfox(d.tx)}" target="_blank" rel="noopener">${truncTx(d.tx)}</a></td>
      </tr>
    `).join('')
  } catch {}
}
const refresh = () => { loadInfo(); loadRecent() }

/* ── Drip submit ──────────────────────────────────────────────────── */
document.querySelectorAll('form[data-asset]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const asset = form.dataset.asset
    const input = form.querySelector('input[type="text"]')
    const recipient = input.value.trim()

    if (info?.turnstileSiteKey && !captchaToken) {
      modal.open(asset, recipient)
      modal.error(asset, recipient, 'Please solve the captcha at the top of the page first, then submit.')
      return
    }

    document.querySelectorAll('button.primary').forEach((b) => (b.disabled = true))
    modal.open(asset, recipient)

    try {
      const res = await fetch(`/api/drip/${asset}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: recipient, turnstileToken: captchaToken }),
      })
      const data = await res.json()
      if (data.ok) {
        modal.done(asset, data.amount, recipient, data.txHash, data.verified)
        input.value = ''
        setTimeout(refresh, 800)
      } else if (data.error === 'ip_rate_limited' || data.error === 'address_rate_limited') {
        modal.error(asset, recipient, `Rate limited. Try again in <strong>${fmtSec(data.retryAfterSec)}</strong>.`)
      } else if (data.error === 'faucet_dry') {
        modal.error(asset, recipient, 'Faucet temporarily out of funds. Refilling shortly.')
      } else if (data.error === 'captcha') {
        modal.error(asset, recipient, `Captcha verification failed (<code>${data.reason}</code>). Re-solve and retry.`)
      } else if (data.error === 'native_filecoin_address_not_supported') {
        modal.error(asset, recipient, data.reason)
      } else if (data.error === 'invalid_address') {
        modal.error(asset, recipient, `That doesn't look like a valid address (<code>${data.reason}</code>).`)
      } else {
        modal.error(asset, recipient, `Error: <code>${data.error}</code>${data.reason ? ` — ${data.reason}` : ''}`)
      }
    } catch (err) {
      modal.error(asset, recipient, `Network error: ${err.message}`)
    } finally {
      // Captcha tokens are single-use; reset so the next request re-locks.
      captchaToken = ''
      if (captchaWidgetId !== null && window.turnstile) {
        window.turnstile.reset(captchaWidgetId)
      }
      setUnlocked(false)
    }
  })
})

/* ── Address converter ────────────────────────────────────────────── */
$('converter-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const input = $('conv-input')
  const out = $('conv-output')
  const addr = input.value.trim()
  if (!addr) return
  out.innerHTML = `<span class="lbl">Converting…</span>`
  try {
    const res = await fetch(`/api/convert?address=${encodeURIComponent(addr)}`, { cache: 'no-store' })
    const data = await res.json()
    if (data.ok) {
      const lbl = addr.startsWith('0x') ? 'Filecoin' : 'Ethereum'
      out.innerHTML = `<span class="lbl">${lbl}:</span><code>${data.output}</code><button class="copy" data-val="${data.output}" type="button">copy</button>`
    } else if (data.error === 'native_filecoin_no_eth_form') {
      out.innerHTML = `<span class="err">Native Filecoin addresses (t1/t3/t0) do not have a 0x form.</span>`
    } else if (data.error === 'invalid_address') {
      out.innerHTML = `<span class="err">Not a recognized address. Expected 0x or t410f.</span>`
    } else {
      out.innerHTML = `<span class="err">${data.error}${data.reason ? ` — ${data.reason}` : ''}</span>`
    }
  } catch (err) {
    out.innerHTML = `<span class="err">Network error: ${err.message}</span>`
  }
})

// Copy button delegation
$('conv-output').addEventListener('click', (e) => {
  if (e.target.classList?.contains('copy')) {
    navigator.clipboard?.writeText(e.target.dataset.val)
    const orig = e.target.textContent
    e.target.textContent = 'copied'
    setTimeout(() => { e.target.textContent = orig }, 1200)
  }
})

refresh()
setInterval(refresh, 20000)
