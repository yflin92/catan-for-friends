# deploy — runbook

How Hexlands runs in production: one VM with Docker Compose running **catan-server**, **Caddy** (TLS, the only public
ports) and **Grafana Alloy** (OTLP to Grafana Cloud). Implements ADR-0011 (task `447255465401a6518431ca2e`, PROPOSED),
ADR-0005 (drain), ADR-0009 (Alloy), and design v1.4 §5.8, §9.1, §9.5, §10, §11, D11, D12 and D13.

> **Status: prepared, not provisioned.** Everything below has been validated on a local compose stack (see
> "Validation"). Renting the host, choosing its region, the DNS name, any spend, and the first production deploy all
> wait on the user's answers to **Q2, Q13 and Q14**.
>
> **Pre-prod gate:** S-6-FU-D21 (`e0e292d930ce228e42a71f71`, seats.first_bound_at) must be merged before the first
> production deploy.

## Open decisions (user)

| Question | What it decides | Default used in these files |
|---|---|---|
| **Q2** host | the provider and plan | Hetzner Cloud **CX22** (2 vCPU, 4 GB) [ASSUMPTION], fixed monthly price, no usage billing |
| **Q13** region | where the VM runs; EU ↔ US West adds ~150–180 ms RTT against the 300 ms NFR2 | **none**: `<Q13: region>`. The CX line may be EU-only; for US players use a 2 GB shared plan in a US region |
| **Q14** domain | the TLS hostname in `HEXLANDS_SITE_ADDRESS` | `<Q14: hostname>`: a custom domain, or a free DNS name pointing at the VM. Never a bare IP |
| **Q11** alerts | where alerts go (`GRAFANA_CONTACT_POINT`) | a placeholder contact point that delivers nowhere; alerts still show on the dashboard |

Record the answers here once they are made:

- Host/plan: `<Q2>`
- Monthly price: `<Q2: fixed price of the plan>`. NFR8 cost: a fixed-price plan has no usage billing, so no 80 % spend
  alert or cap applies. If Q2 picks a usage-billed host (e.g. Fly), set its spend cap (e.g. $8) before the first
  deploy. Evolve tracks the invoice monthly.
- Region: `<Q13>`
- Hostname: `<Q14>`

## What runs

| Service | Image | Ports | Notes |
|---|---|---|---|
| catan-server | `catan-server:<git sha>` built from `deploy/Dockerfile` | **none** | non-root, `/data` volume (SQLite), `stop_grace_period: 30s` for the drain |
| caddy | `caddy:2.10-alpine` | **80, 443 (tcp+udp)** | automatic TLS for `HEXLANDS_SITE_ADDRESS`, WebSockets, no access log |
| alloy | `grafana/alloy` | **none** | OTLP receiver on the compose network only; no Docker socket, no host mounts |

- **One version per deploy (D12).** `deploy.sh` passes the git SHA as the build arg `HEXLANDS_BUILD_VERSION`. It is
  baked into the web bundle and its `version.txt`, and it becomes the server's `buildVersion` (/healthz `version`,
  `room.buildVersion`) and OTel `service.version`. The image build fails if `version.txt` differs or if any test code
  reaches the shipped artefacts (O2-3b).
- **Client IPs (D11).** Only Caddy publishes ports, so only Caddy can reach the server, and it sets
  `X-Forwarded-For`. `ops.trustedProxies` stays at its default (loopback and private ranges, which cover the compose
  network); never a wildcard. Client IPs are never logged.
- **Telemetry.** The server exports OTLP/HTTP to `alloy:4318` with `service.name=catan-server`,
  `service.version=<sha>`, `deployment.environment=<HEXLANDS_ENV>` and the stable `service.instance.id=catan-1`
  (also set explicitly in `OTEL_RESOURCE_ATTRIBUTES`). Alloy (`alloy/config.alloy`) adds `cluster=<environment>` and
  `namespace=catan-server` to every signal:
  - metrics → Mimir, as labels;
  - traces → Tempo, as resource attributes;
  - logs → Loki, whose **only** stream labels are `cluster`, `namespace` and `service_name`. The line is the server's
    full JSON event; query it with `| json`, e.g. `{cluster="prod",namespace="catan-server"} | json | event="server.started"`.
  - node-exporter, cAdvisor and Alloy self-metrics are off (G6). Disk headroom comes from the server's own
    `catan.disk.free_bytes`.
- **Logs on the host.** json-file driver, 10 MB × 3 per container.

## Grafana Cloud (prerequisite, free tier)

Telemetry, alerts and dashboards live in a Grafana Cloud stack. Without it the game runs, but nobody is alerted. In
prod, `deploy.sh` **refuses** to deploy while the Grafana Cloud values below are unset, unless
`HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY=yes` records that decision. Cost: $0 at this volume (≈ 355 of the free tier's series).

1. **Create a free stack** at grafana.com, in the region closest to the server (Q13).
2. **Access-policy token for Alloy** (the telemetry agent on the host): *Administration → Cloud access policies*, create a
   policy with **metrics:write, logs:write, traces:write**, then a token. Put it into the host's `deploy/.env` as
   `GRAFANA_CLOUD_TOKEN`. Never paste it in chat, never commit it, never log it.
3. **Endpoints and instance ids** (stack → *Details* of Prometheus, Loki and Tempo), into `deploy/.env`:
   `GRAFANA_MIMIR_URL` (…/api/prom/push) and `GRAFANA_MIMIR_USER`, `GRAFANA_LOKI_URL` (…/loki/api/v1/push) and
   `GRAFANA_LOKI_USER`, `GRAFANA_TEMPO_ENDPOINT` (host:443) and `GRAFANA_TEMPO_USER`.
4. **Service-account token for the alerting/dashboard sync**: *Administration → Service accounts*, role **Editor**,
   then a token as `GRAFANA_SA_TOKEN`, and the stack URL as `GRAFANA_URL`.
5. **Synthetic Monitoring**: enable it on the stack, copy the SM API URL and an access token into `SM_API_URL` and
   `SM_ACCESS_TOKEN`, and choose one or two probe locations near the players (`SM_PROBE_IDS`).
6. **Alert target (Q11)**: set `GRAFANA_CONTACT_POINT` to an email or Discord/Slack webhook contact point (examples in
   `.env.example`). Until then a placeholder contact point delivers nowhere.
7. *(Optional)* For Evolve's post-launch baseline review, add a **read-only** viewer service account (role Viewer) and
   share its token through the operator's own channel. It can query data and nothing else.

## One-time host setup

On a fresh Ubuntu/Debian VM, after Q2/Q13/Q14 are answered:

1. **Docker** Engine + Compose plugin. Then:
   - `deploy/host/daemon.json` → `/etc/docker/daemon.json` (`live-restore: false`, log rotation);
   - `deploy/host/docker-stop-timeout.conf` → `/etc/systemd/system/docker.service.d/stop-timeout.conf`
     (`TimeoutStopSec=45s`). Together with `stop_grace_period: 30s` this gives the server its drain on a host shutdown
     or reboot (H1);
   - `systemctl daemon-reload && systemctl restart docker`.
2. **Firewall:** allow only 22, 80 and 443 (tcp; plus 443/udp for HTTP/3), e.g. `ufw default deny incoming; ufw allow
   22/tcp; ufw allow 80/tcp; ufw allow 443; ufw enable`. Docker publishes only Caddy's ports.
3. **Unattended upgrades:** disable automatic reboots, or schedule them at 05:00
   (`Unattended-Upgrade::Automatic-Reboot-Time "05:00";`).
4. **DNS:** point `<Q14>` at the VM's address (A/AAAA) before the first deploy, so Caddy can obtain its certificate.
5. **Checkout** the repository at `/opt/catan`.
6. **Configuration:** `cp deploy/.env.example deploy/.env`, then fill in every value. **`deploy/.env` holds secrets and
   is never committed** (it is git-ignored and excluded from the image build context).
   - **Required decision, room creation (D13/Q9):** set `HEXLANDS_ROOMS_CREATE_PASSPHRASE`, or set
     `HEXLANDS_ALLOW_OPEN_CREATION=yes` to accept open creation (the room cap and rate limits still apply). `deploy.sh`
     refuses a prod deploy until one of them is set, and the server logs WARN `server.create_passphrase_unset` at every
     prod start without a passphrase.
   - Grafana Cloud: the Mimir, Loki and Tempo endpoints and instance ids, plus one access-policy token
     (`GRAFANA_CLOUD_TOKEN`).
7. **Backups:** install rclone, configure a B2 or R2 remote (`rclone config`; free tier, $0), set
   `HEXLANDS_BACKUP_REMOTE=<remote>:<bucket>/<path>` in `deploy/.env`, then install the timer:
   `cp deploy/host/catan-backup.{service,timer} /etc/systemd/system/ && systemctl enable --now catan-backup.timer`.
8. **Tags:** tag the VM, volume and any provider resources `app=catan`, `env=<prod|loadtest>`. The containers carry
   the same labels.

## Deploy

Variables `deploy.sh` reads from `deploy/.env` (template: `.env.example`). Secrets are marked; they are never committed,
never printed by the scripts, and never logged.

| Variable | Used for | Default / rule |
|---|---|---|
| `HEXLANDS_ENV` | `prod` or `loadtest`: the `cluster` label and env tag | `prod` |
| `HEXLANDS_SITE_ADDRESS` | the public TLS hostname (Q14) | required |
| `HEXLANDS_ROOMS_CREATE_PASSPHRASE` (secret) | room-creation gate (D13/Q9) | in prod, set it or set `HEXLANDS_ALLOW_OPEN_CREATION=yes` |
| `HEXLANDS_ALLOW_OPEN_CREATION` | accepts open room creation in prod (logged as WARN) | off |
| `GRAFANA_MIMIR_*`, `GRAFANA_LOKI_*`, `GRAFANA_TEMPO_*`, `GRAFANA_CLOUD_TOKEN` (secret) | Alloy's telemetry export | required in prod unless `HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY=yes` |
| `HEXLANDS_DEPLOY_ALLOW_NO_OBSERVABILITY` | deploys prod without Grafana Cloud: no alerts, no dashboards (logged as WARN) | off; never on by default |
| `GRAFANA_URL`, `GRAFANA_SA_TOKEN` (secret) | step 6, the alert/dashboard sync | sync skipped when unset |
| `GRAFANA_CONTACT_POINT` | where alerts go (Q11) | placeholder contact point |
| `SM_API_URL`, `SM_ACCESS_TOKEN` (secret), `SM_PROBE_IDS` | the Synthetic Monitoring /healthz check | check skipped when unset |
| `HEXLANDS_OPS_GAME_NIGHT_WINDOWS` | game-night windows, shared by the server and the alert time interval | `[]` |
| `HEXLANDS_BACKUP_REMOTE` | rclone target of `backup.sh` | local copies only |
| `HEXLANDS_DEPLOY_INSECURE_TLS` (environment, not `.env`) | smoke test against a self-signed certificate | off |

```sh
cd /opt/catan && git pull && deploy/deploy.sh            # deploys HEAD
deploy/deploy.sh <sha>                                    # a specific commit (check it out first)
deploy/deploy.sh --force                                  # deploy even while games are active
```

`deploy.sh`:

1. **Preflight:** `.env` present, `HEXLANDS_SITE_ADDRESS` set, and the passphrase decision made.
2. **Guard:** reads `/healthz` `games.active` from the running server. If it is > 0 the deploy refuses (exit 2),
   unless `--force`. `--force` writes `/data/deploy-forced`, so the server logs `deploy.forced` when it receives
   SIGTERM.
3. **Build and roll:** builds `catan-server:<sha>` and recreates the stack. The old server gets SIGTERM and drains
   (≤ 30 s grace). Players reconnect automatically.
4. **Smoke:** through the public address, `/healthz` `version` must equal `/version.txt` and the SHA. A mismatch or a
   missing value fails the deploy (exit 3). Investigate before retrying.
5. **Cleanup:** `docker image prune -f`.

## Observability (alerts, dashboard, probes)

`deploy/observability/` is the alerting and dashboard configuration as code; `deploy.sh` step 6 pushes it through the
Grafana HTTP APIs (`sync.ts`, run with the image's Node) after every deploy, idempotently:

- **Alert rules** (folder *Catan*, group `catan-alerts`, non-paging; grouped by alert, repeated every 4 h). Every query
  filters on `{cluster="<env>", namespace="catan-server"}`; probe queries on the SM check's `job`/`instance`.
  - **A1** server errors: internal_error rejections + `catan.errors` + non-drain 5xx in 15 min, or a secret-shaped log
    line (a 43-character seat-token shape, an unredacted `roomCode`/`seatToken`/`token`/`passphrase` key, or a
    `#join=`/`#seat=` link fragment; G4), or `server.bundle_version_mismatch`.
  - **A2** down: the last 3 Synthetic Monitoring probes of `/healthz` failed. Always on.
  - **A3** lost games: `lost_on_restart` or a `game.lost` event, or an unclean start (`server.started
    previous_shutdown=unclean`) while games were active in the last 30 minutes.
  - **A4** (optional, from Evolve's task 5cf2796b): the abandonment job has not succeeded for 15 min, never succeeded
    15 min after boot, or a run failed.
  - **A5–A8** (optional, from 5cf2796b), each with a runbook annotation:
    - **A5** latency: under 95 % of client commands within 50 ms over 30 min, with at least 50 commands in the window.
    - **A6** series budget: more than 450 app series for 30 min (NFR12).
    - **A7** room slots or create abuse: any `capacity_reached`, `rate_limited` or `rate_limited_auth` create refusal
      in the last hour; the summary gives the count of each.
    - **A8** disk: under 2 GB free for 10 min, or no `catan_disk_free_bytes` reading for 10 min while the server has
      been up 5 min (disk monitoring itself broken).
  - **NFR9**: 2 consecutive failed probes inside a game-night window. The scheduled half is routed through the
    `game-night` time interval (synced from `HEXLANDS_OPS_GAME_NIGHT_WINDOWS`), the ad-hoc half uses
    `max_over_time(catan_games{state="active"}[30m]) > 0`. Neither needs the game server, so both evaluate while it is
    down.
- **Contact point** `catan-alerts`: `GRAFANA_CONTACT_POINT`, else a placeholder (Q11).
- **Dashboard** *Catan — game night*: a panel per NFR SLI (NFR6 shows no verdict while n < 100), auth rejections, slots,
  disk, room creates, a TraceQL per-action p95 table, rows for live/connections/lifecycle/ops/logs, deploy markers from
  `server.started`, `server.draining` and `deploy.forced`, and game-night regions.
- **Synthetic Monitoring** check `catan-healthz`: `https://<HEXLANDS_SITE_ADDRESS>/healthz` every 120 s.

To change the game-night windows, edit `HEXLANDS_OPS_GAME_NIGHT_WINDOWS` in `deploy/.env` and run `deploy.sh` again.

## Restore a backup

Backups are `deploy/backups/hexlands-<UTC stamp>.db` on the host (the newest 7) and in the rclone remote.

```sh
rclone copy <remote>/<path>/hexlands-<stamp>.db deploy/backups/   # only when restoring from the remote
deploy/restore.sh deploy/backups/hexlands-<stamp>.db
```

`restore.sh` stops the server (normal drain), replaces `/data/hexlands.db` (dropping its WAL/SHM files) and starts it
again. The server's restart recovery then restores every active game from its snapshots and log. Games played after
the backup are lost.

## Validation

Checked on a local compose stack (`HEXLANDS_SITE_ADDRESS=http://localhost`, dummy Grafana endpoints), with
`validate/compose.loki.yml` adding a throwaway Loki:

- the image builds with one SHA, and `/healthz` version == `/version.txt` == the SHA (the deploy.sh smoke);
- only Caddy publishes ports; the server port 8080 and Alloy's 4318 are unreachable from the host;
- `index.html` is served with `Cache-Control: no-cache`;
- the prod start logs WARN `server.create_passphrase_unset`, and there is no `server.bundle_version_mismatch`;
- the guard refuses while a game is active (exit 2); `--force` deploys, and the old server logs `deploy.forced` then
  `server.stopped {drain_ms}`; the new one logs `server.started {previous_shutdown: clean}`;
- a backup is taken and a restore brings the database back to it;
- Loki's only labels are `cluster`, `namespace` and `service_name`, and
  `{cluster="prod",namespace="catan-server"} | json | event="server.started"` returns the parsed fields. Metrics reach
  Alloy's Mimir writer.
- Observability (with `validate/compose.observability.yml`: Prometheus for Mimir, blackbox-exporter for Synthetic
  Monitoring, OSS Grafana): `sync.ts` provisions everything through the same APIs as Grafana Cloud. A1 fired on
  **synthetic log lines pushed straight into Loki** (a seat-token-shaped value and a `server.bundle_version_mismatch`
  event; the real server redacts, so a real token cannot be used). With the server SIGKILLed, A2 and both NFR9 rules
  fired, the 30-minute active-games lookback still evaluating from stored samples. After the unclean restart with an
  active game, A3 fired.

To be checked on the real host after provisioning (X-deploy DoD): the external port scan (22/80/443 only), TLS, the
Loki query against Grafana Cloud, a backup upload and restore from the remote, the real Synthetic Monitoring check and
the alerts firing in Grafana Cloud (X-alerts DoD), and Evolve's baseline evidence
(`server.starts{shutdown="clean"}`, `catan.ws.resume_gap{cause="server_restart"}` samples, `server.stopped drain_ms`, and
`count({cluster="<env>"})` series).

## Load test (X-load, AC32)

Run it in a separate, short-lived environment:
- set `HEXLANDS_ENV=loadtest` in `.env`, so every signal carries `cluster=loadtest` and the run stays out of prod
  baselines;
- add `compose.loadtest.yml`, which raises the per-IP room-create limit, because all bots come from one host;
- start from an empty `catan-data` volume, because `maxActiveGames` (10) also counts leftover lobbies.
- if the environment sets `HEXLANDS_ROOMS_CREATE_PASSPHRASE`, export the same value in the bot host's shell; the
  runner sends it with each room create and never prints it.

```sh
docker compose --env-file .env -f docker-compose.yml -f compose.loadtest.yml up -d

# On the bot host (from the repo root). Record where it runs ("same continent"):
node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/run.ts \
  --url https://<host> --games 10 --players 4 --minutes 30 --bot-location "<city, region>" --report load-report.json
#   optional planned restart mid-run:
#   --restart-at-sec 900 --restart-cmd "ssh <server> 'cd <deploy dir> && docker compose restart catan-server'"

# Server-side numbers for the run window, through Grafana's datasource proxy (GRAFANA_SA_TOKEN in the environment):
node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/server-report.ts \
  --prom-url https://<stack>.grafana.net/api/datasources/proxy/uid/grafanacloud-prom --cluster loadtest \
  --report load-report.json --out server-report.json
```
server-report waits until 90 s (`--settle-sec`) after the run ended, so the last 60 s remote-write is included.

What the bots do (`tooling/load/`):
- They speak the real WebSocket protocol and act from their own PlayerView descriptor, one action every 1–5 s.
- `--illegal 0.005` (default) sets the share of deliberately illegal actions; the report states the measured share.
- They send real `telemetry` batches (same-connection action RTTs, plus resume gaps tagged `server_restart` iff the
  socket closed with 1012) and `visibility` signals.
- They reconnect with the web client's backoff.
- `--slow-bots 1` makes one bot stop reading its socket. Above 1 MiB buffered the server closes it with 1008 and
  terminates it, logging `player.disconnected{cause: backpressure}`. The stalled client may observe 1006, since the
  close frame sits behind unread data, and behind Caddy it sees the cut only when it reads again.

The two reports:
- `load-report.json` holds the client-side numbers, with start and end timestamps. It never includes room codes or
  seat tokens.
- `server-report.json` holds the server-side numbers: NFR1 p95 and share within 50 ms, results and reject reasons,
  errors, 5xx, disconnects, reconnects, resume gaps by cause, client RTT p95, and dropped telemetry.
  - It also lists raw counter totals at the end of the run, because `increase()` misses the first sample of a series
    created mid-run, such as every connection counter right after a restart.

**Local smoke:** run the same stack plus `validate/compose.observability.yml`, which adds a local Prometheus and
Grafana, with `--url http://localhost`. Point server-report at Grafana:
`--prom-url http://127.0.0.1:3000/api/datasources/proxy/uid/grafanacloud-prom`, with
`GRAFANA_BASIC_AUTH=admin:admin` for the local Grafana only.

**Deferred to provisioning:**
- the 30-min load run and the 2-h soak on the production-size instance;
- Evolve's evidence: `count({cluster="loadtest"})` series against 304, trace and log bytes per game, and Alloy RSS/CPU
  next to the server's.
