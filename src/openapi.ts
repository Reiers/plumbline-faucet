// SPDX-License-Identifier: MIT
//
// OpenAPI 3.1 description of the Plumbline builder API v1.
// Served at GET /api/v1/openapi.json. Keep in sync with src/api-v1.ts;
// test/api-v1.test.ts checks that every route is described.

import type { FaucetConfig } from './config.js'

const ref = (name: string) => ({ $ref: '#/components/schemas/' + name })
const nullable = (type: string) => ({ type: [type, 'null'] })

const rateLimitHeaders = {
  'RateLimit-Limit': { description: 'Read requests allowed per window.', schema: { type: 'integer' } },
  'RateLimit-Remaining': { description: 'Read requests left in the current window.', schema: { type: 'integer' } },
  'RateLimit-Reset': { description: 'Seconds until the window resets.', schema: { type: 'integer' } },
  'RateLimit-Policy': { description: 'Policy, for example "60;w=60".', schema: { type: 'string' } },
}

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: ref('Error') } },
})

const okJson = (schema: string, description: string) => ({
  description,
  headers: rateLimitHeaders,
  content: { 'application/json': { schema: ref(schema) } },
})

const readErrors = {
  '429': {
    ...errorResponse('Per-IP read budget exhausted. See Retry-After.'),
    headers: { ...rateLimitHeaders, 'Retry-After': { schema: { type: 'integer' } } },
  },
}

const upstreamErrors = {
  ...readErrors,
  '502': errorResponse('Calix did not answer and no cached value younger than the stale limit exists.'),
}

const signal = {
  type: ['object', 'null'],
  properties: {
    value: nullable('number'),
    unit: nullable('string'),
    status: { type: ['string', 'null'], description: 'ok, watch or bad as reported by Calix.' },
  },
}

const freshness = {
  fetchedAt: { type: 'string', format: 'date-time', description: 'When the data was fetched from its source.' },
  cacheAgeSec: { type: 'integer' },
  stale: { type: 'boolean', description: 'True when the source is failing and this is the last good value.' },
  upstreamError: { type: 'string', description: 'Present when stale is true.' },
}

const window = {
  type: 'object',
  required: ['max', 'windowSec'],
  properties: { max: { type: 'integer' }, windowSec: { type: 'integer' } },
}

const assetStatus = {
  type: 'object',
  required: ['symbol', 'decimals', 'balance', 'balanceWei', 'reserveFloor', 'reserveFloorWei', 'dripAmount', 'publicDripAmount', 'canDrip'],
  properties: {
    symbol: { type: 'string' },
    decimals: { type: 'integer' },
    contract: { type: 'string', description: 'ERC-20 contract (USDFC only).' },
    balance: { type: ['string', 'null'], description: 'Dispenser balance, decimal string. Null when RPC is unreachable.' },
    balanceWei: { type: ['string', 'null'] },
    reserveFloor: { type: 'string', description: 'Configured reserve floor. Drips stop below floor + one drip.' },
    reserveFloorWei: { type: 'string' },
    dripAmount: { type: 'string', description: 'Amount per captcha or API-key drip.' },
    publicDripAmount: { type: 'string', description: 'Amount per anonymous public drip.' },
    canDrip: { type: 'boolean' },
  },
}

const dripRequest = {
  type: 'object',
  required: ['address'],
  properties: {
    address: { type: 'string', minLength: 3, maxLength: 120, description: '0x, t410f, or (tFIL only) t0/t1/t3 address.' },
    turnstileToken: { type: 'string', description: 'Cloudflare Turnstile token. Not needed with an API key.' },
  },
}

const dripPost = (asset: 'fil' | 'usdfc') => ({
  post: {
    operationId: asset === 'fil' ? 'dripFil' : 'dripUsdfc',
    summary: asset === 'fil' ? 'Request a tFIL drip' : 'Request a USDFC drip (0x or t410f only)',
    description:
      'Stable alias of POST /api/drip/' + asset + '. Same handler, same captcha, API-key and rate-limit rules. ' +
      'Send a Turnstile token in the body, or an API key as Authorization: Bearer <key> or X-API-Key.',
    tags: ['drip'],
    security: [{}, { bearerKey: [] }, { headerKey: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: dripRequest } } },
    responses: {
      '200': { description: 'Drip sent and confirmed on chain.', content: { 'application/json': { schema: ref('DripResult') } } },
      '400': errorResponse('bad_request, invalid_address, usdfc_native_unsupported or captcha.'),
      '401': errorResponse('invalid_api_key or revoked_api_key.'),
      '429': errorResponse('ip_rate_limited, address_rate_limited, api_key_rate_limited or rate_limited. Body includes retryAfterSec and retryAtUnix.'),
      '500': errorResponse('drip_failed.'),
      '503': errorResponse('faucet_dry: dispenser below reserve floor.'),
    },
  },
})

export function buildOpenApi(cfg: FaucetConfig): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Plumbline builder API',
      version: '1.0.0',
      summary: 'Read-only status API and drip endpoints for the Plumbline Filecoin Calibration faucet.',
      description:
        'Versioned JSON API. Read endpoints need no auth and are rate limited per IP (' +
        cfg.API_V1_GET_RATE_LIMIT + ' requests per minute). Every response carries apiVersion "1" and ' +
        'Access-Control-Allow-Origin: *. Errors use one envelope: { apiVersion, ok: false, error, message }. ' +
        'Within v1, fields are only ever added; breaking changes ship as /api/v2.',
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: cfg.BRAND_URL || '/' }],
    'x-apiVersion': '1',
    tags: [
      { name: 'meta', description: 'Index and API description.' },
      { name: 'faucet', description: 'Dispenser status and recent drips.' },
      { name: 'network', description: 'Calibration network and SP test-target health, sourced from Calix.' },
      { name: 'drip', description: 'Request tFIL or USDFC. Captcha token or API key required.' },
    ],
    paths: {
      '/api/v1': {
        get: {
          operationId: 'getIndex',
          security: [],
          summary: 'List v1 endpoints',
          tags: ['meta'],
          responses: { '200': okJson('Index', 'Endpoint index.'), ...readErrors },
        },
      },
      '/api/v1/faucet/status': {
        get: {
          operationId: 'getFaucetStatus',
          security: [],
          summary: 'Dispenser health, balances, reserve floors, drip amounts and limits',
          description: 'Balances are cached for ' + cfg.FAUCET_STATUS_CACHE_SEC + 's. If the RPC is unreachable the endpoint still answers 200 with rpcOk false, healthy false and null balances.',
          tags: ['faucet'],
          responses: { '200': okJson('FaucetStatus', 'Faucet status.'), ...readErrors },
        },
      },
      '/api/v1/faucet/drips': {
        get: {
          operationId: 'getFaucetDrips',
          security: [],
          summary: 'Recent drips, newest first',
          description: 'The server keeps the last 50 drips. amount is null for drips recorded before per-drip amounts were stored.',
          tags: ['faucet'],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 50, default: 0 } },
          ],
          responses: {
            '200': okJson('DripList', 'Recent drips.'),
            '400': errorResponse('Invalid limit or offset.'),
            ...readErrors,
          },
        },
      },
      '/api/v1/network': {
        get: {
          operationId: 'getNetwork',
          security: [],
          summary: 'Calibration network health',
          description: 'Aggregated from Calix /api/v1/status and /api/v1/signals. Cached ' + cfg.UPSTREAM_CACHE_SEC + 's server side. If Calix fails, the last good value is served with stale true for up to ' + cfg.UPSTREAM_STALE_MAX_SEC + 's, then 502.',
          tags: ['network'],
          responses: { '200': okJson('Network', 'Network health.'), ...upstreamErrors },
        },
      },
      '/api/v1/sp': {
        get: {
          operationId: 'getSp',
          security: [],
          summary: 'SP test-target status',
          description: 'From Calix /api/v1/miners/status for ' + cfg.SP_TARGETS.join(', ') + '. Same caching and failure rules as /api/v1/network.',
          tags: ['network'],
          responses: { '200': okJson('Sp', 'SP test-target status.'), ...upstreamErrors },
        },
      },
      '/api/v1/openapi.json': {
        get: {
          operationId: 'getOpenApi',
          security: [],
          summary: 'This document',
          tags: ['meta'],
          responses: { '200': { description: 'OpenAPI 3.1 document.', content: { 'application/json': { schema: { type: 'object' } } } }, ...readErrors },
        },
      },
      '/api/v1/drip/fil': dripPost('fil'),
      '/api/v1/drip/usdfc': dripPost('usdfc'),
    },
    components: {
      securitySchemes: {
        bearerKey: { type: 'http', scheme: 'bearer', description: 'Operator-issued API key. Optional; replaces captcha.' },
        headerKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['apiVersion', 'ok', 'error', 'message'],
          properties: {
            apiVersion: { const: '1' },
            ok: { const: false },
            error: { type: 'string', description: 'Machine-readable code, for example rate_limited or upstream_unavailable.' },
            message: { type: 'string' },
            retryAfterSec: { type: 'integer' },
          },
          additionalProperties: true,
        },
        Index: {
          type: 'object',
          required: ['apiVersion', 'ok', 'endpoints'],
          properties: {
            apiVersion: { const: '1' },
            ok: { const: true },
            name: { type: 'string' },
            network: { const: 'calibration' },
            docs: { type: 'string' },
            openapi: { type: 'string' },
            stability: { type: 'string' },
            rateLimit: { type: 'object' },
            endpoints: {
              type: 'array',
              items: {
                type: 'object',
                required: ['method', 'path', 'description'],
                properties: { method: { type: 'string' }, path: { type: 'string' }, description: { type: 'string' } },
              },
            },
          },
        },
        FaucetStatus: {
          type: 'object',
          required: ['apiVersion', 'ok', 'network', 'healthy', 'state', 'rpcOk', 'dispenser', 'assets', 'limits'],
          properties: {
            apiVersion: { const: '1' },
            ok: { const: true },
            network: { const: 'calibration' },
            chainId: { type: 'integer' },
            healthy: { type: 'boolean', description: 'RPC reachable and both assets above reserve floor + one drip.' },
            state: { enum: ['ok', 'watch', 'bad'] },
            reasons: { type: 'array', items: { enum: ['rpc_unreachable', 'fil_below_reserve', 'usdfc_below_reserve'] } },
            rpcOk: { type: 'boolean' },
            rpcError: { type: 'string' },
            dispenser: { type: 'string' },
            assets: {
              type: 'object',
              required: ['fil', 'usdfc'],
              properties: { fil: assetStatus, usdfc: assetStatus },
            },
            limits: {
              type: 'object',
              properties: {
                captcha: { type: 'object', properties: { perIp: window, perAddress: window } },
                apiKey: { type: 'object', properties: { perKey: { type: 'string' }, perAddress: window } },
                public: { type: 'object', properties: { perIp: window, perAddress: window } },
                requestsPerIpPerMinute: { type: 'integer' },
                readRequestsPerIpPerMinute: { type: 'integer' },
              },
            },
            auth: {
              type: 'object',
              properties: {
                captcha: { enum: ['turnstile', 'disabled'] },
                turnstileSiteKey: nullable('string'),
                apiKeySupported: { type: 'boolean' },
              },
            },
            drip: { type: 'object', additionalProperties: { type: 'string' } },
            stats: { type: 'object' },
            fetchedAt: { type: ['string', 'null'], format: 'date-time' },
            cacheAgeSec: freshness.cacheAgeSec,
            stale: freshness.stale,
          },
        },
        Drip: {
          type: 'object',
          required: ['time', 'unix', 'asset', 'amount', 'amountWei', 'address', 'tx', 'explorerUrl'],
          properties: {
            time: { type: 'string', format: 'date-time' },
            unix: { type: 'integer' },
            asset: { enum: ['fil', 'usdfc'] },
            amount: { type: ['string', 'null'] },
            amountWei: { type: ['string', 'null'] },
            address: { type: 'string' },
            tx: { type: 'string' },
            explorerUrl: { type: 'string' },
          },
        },
        DripList: {
          type: 'object',
          required: ['apiVersion', 'ok', 'limit', 'offset', 'total', 'nextOffset', 'drips'],
          properties: {
            apiVersion: { const: '1' },
            ok: { const: true },
            network: { const: 'calibration' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
            total: { type: 'integer' },
            nextOffset: nullable('integer'),
            retention: { type: 'integer' },
            drips: { type: 'array', items: ref('Drip') },
          },
        },
        Source: {
          type: 'object',
          required: ['name', 'url', 'endpoints'],
          properties: {
            name: { type: 'string' },
            url: { type: 'string' },
            endpoints: { type: 'array', items: { type: 'string' } },
            generatedAt: { type: ['integer', 'null'], description: 'Unix seconds reported by the source.' },
          },
        },
        Network: {
          type: 'object',
          required: ['apiVersion', 'ok', 'network', 'healthy', 'state', 'chain', 'signals', 'source', 'fetchedAt', 'stale'],
          properties: {
            apiVersion: { const: '1' },
            ok: { const: true },
            network: { const: 'calibration' },
            healthy: { type: 'boolean', description: 'False when Calix reports degraded or a fork.' },
            state: { enum: ['ok', 'watch', 'bad'] },
            level: { type: ['string', 'null'], description: 'Raw Calix level: operational, watch, upgrade or degraded.' },
            headline: nullable('string'),
            detail: nullable('string'),
            forked: nullable('boolean'),
            chain: {
              type: 'object',
              properties: { epoch: nullable('integer'), networkVersion: nullable('integer'), headAgeSeconds: nullable('number') },
            },
            upgrade: {
              type: 'object',
              properties: {
                name: nullable('string'),
                epoch: nullable('integer'),
                unix: nullable('integer'),
                secondsLeft: nullable('number'),
                activated: nullable('boolean'),
              },
            },
            signals: {
              type: 'object',
              properties: {
                windowEpochs: nullable('integer'),
                blocksPerEpoch: signal,
                nullRoundPercent: signal,
                baseFee: signal,
                winCountAvg: signal,
                networkQAP: signal,
                activeMiners: signal,
                totalPledge: signal,
                ipPerSector32GiB: signal,
              },
            },
            source: ref('Source'),
            ...freshness,
          },
        },
        Sp: {
          type: 'object',
          required: ['apiVersion', 'ok', 'network', 'healthy', 'state', 'targets', 'source', 'fetchedAt', 'stale'],
          properties: {
            apiVersion: { const: '1' },
            ok: { const: true },
            network: { const: 'calibration' },
            healthy: { type: 'boolean' },
            state: { enum: ['ok', 'watch', 'bad'] },
            epoch: nullable('integer'),
            windowEpochs: nullable('integer'),
            targets: {
              type: 'array',
              items: {
                type: 'object',
                required: ['address', 'status', 'state', 'healthy'],
                properties: {
                  address: { type: 'string' },
                  status: { type: 'string', description: 'Raw Calix status, or unknown if the miner is missing.' },
                  state: { enum: ['ok', 'watch', 'bad'] },
                  healthy: { type: 'boolean' },
                  blocksLast60: nullable('integer'),
                  lastBlockEpoch: nullable('integer'),
                  lastBlockAgeSec: nullable('number'),
                },
              },
            },
            source: ref('Source'),
            ...freshness,
          },
        },
        DripResult: {
          type: 'object',
          required: ['apiVersion', 'ok', 'txHash', 'amount', 'asset', 'verified'],
          properties: {
            apiVersion: { const: '1' },
            ok: { const: true },
            txHash: { type: 'string' },
            amount: { type: 'string' },
            asset: { enum: ['fil', 'usdfc'] },
            recipientBalanceBefore: { type: 'string' },
            recipientBalanceAfter: { type: 'string' },
            verified: { type: 'boolean', description: 'Recipient balance moved by at least the drip amount.' },
            nativeFilSend: { type: 'boolean' },
          },
        },
      },
    },
  }
}
