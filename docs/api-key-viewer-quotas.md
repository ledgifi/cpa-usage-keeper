# Cached quota visualization

LedgiFi patch base: upstream v1.15.11,
`71a41cc2d1cce8d75b42473adf31f2616ad8085e` (October 13, 2026).
The safe endpoint adapts only the quota portion of reference commit
`4504d36718bfb02bd75cdf81c6a6b8b582877e5b` from
`bjoern-sobolewski/cpa-usage-keeper`; PR #597 was closed and unmerged.

## Scope and access

Admins keep **Auth Files** (`/auth-files`), including its existing management
controls, health mode, usage metrics, pagination and provider filters. Its quota
meters now share compact countdowns, freshness and a quota-window timeline with
the API-key viewer's **Quotas** page (`/quotas`). The viewer shows the small
subscription list directly, without search, filters, sorting or pagination.
Routes respect `APP_BASE_PATH`.

Enable teammate access in the local private environment, then restart Keeper:

```dotenv
AUTH_ENABLED=true
API_KEY_VIEWER_QUOTA_ENABLED=true
API_KEY_VIEWER_LOCAL_RANKING_ENABLED=false
```

The new permission defaults off. Existing private API-key login and personal
usage stay in place. Session capability `api_key.quota_enabled` controls viewer
navigation; `GET /api/v1/quotas` independently enforces authentication, active-key
middleware and permission. Admin sessions may read this endpoint regardless of
the flag. Anonymous, expired or revoked sessions cannot read it, including when
normal admin authentication is disabled. Admin identity, config, inspection,
refresh, reset and other mutation routes remain blocked to viewers.

The endpoint selects enabled, nondeleted auth-file accounts server-side and
returns dedicated allowlisted display fields. Opaque IDs and generated labels
avoid exposing admin aliases, emails, auth indexes or file names/paths. Known
plan values are allowlisted; arbitrary plans, tiers and provider strings are
omitted. No credentials, full identities, raw provider responses/errors, request
logs or local token/cost accounting are returned. Responses use `no-store`.

## Visualization contract

- Meters show provider-defined headroom and available quantities, not personal
  teammate usage or billing. Claude/Codex window percentages preserve missing
  versus explicit zero using upstream's existing presence flags. Percentages
  never imply exact request/token limits.
- The viewer omits Gemini/Kimi numeric values and Claude extra-usage quantities:
  stock normalization loses numeric presence there. Their safe reset/freshness
  metadata can still display; Claude's optional extra-usage percentage is retained.
  These optional fields remain unknown rather than adding parser fixes. Existing
  admin provider behavior is retained.
- Countdowns use the server clock and tick each second. Relative resets,
  including zero, are anchored to the cache observation, not the read time.
  Passed resets mark the snapshot stale without assuming a refill. Timestamps
  stay inline; full times are available in accessible labels/tooltips. Viewer
  dates use browser local time; admin meters respect Keeper's selected timezone.
- Freshness follows the existing quota scheduler's next due time plus two
  minutes of queue grace. Without an enabled configured schedule, data is
  not classified against a refresh deadline; the UI shows its update age without
  a health label. Missing/invalid observation times are stale. A failed
  latest refresh is unavailable even if an older successful snapshot exists;
  upstream v1.15.11 failure semantics are preserved.
  Update age and warnings sit below account badges, outside the quota meters.
- The timeline compares **quota used** (fill edge) with **time elapsed** (Now).
  Its span is estimated as reset minus normalized window duration. This is not
  usage history or a provider pacing rule. Weekly and five-hour filters match
  exact durations; unknown durations/resets remain in All windows.
- Dashed **Projected cycle** spans repeat a known duration after the reported
  reset, without usage fill or promised refills. Only future cycles are inferred;
  an old observation never becomes an invented current cycle. Unknown windows
  have no projections. Rendering clips to the range and caps at 128 cycles/lane.
- The calendar covers fourteen inclusive local dates from Sunday; the five-hour
  view covers twelve absolute hours. Calendar ticks handle DST independently.
  Mobile scrolling stays inside the chart. Admin lanes follow the current Auth
  Files page/filter and exclude disabled/deleted accounts.
- Entry, Refresh, foreground return and visible-page polling every 60 seconds
  read cache only. Reload and timeline navigation never queue a quota task or
  contact providers. The existing administrator-controlled collector/scheduler
  remains responsible for observations. Read failures clear previous data.

No new collector, provider integration, role/password system, schema migration,
leaderboard, shared teammate charts, compatibility routes or dependencies are
added. Fable and model integrations absent from this proxy remain out of scope.
Unknown windows use generic safe labels. IDs change if database rows are recreated.
The existing memory-only cache clears on restart.

## Build and local setup

Use Go 1.26+, a C compiler/SQLite prerequisites and Node 24+:

```sh
npm --prefix web ci
npm --prefix web run build
go build -o /tmp/keeper ./cmd/server
/tmp/keeper --env /absolute/path/to/private/keeper.env
```

Use an isolated `WORK_DIR`, unused `APP_PORT` and appropriate `APP_HOST`.
For frontend development, set `VITE_API_PROXY_TARGET` to that local backend.
Keep credentials in private files, never source or chat. Use fixtures or a separate
proxy for development: a second Keeper against the production proxy can consume
its destructive usage queue and steal observations from the primary collector.

## Internal releases

Source and public image live under `ledgifi/cpa-usage-keeper`. Keep upstream
history and a small maintained patch on `main`; the `upstream` remote tracks
`Willxup/cpa-usage-keeper`. Release tags use `v<upstream>-ledgifi.<revision>`
(starting with `v1.15.11-ledgifi.1`). Use the existing Dockerfile and release
Docker workflow, targeting only `linux/amd64` for the internal Unraid host.
Binary and development publishing workflows are disabled in this fork's GitHub
settings. No additional packaging system is needed.

Pin the Unraid Keeper template to the release image digest, keeping its existing
private environment, persistent data, network and Tailscale identity. Enable
`API_KEY_VIEWER_QUOTA_ENABLED=true` in that private environment. Leave local
ranking disabled. Record the source commit, tag, digest, previous image and
protected backup location in the private operations repository. The proxy image
and configuration do not change for this feature.

## Maintenance and verification

Keep presentation changes in `web/src/components/usage/quotas/`. The existing
Auth Files component uses a small display adapter in `credentialViewModels.ts`;
`QuotasPage.tsx` reads only the safe endpoint. Backend integration is the default-off
config/session capability, route registration, `internal/api/key_quota.go`, and
freshness metadata added to the existing admin cache response. Scheduler deadline
calculation is reused. Provider parsers and types are unchanged from upstream.
Only Claude/Codex window normalization consumes existing presence flags for
missing percentages and explicit zero resets; other normalization is unchanged.

Security tests use separate viewer/admin sessions and isolated databases. They
cover default-off access, active/revoked/anonymous keys, blocked direct admin
routes, sanitization and cache-only reads. Display tests cover missing/zero values,
plans, failed/stale/no cache, absolute/relative resets, countdowns, timeline fill,
projections, range clipping, DST and both page integrations. On this 8-GB VM use
bounded workers:

```sh
TZ=UTC GOMAXPROCS=1 GOMEMLIMIT=256MiB go test -p 1 ./internal/quota/... ./internal/api/... ./internal/config/... ./internal/app/...
NODE_OPTIONS=--max-old-space-size=512 npm --prefix web run test -- --maxWorkers=1 --no-file-parallelism
npm --prefix web run typecheck
npm --prefix web run lint
RAYON_NUM_THREADS=1 NODE_OPTIONS=--max-old-space-size=512 npm --prefix web run build
GOMAXPROCS=1 go build -p 1 -o /tmp/keeper ./cmd/server
```

Browser checks should use intercepted fixture APIs and isolated roles, without
provider calls. Regression coverage is in the Go and Vitest suites. Deployment
state and private runbooks belong outside this public source repository.
