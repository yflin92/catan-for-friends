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

To be checked on the real host after provisioning (X-deploy DoD): the external port scan (22/80/443 only), TLS, the
Loki query against Grafana Cloud, a backup upload and restore from the remote, and Evolve's baseline evidence
(`server.starts{shutdown="clean"}`, `catan.ws.resume_gap{cause="server_restart"}` samples, `server.stopped drain_ms`, and
`count({cluster="<env>"})` series).
