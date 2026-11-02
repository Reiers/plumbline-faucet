# Changelog

All notable changes to plumbline-faucet. The builder API follows the
stability promise in [`docs/api-v1.md`](docs/api-v1.md): additive only
within v1, breaking changes only in `/api/v2`, and at least 90 days of
`Deprecation`/`Sunset` headers before anything is retired.

## Unreleased

### Added

- **Builder API v1** under `/api/v1`. Stable, versioned, read-only, no auth
  for reads. Reference: [`docs/api-v1.md`](docs/api-v1.md).
  - `GET /api/v1`: endpoint index.
  - `GET /api/v1/faucet/status`: healthy flag, dispenser, balances, reserve
    floors, drip amounts, public limits.
  - `GET /api/v1/faucet/drips`: recent drips with amount, tx and explorer
    link, paginated.
  - `GET /api/v1/network`: Calibration health from Calix, cached 30s, with
    `source` and `fetchedAt`.
  - `GET /api/v1/sp`: SP test-target status (t0143103) from Calix.
  - `GET /api/v1/openapi.json`: OpenAPI 3.1 description.
  - `POST /api/v1/drip/fil` and `POST /api/v1/drip/usdfc`: stable aliases of
    the existing drip routes with identical auth and limits.
  - `apiVersion` field and `X-API-Version` header, CORS `*`, 60 reads per
    minute per IP with `RateLimit-*` headers, one JSON error envelope.
  - Stale Calix data served for up to 10 minutes on upstream failure, then
    `502 upstream_unavailable`.
- `scripts/plumbline-cli`: bash client for the v1 read endpoints
  (`status`, `network`, `sp`, `drips`).
- `pnpm test` suite and a GitHub Actions workflow running typecheck and
  tests on pull requests.
- `recent_drips.amount_wei` column (added automatically on start; older
  rows report `amount: null`).

### Fixed

- **Drips to unspendable addresses.** Every drip path (`/api/drip/*`,
  `/api/v1/drip/*`, `/api/public/drip/*`, `/api/claim_token_all`) now
  answers `400 unspendable_address` for the zero address (also as
  t410f/f410f), Ethereum and Filecoin precompiles, masked ID addresses
  (`0xff00...`), `0x...dEaD` and built-in actors `t00` to `t099`. The
  check runs before captcha and rate limits, so refused requests cost no
  quota. In October 2026 two public drips of 1000 tFIL each went to the
  zero address through `/api/public/drip/fil` and `/api/claim_token_all`.
