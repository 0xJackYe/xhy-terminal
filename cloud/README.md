# Cloud deployment

The production terminal runs in `xhy-terminal`, a Cloudflare Worker with Static
Assets, D1 and a one-minute scheduled task. It does not need the Windows PC to
remain on. The short `x-5tv.pages.dev` address is a Pages service-binding proxy
to the same Worker, so a Worker release updates both addresses immediately.

## GitHub deployment

Cloudflare Workers Builds watches `0xJackYe/xhy-terminal`, production branch
`main`, root directory `cloud`. Configure:

- Build: `npm test && npm run build` (automatic dependency installation enabled)
- Deploy: `npx wrangler deploy`
- Node: `22.12.0` via `.node-version`
- Preview branch deployments: disabled

`npm test` first builds the assets, then runs the isolated tests. Tests use
mock providers and SMTP sockets; they do not call a real model, send email,
trade, or alter a real diary. A failed build does not publish a new version.
`GET /api/health` reports the exact source commit baked into the deployment.

Diary state, undo history, alert deduplication and the full cost ledger are in
D1, outside the static build. A code deployment does not run a migration or
overwrite that state. Runtime secrets are Worker secrets and remain separate
from the browser assets and build settings.

## Local development and first-time migration

Run `npm ci`, then `npm test` in this directory. `npm run build` produces only
public frontend assets in `dist/` and the generated public template module.

The Windows-only preparation scripts read the original stores without starting
services or changing the originals:

```powershell
python prepare-migration.py --diet 'D:\path\to\Diet' --bitcoin 'D:\path\to\options'
node finalize-migration.mjs
python verify-migration.py
```

All generated private material stays in the ignored `.local/` directory. The
initial SQL is for a new, empty database only; do not rerun it over production.
Existing access, session and encryption secrets are reused when preparing an
export again. Do not commit or copy private runtime data into `dist/`.

To publish the stable Pages proxy separately, run the Pages deploy command from
`alias-deploy/`; its `BACKEND` binding points at the production Worker. The
proxy contains no account credentials or diary data.

## Data freshness

The scheduled task refreshes holdings and moving-average cost every minute.
Daily buys are appended idempotently to the imported complete cost book. The
long-term unrealized return uses the remaining moving-average cost; it does
not report realized trading profits. Public market monitoring refreshes every
five seconds while open and every minute in the background. Provider failures
retain the last verified snapshot with a stale state.

The legacy cash-flow-adjusted 1/7/30/90-day price-change figures retain their
verified historical interval until the complete non-spot flow reader is
ported; they are never relabeled as a new calculation. This is separate from
the continuously refreshed long-term cost and unrealized return.

Login uses the private owner access code and a signed seven-day HttpOnly
cookie. `/api/cloud-diagnostics` is owner-only and checks fixed provider
endpoints and read-only permissions without returning credentials. Browser
audio needs an open page and the browser's normal audio permission; background
notifications use the configured SMTP outbox.
