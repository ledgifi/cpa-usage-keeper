# LedgiFi Keeper patch

Upstream base: v1.15.11 (`71a41cc2d1cce8d75b42473adf31f2616ad8085e`).
See [feature scope and maintenance](docs/api-key-viewer-quotas.md).

Keep this patch narrow: shared quota presentation in existing admin Auth Files,
and a default-off, cache-only API-key viewer page. Reuse existing Keeper UI,
authentication, collection and scheduler patterns. Preserve upstream history;
avoid unrelated provider fixes, schema changes, compatibility redirects and
new release machinery. Provider presence checks prevent unknown quotas from
appearing full; do not replace missing fields with zero.

Viewer DTOs must remain allowlisted: no auth-file names, emails, credentials,
raw provider errors or other teammates' keys. Viewer reads must never collect,
probe or mutate quota state. Test authorization with separate fixture sessions.

Relevant checks (limit workers on small VMs):

```sh
TZ=UTC GOMAXPROCS=1 go test -p 1 ./internal/quota/... ./internal/api/... ./internal/config/... ./internal/app/...
npm --prefix web run test -- --maxWorkers=1 --no-file-parallelism
npm --prefix web run typecheck
npm --prefix web run lint
npm --prefix web run build
go build -o /tmp/keeper ./cmd/server
```

Never commit runtime state, credentials, logs or databases. Development must use
fixtures or an isolated proxy: duplicate Keepers consume a shared destructive
usage queue. Publication and deployment require explicit user authorization;
keep private deployment records in the internal operations repository.
