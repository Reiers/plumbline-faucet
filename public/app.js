/* SPDX-License-Identifier: MIT
 *
 * Plumb / Calibration Faucet front-end controller.
 *
 * Two independent drip flows (tFIL, USDFC). Each form has its own
 * Turnstile widget, rendered explicitly so we never end up with two
 * widgets in the same container. A modal walks the user through
 * "Sending… → tx submitted → on-chain verified → done" with a filfox
 * link, then unlocks the close button only when the chain confirms.
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
const truncAddr = (a) => `${a.slice(0,6)}…${a.slice(-4)}`
const truncTx   = (tx) => `${tx.slice(0,10)}…${tx.slice(-6)}`

let info = null
const widgetIds = { fil: null, usdfc: null }
const widgetTokens = { fil: '', usdfc: '' }

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
  showProgress(asset, recipient, txHash) {
    $('modal-text').textContent = 'Transaction submitted. Waiting for inclusion + on-chain balance verification…'
    $('modal-details').hidden = false
    $('md-tx').innerHTML = `<a href="${filfox(txHash)}" target="_blank" rel="noopener">${truncTx(txHash)}</a>`
    $('md-filfox').innerHTML = `<a href="${filfox(txHash)}" target="_blank" rel="noopener">view ↗</a>`
  },
  done(asset, amount, recipient, txHash, verified) {
    const ok = verified
    $('modal-icon').className = `modal-icon ${ok ? 'success' : 'error'}`
    $('modal-icon').innerHTML = ok
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="color:#4ade80"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="color:#f87171"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
    $('modal-title').textContent = ok ? 'Drip complete' : 'Drip submitted (verification mismatch)'
    $('modal-text').textContent = ok
      ? `${fmtNum(amount)} ${asset === 'fil' ? 'tFIL' : 'USDFC'} landed in ${truncAddr(recipient)}.`
      : 'The transaction was included but the recipient balance did not move by the expected amount. Check the tx on filfox.'
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
  close() {
    $('modal').hidden = true
  },
}

$('modal-close').addEventListener('click', () => modal.close())
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal-close').disabled) modal.close()
})

/* ── Turnstile ────────────────────────────────────────────────────── */
function renderCaptchas(siteKey) {
  if (!siteKey) return
  const draw = () => {
    document.querySelectorAll('.captcha-mount').forEach((el) => {
      const asset = el.dataset.mount
      if (widgetIds[asset] !== null) return
      widgetIds[asset] = window.turnstile.render(el, {
        sitekey: siteKey,
        callback: (t)            => { widgetTokens[asset] = t },
        'error-callback':   ()   => { widgetTokens[asset] = '' },
        'expired-callback': ()   => { widgetTokens[asset] = '' },
        theme: 'dark',
      })
    })
  }
  if (window.turnstile) draw()
  else window.addEventListener('load', () => setTimeout(draw, 80))
}

/* ── Info loaders ─────────────────────────────────────────────────── */
async function loadInfo() {
  try {
    const res = await fetch('/api/info', { cache: 'no-store' })
    info = await res.json()
    $('m-fil').textContent = fmtNum(info.filDrip)
    $('m-usdfc').textContent = fmtNum(info.usdfcDrip)
    const dispShort = `${info.dispenser.slice(0,8)}…${info.dispenser.slice(-6)}`
    $('dispenser-link').innerHTML =
      `dispenser: <a href="https://calibration.filfox.info/en/address/${info.dispenser}" target="_blank" rel="noopener">${dispShort}</a>`
    if (info.brandUrl) {
      $('brand-link').innerHTML = `<a href="${info.brandUrl}">${info.brand}</a>`
    } else {
      $('brand-link').textContent = info.brand
    }
    renderCaptchas(info.turnstileSiteKey)

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

/* ── Submit handlers ──────────────────────────────────────────────── */
document.querySelectorAll('form[data-asset]').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const asset = form.dataset.asset
    const input = form.querySelector('input[type="text"]')
    const btn   = form.querySelector('button[type="submit"]')
    const recipient = input.value.trim()

    if (info?.turnstileSiteKey && !widgetTokens[asset]) {
      modal.error(asset, recipient, 'Please complete the captcha first, then resubmit.')
      modal.open(asset, recipient)
      $('modal-close').disabled = false
      return
    }

    btn.disabled = true
    modal.open(asset, recipient)

    try {
      const res = await fetch(`/api/drip/${asset}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: recipient, turnstileToken: widgetTokens[asset] }),
      })
      const data = await res.json()
      if (data.ok) {
        modal.showProgress(asset, recipient, data.txHash)
        // The server already awaited the receipt + verified balance before
        // returning, so we can render the final state immediately.
        modal.done(asset, data.amount, recipient, data.txHash, data.verified)
        input.value = ''
        setTimeout(refresh, 800)
      } else if (data.error === 'ip_rate_limited' || data.error === 'address_rate_limited') {
        modal.error(asset, recipient, `Rate limited. Try again in <strong>${fmtSec(data.retryAfterSec)}</strong>.`)
      } else if (data.error === 'faucet_dry') {
        modal.error(asset, recipient, 'Faucet temporarily out of funds. Refilling shortly — try again in a few minutes.')
      } else if (data.error === 'captcha') {
        modal.error(asset, recipient, `Captcha verification failed (<code>${data.reason}</code>). Please retry.`)
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
      btn.disabled = false
      if (widgetIds[asset] !== null && window.turnstile) {
        window.turnstile.reset(widgetIds[asset])
      }
      widgetTokens[asset] = ''
    }
  })
})

refresh()
setInterval(refresh, 20000)
