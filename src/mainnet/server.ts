// SPDX-License-Identifier: MIT
//
// Mainnet preview entrypoint. Started either directly
// (`pnpm start:mainnet`) or through the shared entrypoint with
// NETWORK=mainnet (`pnpm start`), which hands off here before any
// calibration code runs.
//
// Boot is fail-closed: bad config, a wrong chain id, or a missing
// Turnstile secret stop the process before it listens.

import 'dotenv/config'
import { buildMainnetApp } from './app.js'
import { turnstileVerifier } from './captcha.js'
import { ConfigError, MAINNET_CHAIN_ID, fromMicro, loadMainnetConfig, publicPolicy } from './config.js'
import { MainnetDispenser } from './dispenser.js'
import { MainnetLedger } from './ledger.js'

export async function startMainnet(): Promise<void> {
  let cfg
  try {
    cfg = loadMainnetConfig(process.env)
  } catch (err) {
    if (err instanceof ConfigError) {
      // eslint-disable-next-line no-console
      console.error(`mainnet config error: ${err.message}`)
      process.exit(2)
    }
    throw err
  }

  const dispenser = new MainnetDispenser(cfg)
  const chainId = await dispenser.chainId()
  if (chainId !== MAINNET_CHAIN_ID) {
    // eslint-disable-next-line no-console
    console.error(`refusing to start: RPC chain id is ${chainId}, expected ${MAINNET_CHAIN_ID} (Filecoin mainnet)`)
    process.exit(2)
  }

  const ledger = new MainnetLedger(cfg.dbPath, { countSimulated: cfg.dryRun })
  const { app, state } = await buildMainnetApp({
    cfg,
    ledger,
    dispenser,
    captcha: turnstileVerifier(cfg.turnstileSecret, cfg.turnstileAction),
  })

  app.log.info(
    {
      network: 'mainnet',
      chainId,
      dispenser: dispenser.address,
      dryRun: cfg.dryRun,
      paused: state.paused(),
      usdfc: cfg.usdfcAddress,
      policy: publicPolicy(cfg),
      alertWebhook: cfg.alertWebhookUrl ? 'configured' : 'none',
    },
    'mainnet preview starting',
  )
  if (cfg.dryRun) app.log.warn('MAINNET_DRY_RUN is on: drips are simulated, nothing is broadcast')
  if (state.paused()) app.log.warn('kill switch is ON: all drips refused (mainnet preview, not yet activated; set MAINNET_KILL_SWITCH=0 to enable)')

  const stopMonitor = state.start()
  const shutdown = async (sig: string) => {
    app.log.info({ sig }, 'mainnet preview shutting down')
    stopMonitor()
    await app.close()
    ledger.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))

  await app.listen({ host: cfg.host, port: cfg.port })
  app.log.info({ floorUsdfc: fromMicro(cfg.assets.usdfc.reserveFloorMicro), floorFil: fromMicro(cfg.assets.fil.reserveFloorMicro) }, 'mainnet preview listening')
}

// Allow running this file directly.
const invokedDirectly = process.argv[1] && /mainnet[\\/]server\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  startMainnet().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err)
    process.exit(1)
  })
}
