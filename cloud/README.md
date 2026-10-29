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

## Annualized historical returns

`GET /btc/api/wallet/annualized` uses the same owner session as the wallet.
Its two values are in USDT and represent historical estimates, not an interest
rate promised by an exchange.

- BTC: remaining-position XIRR. Each historical sale reduces the original
  purchase cohorts proportionally, retaining their purchase dates. Their
  remaining cost is reconciled to the existing moving-average cost book.
  Daily buys update these cohorts with the cost book; realized sale proceeds
  are excluded. Calendar-year figures retrospectively describe those same
  current cohorts, using confirmed UTC+8 year-end candles.
- Total portfolio: money-weighted XIRR of the recovered external C2C flows
  and current portfolio value. Internal transfers and crypto-to-crypto trades
  are not additional external investments. The scope and any original-order
  conversion estimates remain explicit. A same-snapshot BTC-USDT/BTC-USD
  cross quote converts the existing USD valuation to USDT.

Both methods group cash-flow dates by Beijing calendar day and use a 365-day
year. Multiple or non-verifiably unique XIRR roots produce an unavailable
value. A failed provider read retains a dated, explicitly stale result.
Missing historical total-portfolio valuations produce empty annual rows;
current holdings are never used to invent past portfolio composition.

The private initial derived-state exports and cash-flow audit stay in
`.local/`. `prepare-annualized.mjs` prepares a CAS-guarded seed from private
D1 exports and confirmed public year-boundary prices. Deployments do not run
that script or overwrite the ledger. The scheduled task checks new C2C flows
every 15 minutes, with duplicate and account-change protection; a newly seen
non-USDT C2C purchase with an unknown original cost requires review instead
of being counted as zero-cost capital.
# 快速出境

`/#travel` embeds a compact flight planner. Owner-authenticated endpoints are
`GET/POST /api/travel/config` and `POST /api/travel/search`. The settings form stores
a RapidAPI AeroDataBox key encrypted in D1 using the existing
`CONFIG_ENCRYPTION_KEY`; it never returns the key. An `AERODATABOX_API_KEY` Worker
secret is also supported. Location/passport defaults are encrypted owner data,
not source-code constants. Browser geolocation is optional and stays in the page.

The adapter reads departure boards with `withLeg=true`; every request covers at
most 12 hours. It uses fixed provider hosts, refuses redirects, and returns
schedule-only records. It does not provide ticket inventory, guarantee boarding,
or buy tickets. The planner adds preparation, manually entered ground travel, and
the user's international-airport arrival buffer to the scheduled departure time.
Unknown traffic or arrival times remain unknown. Mainland China destinations,
cancelled/departed flights and unverified legs are excluded. Passport policies
are dated official references and must be rechecked before travel; Korea's Jeju
exception is not applied to the whole country.

Queries are manual, with a 15-minute airport/window cache and a shared request
lock. There is no scheduled flight polling. The local UTC-calendar monthly cap
is 180 airport calls (approximately 360 AeroDataBox units at 2 units per call).
This is not the provider's billing-cycle meter; other uses of the same key and
remaining provider quota must be checked in the provider account. Rate limits
and authentication failures stop remaining airport calls. Results explicitly
show the 12-hour coverage window, incomplete coverage and unconfirmed seats.
Missing credentials return an empty list and real airline links, never demo data.
