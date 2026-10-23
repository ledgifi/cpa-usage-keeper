# Cached quota visualization

LedgiFi patch base: upstream v2.0.1,
`5604768d352a1a85dd5c087b4e85bd657a159a02` (October 23, 2026).
The original v1 release was `v1.15.11-ledgifi.1`; the v2 integration preserves
that history and merges the stable upstream tag.
The safe endpoint adapts only the quota portion of reference commit
`4504d36718bfb02bd75cdf81c6a6b8b582877e5b` from
`bjoern-sobolewski/cpa-usage-keeper`; PR #597 was closed and unmerged.

## Scope and access

Admins keep **Credentials** (`/credentials`), including its existing management
controls, health mode, usage metrics, pagination and provider filters. Its quota
meters now share compact countdowns, freshness and a quota-window timeline with
the API-key viewer's **Quotas** page (`/quotas`). The viewer shows the small
subscription list directly, without search, filters, sorting or pagination.
Routes respect `APP_BASE_PATH`.

Enable teammate access in the local private environment, then restart Keeper:

```dotenv
AUTH_ENABLED=true
API_KEY_VIEWER_QUOTA_ENABLED=true
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
  upstream v2.0.1 failure semantics are preserved.
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
  Mobile scrolling stays inside the chart. Admin lanes follow the current
  Credentials page/filter and exclude disabled/deleted accounts.
- Entry, Refresh, foreground return and visible-page polling every 60 seconds
  read cache only. Reload and timeline navigation never queue a quota task or
  contact providers. The existing administrator-controlled collector/scheduler
  remains responsible for observations. Read failures clear previous data.

The LedgiFi patch adds no collector, provider integration, role/password system,
schema migration, leaderboard, shared teammate charts, compatibility routes or
dependencies beyond upstream v2.0.1. Fable and model integrations absent from
this proxy remain out of scope.
Unknown windows use generic safe labels. IDs change if database rows are recreated.
The existing memory-only cache clears on restart.

## Build and local setup

Use Go 1.26.10+, a C compiler/SQLite prerequisites and Node 24.22.1+
(the repository pins its Node version in `.nvmrc`):

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

## Upgrading an existing v1 installation

This is a source upgrade; publication and deployment require separate explicit
user authorization. Test migration with synthetic v1 fixtures or an isolated copy
of the database and a fixture CPA server. Never point a second Keeper at the
production usage queue, including during migration rehearsals.

Before deployment:

1. Verify the target CPA is **v8.0.12 or later**, including its grouped provider
   and access configuration. Keeper's version probe is advisory: a successful
   Keeper startup does not prove that the installed proxy is compatible.
2. Schedule a maintenance window, pause new CPA requests and stop the old Keeper.
   Preserve a verified pre-upgrade database backup, private environment and the
   previous image digest. Snapshot the stopped persistent data directory so any
   SQLite WAL/SHM files are captured consistently; validate a backup copy with
   SQLite `PRAGMA integrity_check`. Keep the original backup untouched and record
   its protected location only in the private operations repository.
3. Check free disk space for the database backup, cost backfill, rebuilt summaries
   and SQLite journals. Rehearse with an isolated data copy to estimate time and
   space for the actual database; fixture timings do not establish a production
   estimate. Preserve the intended Keeper timezone and existing pricing settings.
4. Deploy an explicitly authorized, digest-pinned v2 image as the sole Keeper.
   First startup protects the v1 database, captures pricing, persists request
   costs and rebuilds summaries. Leave requests paused until the startup page
   reports ready and `/readyz` (under `APP_BASE_PATH`, if set) returns success.
   Interrupted migrations resume from checkpoints; do not start the old binary
   against their database.
5. Verify totals against the retained history, pricing, ingestion and credential
   synchronization, plus separate administrator and API-key viewer sessions.
   Enable the viewer only through `API_KEY_VIEWER_QUOTA_ENABLED=true`. Confirm
   `/credentials` administration, `/quotas` cache-only reads and blocked viewer
   mutations before resuming traffic. Replace saved `/auth-files` bookmarks;
   upstream does not preserve that route or its old list preferences.

V2 stores request costs at ingestion time. Editing prices no longer changes past
costs automatically; historical recalculation is explicit. Migration rebuilds
historical totals from retained details, so totals may decrease where older
request details were already deleted. Local and Community Ranking and their
ranking-specific stored data are removed. OIDC remains optional and defaults off.

To roll back, stop v2, preserve its failed/migrated data and restore a **copy** of
the verified pre-upgrade v1 backup as `app.db` in a separate data directory. Start
the previous digest-pinned LedgiFi v1 image against that restored directory and
its original private environment. Never open a migrated or partially migrated
v2 database with v1, and never combine v2 WAL/SHM files with the restored v1 copy.
Rollback returns usage to the backup point. See upstream's
[v2 upgrade notes](https://github.com/Willxup/cpa-usage-keeper/releases/tag/v2.0.0)
and the repository README for the upstream migration behavior.

## Internal releases

Source and public image live under `ledgifi/cpa-usage-keeper`. Keep upstream
history and a small maintained patch on `main`; the `upstream` remote tracks
`Willxup/cpa-usage-keeper`. Release tags use `v<upstream>-ledgifi.<revision>`
(the next v2 release is `v2.0.1-ledgifi.1`). Use the existing Dockerfile and
upstream release workflow, targeting only `linux/amd64` for the internal Unraid
host. The shared release policy accepts the LedgiFi revision suffix and still
requires the tagged v2 commit to be on `origin/main`. The release workflow runs
full CI before Docker publishing; its binary/Homebrew job is restricted to the
upstream repository. Keep standalone binary and development publishing workflows
disabled in this fork's GitHub settings. No additional packaging system is needed.

Pin the Unraid Keeper template to the release image digest, keeping its existing
private environment, persistent data, network and Tailscale identity. Enable
`API_KEY_VIEWER_QUOTA_ENABLED=true` in that private environment. Ranking and its
old environment flag have been removed by upstream v2. Remove
`API_KEY_VIEWER_LOCAL_RANKING_ENABLED` from private configuration. Record the
source commit, tag, digest, previous image and protected backup location in the
private operations repository. This source upgrade does not deploy or configure
the proxy; verify its v8 compatibility before deploying Keeper v2.

## Maintenance and verification

Keep presentation changes in `web/src/components/usage/quotas/`. The existing
Credentials component uses a small display adapter in `credentialViewModels.ts`;
`QuotasPage.tsx` reads only the safe endpoint. Backend integration is the default-off
config/session capability, route registration, `internal/api/key_quota.go`, and
freshness metadata added to the existing admin cache response. Scheduler deadline
calculation is reused. Viewer reads use `PeekCachedQuota`, which omits expired
snapshots without deleting task entries or advancing cleanup deadlines. Existing
admin cache reads retain upstream maintenance behavior. The viewer projection
omits local costs, so its snapshot route remains readable during historical
cost recalculation. Provider parsers and types are unchanged from upstream v2.0.1.
Only Claude/Codex window normalization consumes existing presence flags for
missing percentages and explicit zero resets; other normalization is unchanged.

### Customization boundaries

- Keep shared meters, freshness, countdowns and timeline logic in
  `web/src/components/usage/quotas/`. The viewer page composes these components;
  existing Credentials views use `credentialViewModels.ts` as their display
  adapter. Limit edits to Credentials views and cache hooks to rendering and
  forwarding display metadata. These upstream integration points deserve close
  review during merges.
- Keep viewer selection, sanitization and DTO projection in
  `internal/api/key_quota.go`. Config, session capabilities, app startup and router
  wiring remain small hooks into upstream patterns. Preserve the default-off
  flag and separate viewer/admin authorization fixtures.
- Keep the scheduler-based freshness helper, existing numeric-presence checks
  and `PeekCachedQuota` safeguard narrowly scoped. Reuse upstream cache
  serialization; viewer reads must not prune entries or advance cleanup state.
  Collection, provider parsing, pricing, storage and authentication architecture
  follow upstream. Remove a local safeguard once upstream provides equivalent
  behavior and the regression tests verify it.
- Keep publishing differences limited to the existing release workflow's
  LedgiFi tag acceptance, amd64 target and binary/Homebrew restriction. Maintain
  deployment records in the private operations repository.

### Upstream sync checklist

1. Start with a clean checkout, fetch upstream and select a reviewed stable tag.
   Read its release and migration notes before merging; retain upstream history
   and existing published fork history.
2. Merge that tag into the maintained branch. Resolve conflicts using upstream's
   current APIs, names and lifecycle, then reconnect the small integration hooks
   above. Remove custom code that upstream now supplies.
3. Review the complete customization against the target tag. While the merge is
   staged, use `git diff --cached --stat v2.0.1` and
   `git diff --cached v2.0.1`; after committing, use `git diff v2.0.1 HEAD`.
   Substitute the reviewed tag on later upgrades. Every remaining difference
   should serve quota presentation, safe viewer access, its regression coverage,
   maintenance documentation or the existing fork publishing adjustments.
4. Verify authorization, DTO sanitization, unknown versus zero values, cache-only
   reads and unchanged task state. Check both roles, default-off access and
   `APP_BASE_PATH` using fixtures, then run the checks below. Keep unrelated
   upstream repairs outside this customization.
5. Update the upstream base in `AGENTS.md` and this document, plus any changed
   integration or migration requirements. Commit the reviewed merge with signing
   available. Publication and deployment remain separately authorized actions.

Security tests use separate viewer/admin sessions and isolated databases. They
cover v2 application startup wiring, default-off access, active/revoked/anonymous
keys, blocked direct admin routes, sanitization and cache-only reads without task
state mutation. Display tests cover missing/zero values,
plans, failed/stale/no cache, absolute/relative resets, countdowns, timeline fill,
projections, range clipping, DST and both page integrations. On this 8-GB VM use
bounded workers and allow 15 seconds for the large virtualized-list tests:

```sh
GOMAXPROCS=1 GOMEMLIMIT=256MiB go build -p 1 -tags sqlite_trace -o /tmp/keeper-pricingbench ./internal/benchmark/cmd/pricingbench
TZ=UTC GOMAXPROCS=1 GOMEMLIMIT=256MiB go test -p 1 ./cmd/... ./internal/...
NODE_OPTIONS=--max-old-space-size=512 npm --prefix web run test -- --maxWorkers=1 --no-file-parallelism --testTimeout=15000
npm --prefix web run typecheck
npm --prefix web run lint
RAYON_NUM_THREADS=1 NODE_OPTIONS=--max-old-space-size=512 npm --prefix web run build
GOMAXPROCS=1 go build -p 1 -o /tmp/keeper ./cmd/server
```

The first command warms the trace-enabled SQLite build before upstream's
benchmark CLI tests start their two-minute subprocess timers. It only builds
the fixture tool; it does not start a Keeper or connect to a proxy.

Browser checks should use intercepted fixture APIs and isolated roles, without
provider calls. Regression coverage is in the Go and Vitest suites. Deployment
state and private runbooks belong outside this public source repository.
