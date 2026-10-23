# LedgiFi Keeper patch

Upstream base: v2.0.1 (`5604768d352a1a85dd5c087b4e85bd657a159a02`).
See [feature scope and maintenance](docs/api-key-viewer-quotas.md).

Keep this patch narrow: shared quota presentation in existing admin Credentials,
and a default-off, cache-only API-key viewer page. Reuse existing Keeper UI,
authentication, collection and scheduler patterns. Preserve upstream history;
avoid fork-only provider fixes, schema changes, compatibility redirects and
new release machinery. Provider presence checks prevent unknown quotas from
appearing full; do not replace missing fields with zero.

Viewer DTOs must remain allowlisted: no auth-file names, emails, credentials,
raw provider errors or other teammates' keys. Viewer reads must never collect,
probe or mutate quota state. Test authorization with separate fixture sessions.

Keep feature logic in the quota presentation components and allowlisted viewer
API; keep existing Credentials, routing and session integration to small adapters.
Collection, provider parsing, pricing, storage and authentication architecture
follow upstream. Retain the documented presence and read-only cache safeguards
until upstream supplies equivalent behavior. Avoid generalizing these hooks.
For upgrades, merge reviewed stable tags and review the resulting patch against
the target tag, including staged changes while a merge is pending. Remove local
code superseded by upstream; follow the sync checklist in the feature document.

Relevant checks (limit workers on small VMs; prebuild the benchmark so its
two-minute subprocess deadline excludes a cold SQLite trace compilation):

```sh
GOMAXPROCS=1 go build -p 1 -tags sqlite_trace -o /tmp/keeper-pricingbench ./internal/benchmark/cmd/pricingbench
TZ=UTC GOMAXPROCS=1 go test -p 1 ./cmd/... ./internal/...
npm --prefix web run test -- --maxWorkers=1 --no-file-parallelism --testTimeout=15000
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web run build
go build -o /tmp/keeper ./cmd/server
```

Never commit runtime state, credentials, logs or databases. Development must use
fixtures or an isolated proxy: duplicate Keepers consume a shared destructive
usage queue. Publication and deployment require explicit user authorization;
keep private deployment records in the internal operations repository.
