# deploy — runbook

How Hexlands runs in production: one VM with Docker Compose running **catan-server**, **Caddy** (TLS, the only public
ports) and **Grafana Alloy** (OTLP to Grafana Cloud). Implements ADR-0011 (task `447255465401a6518431ca2e`, PROPOSED),
ADR-0005 (drain), ADR-0009 (Alloy), and design v1.4 §5.8, §9.1, §9.5, §10, §11, D11, D12 and D13.

> **Status: prepared, not provisioned.** Everything below has been validated on a local compose stack (see
> "Validation"). Renting the host, choosing its region, the DNS name, any spend, and the first production deploy all
> wait on the user's answers to **Q2, Q13 and Q14**.
>
> **Provisioning:** "Provisioning day (ordered checklist)" below is the order for that day, with every deferred check.
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
| `HEXLANDS_DEPLOY_COMPOSE_OVERLAYS` (environment, not `.env`) | extra compose files under `deploy/` for local validation (the rehearsal's local Loki); honoured only with a rehearsal `.env` (first line `# Local rehearsal only`), otherwise the deploy refuses (exit 1); `--dry-run` prints the compose files in use | none |

```sh
cd /opt/catan && git pull && deploy/deploy.sh            # deploys HEAD
deploy/deploy.sh <sha>                                    # a specific commit (check it out first)
deploy/deploy.sh --force                                  # deploy even while games are active
deploy/deploy.sh --dry-run [--force]                      # preflight + guard read only; prints the plan, changes nothing
```

`--dry-run` runs the preflight and the guard's `/healthz` read for real and prints every later step (build, roll,
smoke, prune, sync) instead of running it; with `--force` it reports the `deploy-forced` marker it would write. It
exits as the real deploy would at the guard: 2 when it would refuse, else 0. `tooling/deploy-dry-run.test.ts` checks
it against fake `docker`/`git`/`curl` in CI.

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

## Provisioning day (ordered checklist)

This section is the order for provisioning day, top to bottom. It starts once the user has answered Q2, Q13 and Q14
and the Grafana Cloud stack exists ("Grafana Cloud"). It collects every check that earlier reviews deferred to the real
host. Each check is marked:
- **re-run**: already passed in the local rehearsal (X-deploy-rehearsal `b03fae8c5c87de35581a63bc`, checks #1, #3,
  #6, #9, #10, #11, #12; see "Local rehearsal"). Here it runs again on the real host.
- **first-time**: never run before, because it needs the real host, real clients or Grafana Cloud.

Post the results as **one comment on X-deploy `ab004a449c407dc5ee0455ea`**: PASS or FAIL per check, with its
evidence. That provisioning step gates the USER playtest `158c48596c08c8c7f50f1111`. §6 maps each check to the task it
closes. File every FAIL as a `bug_report` under Deploy & observability, without a token, passphrase, room code or
rejoin link in it.

Machines:
- **server**: the VM, with the checkout at `/opt/catan`.
- **bot host**: a second machine on the same continent with the repository at the same commit, Node 22 and
  `pnpm install`, for the protocol bots.
- **outside clients**: any machines off the VM's network, for the port scan and the per-IP limiter. One has public
  IPv4, two have public IPv6 in different /64s. A laptop, a phone hotspot and the bot host usually cover this.

### 1. User inputs → `deploy/.env`

Type every value into `deploy/.env` on the server, never into chat, a commit or a command line.

| Input | Key(s) in `deploy/.env` (template: `deploy/.env.example`) |
|---|---|
| **Q2** host and plan | none. Record the plan and its fixed monthly price under "Open decisions" (V36), provision the VM, and tag it `app=catan`, `env=prod` |
| **Q13** region | none. Record it under "Open decisions", and create the VM and the Grafana Cloud stack there |
| **Q14** hostname | `HEXLANDS_SITE_ADDRESS` (its A/AAAA records point at the VM before the first deploy) |
| environment | `HEXLANDS_ENV`: `loadtest` for phase L, then `prod` for phase P |
| Grafana Cloud stack + tokens | `GRAFANA_MIMIR_URL`, `GRAFANA_MIMIR_USER`, `GRAFANA_LOKI_URL`, `GRAFANA_LOKI_USER`, `GRAFANA_TEMPO_ENDPOINT`, `GRAFANA_TEMPO_USER`, `GRAFANA_CLOUD_TOKEN`; `GRAFANA_URL`, `GRAFANA_SA_TOKEN`; Synthetic Monitoring `SM_API_URL`, `SM_ACCESS_TOKEN`, `SM_PROBE_IDS` |
| **Q11** alert target | `GRAFANA_CONTACT_POINT` |
| **Q9** room creation | `HEXLANDS_ROOMS_CREATE_PASSPHRASE`, or `HEXLANDS_ALLOW_OPEN_CREATION=yes` |
| **Q6** game-night windows | `HEXLANDS_OPS_GAME_NIGHT_WINDOWS` (e.g. `[{"start":"2026-10-24T18:00:00Z","end":"2026-10-24T23:00:00Z"}]`) |
| backup target | `HEXLANDS_BACKUP_REMOTE` (an rclone `remote:bucket/path`; the remote's credentials stay in rclone's own config) |

### 2. Order

1. **Pre-prod gate:** S-6-FU-D21 `e0e292d930ce228e42a71f71` is merged (see the status note at the top).
2. **One-time host setup** ("One-time host setup"), with `HEXLANDS_ENV=loadtest` in `deploy/.env` for now.
3. **Shell setup** (§3) on the server and the bot host.
4. **The deploy sequence** below, for `loadtest`.
5. **Phase L** (§4): the load and soak runs, V23 with `--force`, the limiter keys, and A3 and A7 firing.
6. **Switch to prod:**
   - `DC down && docker volume rm catan_catan-data` drops the loadtest stack and its games, so prod starts from an
     empty volume.
   - Set `HEXLANDS_ENV=prod` in `deploy/.env` and run the shell setup (§3) again.
   - Then run the deploy sequence for `prod`.
7. **Phase P** (§5): every remaining check, ending with the game-night pre-flight and a clean slate.
8. **Close-out** (§6).

**The deploy sequence** (on the server, from `/opt/catan`, with the release commit checked out):

```sh
SHA="$(git rev-parse --short=12 HEAD)"
deploy/deploy.sh --dry-run "$SHA"; echo "exit $?"
deploy/deploy.sh "$SHA" 2>&1 | tee "/tmp/deploy-$ENVNAME.log"; echo "exit ${PIPESTATUS[0]}"
grep -E '^\[observability\]|sync failed' "/tmp/deploy-$ENVNAME.log"
nosecrets "/tmp/deploy-$ENVNAME.log"
env | grep -c '^HEXLANDS_DEPLOY_COMPOSE_OVERLAYS='
```

The sequence passes when every step below holds:

| Step | Pass when |
|---|---|
| `--dry-run` | It exits 0. It prints `dry-run: compose files: -f docker-compose.yml` (no overlay) and `dry-run: would sync alert rules, dashboard and probe to Grafana`. |
| `deploy.sh <sha>` | It exits 0 with `smoke ok: /healthz version == /version.txt == <SHA>`. In prod, its only WARN line is `rooms.createPassphrase is unset`, and only when open creation was the Q9 answer. |
| Observability sync, step 6 | The log has these lines: `[observability] folder catan`, `time interval game-night: N window(s)` (N = the Q6 windows), `contact point (email \| discord \| …)` (**not** `placeholder, Q11`), `rule group catan-alerts`, `dashboard catan-game-night`, `game-night annotations: N`, and `synthetic monitoring: catan-healthz → <URL>/healthz every 120 s`. There is no `sync failed`. |
| `nosecrets` | Prints `0` for every key it lists (no token or passphrase in the deploy output). |
| Overlay check | Prints `0`: the shell does not export `HEXLANDS_DEPLOY_COMPOSE_OVERLAYS`. `deploy.sh` refuses a non-rehearsal `.env` with it set, so a stray export from the rehearsal would break later deploys today. |

### 3. Shell setup

**Server**: paste this into each new shell, from `/opt/catan`, and paste it again after editing `deploy/.env`.
- The helpers read single values from `deploy/.env` and never print them.
- The Grafana token goes into a request header through a file descriptor, so it never appears in a URL or on a
  command line.
- It needs `curl`, `jq`, Node 22 and `pnpm install`.

```sh
cd /opt/catan
envget() { sed -n "s/^$1=//p" deploy/.env | tail -n 1; }
SITE="$(envget HEXLANDS_SITE_ADDRESS)"; case "$SITE" in http://*|https://*) URL="$SITE" ;; *) URL="https://$SITE" ;; esac; HOST="${URL#*://}"
ENVNAME="$(envget HEXLANDS_ENV)"; ENVNAME="${ENVNAME:-prod}"; S="cluster=\"$ENVNAME\",namespace=\"catan-server\""
export GRAFANA_SA_TOKEN="$(envget GRAFANA_SA_TOKEN)"
PROM="$(envget GRAFANA_URL)/api/datasources/proxy/uid/grafanacloud-prom"
LOKI="$(envget GRAFANA_URL)/api/datasources/proxy/uid/grafanacloud-logs"
auth() { printf 'Authorization: Bearer %s\n' "$GRAFANA_SA_TOKEN"; }
promql() { curl -fsS -G -H @<(auth) "$PROM/api/v1/query" --data-urlencode "query=$1" | jq -c '.data.result[] | [.metric, .value[1]]'; }
logql() { curl -fsS -G -H @<(auth) "$LOKI/loki/api/v1/query_range" --data-urlencode "query=$1" --data-urlencode "since=${2:-1h}" --data-urlencode limit=200 | jq -r '.data.result[].values[][1]'; }
TS() { node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs "$@"; }
DC() { (cd deploy && HEXLANDS_BUILD_VERSION="$(git rev-parse --short=12 HEAD)" docker compose --env-file .env -f docker-compose.yml $DC_EXTRA "$@"); }
IMAGE() { docker inspect --format '{{.Config.Image}}' catan-catan-server-1; }
SNAP_JS="import Database from 'better-sqlite3';
const db = new Database(process.env.HEXLANDS_DB_PATH, { readonly: true, fileMustExist: true });
for (const g of db.prepare('SELECT id, lifecycle, head_seq FROM games ORDER BY id').all()) {
  const e = db.prepare('SELECT hash_after FROM events WHERE game_id = ? ORDER BY seq DESC LIMIT 1').get(g.id);
  const s = db.prepare('SELECT state_hash FROM snapshots WHERE game_id = ? ORDER BY seq DESC LIMIT 1').get(g.id);
  console.log(g.id, g.lifecycle, g.head_seq, e?.hash_after ?? s?.state_hash ?? '-');
}"
snap_live() { docker exec catan-catan-server-1 node --input-type=module -e "$SNAP_JS"; }
snap_file() { docker run --rm --user "$(id -u):$(id -g)" -v "$(dirname "$(realpath "$1")"):/b" -e HEXLANDS_DB_PATH="/b/$(basename "$1")" --entrypoint node "$(IMAGE)" --input-type=module -e "$SNAP_JS"; }
nosecrets() { for k in GRAFANA_CLOUD_TOKEN GRAFANA_SA_TOKEN SM_ACCESS_TOKEN HEXLANDS_ROOMS_CREATE_PASSPHRASE; do v="$(envget "$k")"; [ -n "$v" ] && [ "${v#<}" = "$v" ] && echo "$k: $(cat "$@" | grep -cFf <(printf '%s\n' "$v"))"; done; }
statloop() { while :; do date -u +%FT%TZ; docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}'; free -m | awk '/^Mem:/ {print "host mem " $3 "/" $2 " MiB"}'; sleep "${1:-60}"; done; }
wipe() { DC down && docker volume rm catan_catan-data && deploy/deploy.sh; }
```

What the helpers are for:
- `promql`, `logql`: query Grafana Cloud through its datasource proxy. The same queries work in Grafana → Explore.
  They print series and log lines only, and the server never logs room codes, seat tokens or passphrases.
- `snap_live` (the running database) and `snap_file` (a database file, opened in a throwaway container from the
  deployed image): print `id lifecycle seq head-hash` per game. They print no room codes.
- `nosecrets <files>`: counts occurrences of each secret value in the given files. It prints the counts, never the
  values.
- `statloop [sec]`: samples CPU and memory of every container plus host memory. `docker stats` gives CPU per core,
  so 100 % is one vCPU.
- `wipe`: takes the stack down, deletes the game database volume and deploys afresh. Use it only for test data; it
  deletes every game.

**Bot host and outside clients**: run this from the checkout:

```sh
URL="https://<Q14: hostname>"
read -rsp 'Room passphrase (Enter if none): ' HEXLANDS_ROOMS_CREATE_PASSPHRASE; echo; export HEXLANDS_ROOMS_CREATE_PASSPHRASE
TS() { node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs "$@"; }
create() { printf '{"displayName":"probe","passphrase":"%s"}' "${HEXLANDS_ROOMS_CREATE_PASSPHRASE:-}" | curl -sS -o /dev/null -w '%{http_code} ' "$@" -H 'Content-Type: application/json' --data-binary @- "$URL/api/rooms"; }
```

- `create [curl options]`: one room create. It prints only the HTTP status, and the passphrase goes in through stdin.
- The bots (`run.ts`) send `HEXLANDS_ROOMS_CREATE_PASSPHRASE` from the environment and never print it.
- Copy each report to the server with `scp <report>.json <server>:/opt/catan/`. The reports hold no codes or tokens.

### 4. Phase L (`HEXLANDS_ENV=loadtest`, same VM)

#### Load and soak

**L1 · X-load V34, the 30-min load** (first-time)

Raise the per-IP create limit for the bots, then start sampling on the server:

```sh
DC_EXTRA="-f compose.loadtest.yml" DC up -d
statloop 60 > /tmp/stats-v34.txt & STATS=$!
```

Run 10 games × 4 bots from the bot host. One bot is a slow consumer and 0.5 % of actions are deliberately illegal:

```sh
TS tooling/load/run.ts --url "$URL" --games 10 --players 4 --minutes 30 --bot-location "<city, region>" --report v34.json
```

When the run ends, collect the server-side numbers and the logs on the server:

```sh
kill $STATS
TS tooling/load/server-report.ts --prom-url "$PROM" --cluster loadtest --report v34.json --out v34-server.json
logql "{$S} | json | event=\"player.disconnected\" | cause=\"backpressure\"" 1h | wc -l
```

V34 passes when (VB `feece88c9cd363fe1cbd6e10`):

| Kind | Pass bar |
|---|---|
| Run validity | `v34.json` states `botLocation` and `actions.intendedIllegalPct` ≤ 1; `telemetry.batches` > 0. |
| Latency | NFR1 action p95 < 50 ms; client action RTT p95 < 300 ms, read from `catan.client.action_rtt` (both in `v34-server.json`). |
| Errors and rejects | 0 NFR3 errors and 0 5xx; rejected < 2 % excluding auth (`actions.rejectedExclAuthPct`). |
| Disconnects | `reason="unplanned"` disconnects equal the slow consumer's backpressure cuts (the `logql` count, ≥ 1), and there are none otherwise. |
| Resources | The peak in `/tmp/stats-v34.txt`, summed over **all three containers including `catan-alloy-1`**, is < 70 % of the vCPUs and < 70 % of the RAM. |

**L2 · X-load V35, the 2-h soak** (first-time)

1. On the server, start sampling every 5 min:

   ```sh
   statloop 300 > /tmp/stats-v35.txt & STATS=$!
   ```

2. Open `$URL` in a browser and create a room; this is the idle WebSocket under test. Leave the tab in the foreground,
   untouched.
3. From the bot host, run the soak with a planned SIGTERM restart at 60 min, so 9 games plus that room stay within the
   10-room cap:

   ```sh
   TS tooling/load/run.ts --url "$URL" --games 9 --players 4 --minutes 120 --bot-location "<city, region>" --report v35.json \
     --restart-at-sec 3600 --restart-cmd "ssh <server> 'cd /opt/catan/deploy && HEXLANDS_BUILD_VERSION=unused docker compose --env-file .env -f docker-compose.yml -f compose.loadtest.yml restart catan-server'"
   ```

4. When it ends, on the server:

   ```sh
   kill $STATS
   TS tooling/load/server-report.ts --prom-url "$PROM" --cluster loadtest --report v35.json --out v35-server.json
   logql "{$S} | json | event=\"server.stopped\"" 3h
   ```

V35 passes when:
- unplanned disconnects other than the slow consumer's are < 1 per player-hour (36 bots × 2 h);
- memory in `/tmp/stats-v35.txt` shows no growth trend across the 2 h, the restart aside;
- the browser tab stayed connected for ≥ 30 min before the restart: no reconnecting banner, and acting in the lobby
  works without a reload;
- around the restart, `server.stopped` has a `drain_ms`, every bot has a `server_restart` gap
  (`connections.resumeGapsMs.server_restart.count` ≥ 36), and `network` gaps come only from the slow consumer.

**L3 · Evolve's evidence and V32 for loadtest** (first-time)

Right after L2, on the server:

```sh
TS tooling/load/series-count.ts --prom-url "$PROM" --cluster loadtest
logql "sum(bytes_over_time({$S}[2h]))" 3h | tail -n 1
```

Then read the run windows from Grafana → *Usage*: traces ingested, and logs ingested for comparison.

L3 passes when:
- series-count exits 0: < 500 series including Alloy's own, app series > 0 and ≤ 309, and `target_info` labelled.
  Compare the actual series with the 304 worst case;
- trace bytes per game (vs 0.4 MB) and log bytes per game (vs 90 KB) are recorded, with the run's start and end
  timestamps;
- Alloy's RSS and CPU, from `catan-alloy-1` in the `statloop` files, are recorded next to the server's.

#### Deploys, restarts and limits

**L4 · V23 on the platform, #11 `--force` → Loki, and the deploy guard**
- V23 is first-time; #11 and the guard are re-runs.
- The `-v23` suffix makes this a real roll: same code, new tag, new container.

1. On the server, start from a clean volume without the overlay:

   ```sh
   wipe
   ```

2. From the bot host, run 1 game for 8 min, with no slow consumer and no hidden spells:

   ```sh
   TS tooling/load/run.ts --url "$URL" --games 1 --players 4 --minutes 8 --slow-bots 0 --hidden-every-sec 0 --report v23.json
   ```

3. About 2 min in, on the server:

   ```sh
   deploy/deploy.sh --dry-run; echo "exit $?"
   deploy/deploy.sh --force "$(git rev-parse --short=12 HEAD)-v23" 2>&1 | tee /tmp/v23-deploy.log; echo "exit ${PIPESTATUS[0]}"
   ```

4. After the run, on the server:

   ```sh
   logql "{$S} | json | event=~\"deploy.forced|server.draining|server.stopped|server.started\"" 30m
   ```

L4 passes when:
- the dry run exits 2 with `refusing to deploy: games active = 1`;
- the forced deploy exits 0, and its log has `writing /data/deploy-forced` and `smoke ok`;
- Loki shows `deploy.forced`, `server.draining`, then `server.stopped` with `drain_ms`, then `server.started` with
  `previous_shutdown: clean`, `games_restored: 1` and `lost_on_restart: 0`;
- in `v23.json`: `connections.resumeGapsMs.server_restart.count` = 4 and `network.count` = 0; `actions.outcomes`
  has no `error`; `actions.unexpectedRejects` is `{}`; the game kept going after the roll, so `statesReceived` grows
  past the restart;
- the *Catan — game night* dashboard shows the deploy markers (`server.draining`, `server.started`, `deploy.forced`).
  This was deferred by X-alerts VB `48e4930794d62e76e526e3c6`.

**L5 · A3 firing** (first-time)

Straight after L4, while the V23 game is still restorable, kill the server, which skips the drain, then start it:

```sh
docker kill catan-catan-server-1; DC start catan-server
logql "{$S} | json | event=\"server.started\"" 10m
```

L5 passes when `server.started` shows `previous_shutdown: unclean` and `lost_on_restart: 0`, and *A3 games lost on
restart, or an unclean start while games were active* fires in folder *Catan* within ~2 min.

**L6 · #10 spoofed `X-Forwarded-For`** (re-run) **and IPv4 limiter keys** (first-time)

1. On the server, reset to a clean volume and the default limit of 6 creates per IP per hour:

   ```sh
   wipe
   ```

2. From outside client A (public IPv4, no creates in the last hour), send 7 creates with spoofed headers:

   ```sh
   for i in 1 2 3 4 5 6 7; do create -4 -H "X-Forwarded-For: 203.0.113.$i"; done; echo
   ```

3. From outside client D (another public IPv4):

   ```sh
   create -4; echo
   ```

4. On the server:

   ```sh
   for ip in 203.0.113. "<client A IPv4>" "<client D IPv4>"; do logql "{$S} |= \"$ip\"" 2h; done | wc -l
   ```

L6 passes when:
- A prints `201 201 201 201 201 201 429`: the spoofed header never changes the key;
- D prints `201`: each client has its own key;
- the `logql` count is `0`: no client IP is in the logs.

**L7 · IPv6 limiter keys** (first-time)

1. On the server:

   ```sh
   wipe
   ```

2. From outside client B (public IPv6):

   ```sh
   for i in 1 2 3 4 5 6 7; do create -6; done; echo
   ```

3. From outside client C (public IPv6 in a different /64):

   ```sh
   create -6; echo
   ```

4. From client A (IPv4):

   ```sh
   create -4; echo
   ```

5. On the server:

   ```sh
   for ip in "<client B IPv6 prefix>" "<client C IPv6 prefix>"; do logql "{$S} |= \"$ip\"" 2h; done | wc -l
   ```

L7 passes when:
- B prints `201 ×6` then `429`, so IPv6 is keyed per /64;
- C prints `201` and A prints `201`. If C gets `429`, all IPv6 clients share one key, the Docker proxy's address:
  file a bug;
- the `logql` count is `0`.

**L8 · A7 firing** (first-time)

L8 passes when, after the `429`s of L6 and L7, *A7 room slots or create abuse* fires in folder *Catan* and its summary
counts `rate_limited`.

### 5. Phase P (`HEXLANDS_ENV=prod`, after the switch and the prod deploy sequence)

#### Before any game exists in prod

These five checks run before the first game in prod. P3 starts a server whose fresh database counts as an unclean
start, and with no game active in the last 30 min that start cannot trip A3.

**P1 · #1 external port scan** (re-run)

From an outside client:

```sh
nmap -Pn -p- --open <Q14 hostname>; nmap -6 -Pn -p- --open <Q14 hostname>
```

P1 passes when only 22, 80 and 443 are open on IPv4 and IPv6, and 4317, 4318 and 8080 are not.

**P2 · #2 TLS, WSS and D12 caching** (first-time)

From an outside client:

```sh
curl -sS -o /dev/null -w '%{http_code} verify=%{ssl_verify_result}\n' "$URL/healthz"
echo | openssl s_client -connect <Q14 hostname>:443 -servername <Q14 hostname> 2>/dev/null | openssl x509 -noout -subject -issuer -enddate
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 5 --http1.1 -H "Origin: $URL" -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | base64)" "$URL/ws" || true
curl -sS "$URL/version.txt"; echo; curl -sSI "$URL/" | grep -i '^cache-control'
A="$(curl -sS "$URL/" | grep -oE '/assets/[^"]+\.js' | head -n 1)"; curl -sSI "$URL$A" | grep -i '^cache-control'
```

P2 passes when:
- `/healthz` returns `200 verify=0`;
- the certificate's subject is the hostname, not an IP, from a public CA, and not expired;
- the WebSocket upgrade returns `101` (curl then times out, as expected);
- `version.txt` is the deployed SHA;
- `/` is `no-cache` and the hashed asset is `public, max-age=31536000, immutable`;
- a freshly loaded client shows no stale-bundle banner.

**P3 · #12 seeded version mismatch** (re-run) **and A1 firing** (first-time)

On the server:

```sh
docker run -d --rm --name catan-mismatch --network catan_default -e HEXLANDS_ENV=prod -e HEXLANDS_TELEMETRY=otlp -e HEXLANDS_DB_PATH=/tmp/v.db \
  -e HEXLANDS_BUILD_VERSION=mismatch-check -e OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4318 \
  -e OTEL_RESOURCE_ATTRIBUTES=service.name=catan-server,deployment.environment=prod,service.instance.id=catan-mismatch "$(IMAGE)"
sleep 120; docker rm -f catan-mismatch
logql "{$S} | json | event=\"server.bundle_version_mismatch\"" 30m
```

P3 passes when:
- exactly 1 ERROR line is returned, from `service_version="mismatch-check"`;
- the deployed server never logged one: the same query over the prod deploy's window shows no other line;
- *A1 server errors* fires within ~15 min and later resolves.

The throwaway instance `catan-mismatch` adds a few series and one unclean start. Run P11 and P12 at least 10 min
later, and read Evolve's baseline on `instance="catan-1"`.

**P4 · the real Synthetic Monitoring probe** (first-time)

In Grafana → *Synthetic Monitoring* → `catan-healthz`, then on the server:

```sh
promql 'probe_success{job="catan-healthz"}'
```

P4 passes when the check runs every 120 s from each `SM_PROBE_IDS` location with 100 % reachability, and every probe
reports `1`.

**P5 · A2 and the scheduled NFR9 firing, and Q11 delivery** (first-time)

1. Set a game-night window from now until +45 min and deploy it:

   ```sh
   OLDW="$(envget HEXLANDS_OPS_GAME_NIGHT_WINDOWS)"
   W="[{\"start\":\"$(date -u +%FT%TZ)\",\"end\":\"$(date -u -d '+45 min' +%FT%TZ)\"}]"
   sed -i "s|^HEXLANDS_OPS_GAME_NIGHT_WINDOWS=.*|HEXLANDS_OPS_GAME_NIGHT_WINDOWS=$W|" deploy/.env && deploy/deploy.sh
   ```

2. Stop the server for 9 min, then start it:

   ```sh
   DC stop catan-server; sleep 540; DC start catan-server
   ```

3. Restore the Q6 windows and deploy again:

   ```sh
   sed -i "s|^HEXLANDS_OPS_GAME_NIGHT_WINDOWS=.*|HEXLANDS_OPS_GAME_NIGHT_WINDOWS=$OLDW|" deploy/.env && deploy/deploy.sh
   ```

P5 passes when:
- *A2 down* fires after 3 failed probes;
- *NFR9 two consecutive failed probes in a scheduled game-night window* fires after 2;
- **both notifications arrive at the Q11 target** (the email or webhook is received);
- both resolve after the start.

The *while games were active* NFR9 rule needs an active game, so it is not exercised here. P6 checks it for health;
its firing proof is local (#91, `probedown+act`).

**P6 · Every rule provisioned, Normal and evaluating to a number** (first-time; health only for A4, A5, A6, A8 and
NFR9 while active)

On the server, list each rule's state and evaluate its own queries through Grafana's eval API:

```sh
GURL="$(envget GRAFANA_URL)"; gapi() { curl -fsS -H @<(auth) -H 'Content-Type: application/json' "$GURL$@"; }
for uid in catan-a1-server-errors catan-a2-down catan-a3-lost-games catan-a4-job-stale catan-a5-latency catan-a6-series \
  catan-a7-room-slots catan-a8-disk catan-nfr9-window catan-nfr9-active; do
  st="$(gapi /api/prometheus/grafana/api/v1/rules | jq -r --arg u "$uid" '.data.groups[].rules[] | select(.uid == $u) | "\(.state)/\(.health)"')"
  fire="$(gapi "/api/v1/provisioning/alert-rules/$uid" | jq '{condition, data}' | gapi /api/v1/eval --data-binary @- | jq -r '.results.fire.frames[0].data.values[0][0] // "NoData"')"
  echo "$uid ${st:-MISSING} fire=$fire"
done
```

Each line is `<uid> <state>/<health> fire=<value>`. P6 passes when all 10 uids print `inactive/ok fire=0`:
- the rule is provisioned with that uid (not `MISSING`);
- its state is Normal (`inactive` in this API), not Error;
- `fire` is a number, **not `NoData`** (the #81 trap).

A rule that is firing at that moment prints `firing/ok fire=1`. Wait for it to resolve, e.g. A1 after P3.

On the local Grafana stack (OSS 12.1.1, rules synced by `sync.ts`) this loop printed a number for all 10 rules. The
same `fire` query with no data behind it printed `NoData`.

Firing proof:
- **A1, A2, A3, A7 and the scheduled NFR9** fire for real here (P3, P5, L5, L8).
- **A4, A5, A6, A8 and NFR9 while games are active** have no safe trigger in prod. Their firing was proven locally:
  - #90's A5–A8 matrix, 14/14, re-run on merged main 033ca71;
  - #91's 25/25, including `probedown+act` → NFR9 while active.

  On prod they are health-only. They are optional and non-gating: Evolve `5cf2796baf157dff889317b1`.

#### With test games

**P7 · #4 log body, `trace_id` and Tempo** (first-time)

1. From the bot host, run 1 game for 5 min with 5 % illegal actions:

   ```sh
   TS tooling/load/run.ts --url "$URL" --games 1 --players 4 --minutes 5 --illegal 0.05 --slow-bots 0 --report p7.json
   ```

2. Then, on the server:

   ```sh
   logql "{$S} | json | event=\"server.started\"" 2h
   logql "{$S} | json | __error__!=\"\"" 2h | wc -l
   curl -fsS -G -H @<(auth) "$LOKI/loki/api/v1/labels" --data-urlencode "query={$S}" --data-urlencode since=1h | jq -c .data
   logql "{$S} | json | event=\"action.rejected\" | line_format \"{{.trace_id}} {{.span_id}} {{.reason_code}}\"" 30m | head -n 3
   ```

3. In Grafana → Explore → Tempo, query `{ trace:id = "<one trace_id>" }`.

P7 passes when:
- `server.started` lines parse with `event`, `timestamp`, `severity_text`, `service_name="catan-server"`,
  `service_version` (the deployed SHA), `environment="prod"`, `games_restored`, `lost_on_restart` and
  `previous_shutdown`;
- the `__error__` count is `0`;
- the stream labels are only `cluster`, `namespace` and `service_name`;
- (b), as worded by V-a:
  - the `action.rejected` line has a 32-hex `trace_id` and a 16-hex `span_id` via `| json`;
  - Tempo `{ trace:id = "<id>" }` resolves to **exactly one** `catan.action` span (kind=server) with
    `catan.reason_code` equal to the logged `reason_code`;
  - the line's `span_id` equals that span's id;
  - no room code, token or `#join=`/`#seat=` appears in the line or the span attributes.

> **Why `action.rejected` stands in for (b) (VB `af983fde23ab287220d06341`, V-a's ruling on VB
> `3078327382c802b94c3033ee`):** (b) names a fault-injected `action.error`, but the production image has no fault
> switch and contains no test code.
> - `action.error` and `action.rejected` both get `trace_id`/`span_id` from the active span in the same `logRecord`.
>   So the deployed log → Loki and span → Tempo path is the same for both.
> - The fault-path half is pinned in CI: `apps/server/src/game-room-errors.test.ts:187` asserts that the
>   `action.error` line's `trace_id` equals the `catan.action` span's.
>
> (b) = P7 + `game-room-errors.test.ts:187`.

**P8 · #6 reboot drain, H1** (re-run for the drain; first-time for the host reboot and the host config)

1. On the server:

   ```sh
   systemctl show docker -p TimeoutStopUSec; docker info --format 'live-restore={{.LiveRestoreEnabled}}'
   grep -rh 'Automatic-Reboot' /etc/apt/apt.conf.d/ 2>/dev/null
   ```

2. From the bot host, run 1 game for 8 min:

   ```sh
   TS tooling/load/run.ts --url "$URL" --games 1 --players 4 --minutes 8 --slow-bots 0 --hidden-every-sec 0 --report p8.json
   ```

3. About 2 min in, on the server:

   ```sh
   sudo reboot
   ```

4. Once the server is back:

   ```sh
   logql "{$S} | json | event=~\"server.stopped|server.started\"" 30m
   promql "sum by (shutdown) (increase(catan_server_starts_total{$S,instance=\"catan-1\"}[30m]))"
   ```

P8 passes when:
- `TimeoutStopUSec` ≥ 45 s and `live-restore=false`;
- automatic reboot is `"false"` or set to `"05:00"`;
- `server.stopped` has `drain_ms` < 30000, then `server.started` has `previous_shutdown: clean`,
  `lost_on_restart: 0` and `games_restored ≥ 1`;
- `shutdown="clean"` ≥ 1;
- `p8.json` has `server_restart` gaps for the bots and the game continues after the reboot.

**P9 · #3 backup round trip through the remote** (re-run, plus the remote and a scratch instance; first-time)

1. Take a backup with no game in play, then fetch it back from the remote:

   ```sh
   snap_live > /tmp/live.txt; deploy/backup.sh
   B="$(basename "$(ls -1t deploy/backups/hexlands-*.db | head -n 1)")"; R="$(envget HEXLANDS_BACKUP_REMOTE)"
   rclone lsl "$R" | grep -F "$B"
   mkdir -p /tmp/rb && rclone copy "$R/$B" /tmp/rb/
   ```

2. Compare the games, then boot a scratch server on a copy:

   ```sh
   snap_file "/tmp/rb/$B" > /tmp/remote.txt; diff /tmp/live.txt /tmp/remote.txt && echo IDENTICAL
   cp "/tmp/rb/$B" /tmp/rb/scratch.db
   docker run --rm --user "$(id -u):$(id -g)" -v /tmp/rb:/b -e HEXLANDS_DB_PATH=/b/scratch.db -e HEXLANDS_TELEMETRY=off "$(IMAGE)" timeout -s INT 10 node main.mjs 2>&1 | grep -E '"event":"server\.(started|stopped)"'
   rm -rf /tmp/rb
   ```

   The scratch instance's `previous_shutdown` is `unclean` because a backup carries no shutdown marker.

P9 passes when:
- `backup.sh` prints `uploaded`, and the object is listed in the remote;
- the comparison prints `IDENTICAL`: same games, lifecycle, seq and head hash;
- the scratch instance logs `server.started` with `lost_on_restart: 0` and `games_restored` = the number of active
  games in `/tmp/live.txt`;
- `systemctl list-timers catan-backup.timer` shows the nightly run.

Never `restore.sh` over the live database to test this.

**P10 · #9 rotation config and secrets scan** (re-run)

1. On the server:

   ```sh
   docker inspect --format '{{json .HostConfig.LogConfig}}' catan-catan-server-1
   HEXLANDS_ROOMS_CREATE_PASSPHRASE="$(envget HEXLANDS_ROOMS_CREATE_PASSPHRASE)" TS deploy/validate/rehearse-games.ts --url "$URL" --games 1 --finished 1 --max-minutes 15 --out /tmp/g.json --secrets /tmp/secrets.json
   mkdir -p /tmp/logs && sudo sh -c "cp $(docker inspect --format '{{.LogPath}}' catan-catan-server-1)* /tmp/logs/ && chown -R $(id -u) /tmp/logs"
   TS deploy/validate/scan-logs.ts --secrets /tmp/secrets.json /tmp/logs/*; echo "exit $?"
   ```

2. Then delete the evidence:

   ```sh
   rm -rf /tmp/logs /tmp/secrets.json /tmp/g.json
   ```

P10 passes when:
- `LogConfig` is `json-file` with `max-size` `10m` and `max-file` `3`;
- `scan-logs` exits 0: 0 hits on the session's room codes and seat tokens, and 0 on A1's secret shapes, across
  every current and rotated file. Rotation itself was rehearsed at 64 KiB in #96.

`rehearse-games.ts` sends the Q9 passphrase from `HEXLANDS_ROOMS_CREATE_PASSPHRASE`, as the load runner does
(bug `d99ce60b93b75b804ec9f132`). The command above reads it from `deploy/.env` for that one process, and it is never
printed. With open creation the value is empty and nothing is sent.

**P11 · #7 region and #8 Evolve's baseline** (first-time)

On the server:

```sh
promql "sum by (shutdown) (catan_server_starts_total{$S,instance=\"catan-1\"})"
promql "sum by (cause) (catan_ws_resume_gap_seconds_count{$S,instance=\"catan-1\"})"
logql "{$S} | json | event=\"server.stopped\" | line_format \"{{.timestamp}} drain_ms={{.drain_ms}}\"" 24h
```

P11 passes when:
- the provider console shows the VM in the Q13 region recorded under "Open decisions";
- the plan's fixed monthly price is recorded there (V36), and the VM, volume and provider resources are tagged
  `app=catan`, `env=prod`;
- these values are in the X-deploy comment: `starts{clean}` ≥ 1, the `server_restart` gap samples, the `drain_ms`
  values, and the P12 series count.

**P12 · V32 for prod** (first-time)

On the server:

```sh
TS tooling/load/series-count.ts --prom-url "$PROM" --cluster prod
```

P12 passes when it exits 0: < 500 series including Alloy's own, app series > 0 and ≤ 309, and `target_info` carrying
`cluster` and `namespace`.

**P14 · Live browser smoke** (first-time)

`apps/web/e2e/live-smoke.spec.ts` plays the start of a game in real browsers through Caddy, TLS and WSS:
- a host creates a room in the UI, sending the Q9 passphrase if the server asks for one;
- two more players join through the invite link;
- the third seat then moves to a fresh browser context through its rejoin link;
- the three seats play the setup placements;
- the seat about to roll reloads and must be back on the same view within 5 s;
- every page must have a clean console (beyond KI-1);
- then every page closes.

The players are named `smoke-test`, `smoke-test-2` and `smoke-test-3`, so anyone looking at the room sees what it is.

It refuses to run inside a game-night window (below). Traces, screenshots and video are off, since they could hold
the passphrase, room codes or seat tokens, and a failure keeps no page snapshot. Keep the default reporter: the run
refuses `--reporter=html`, which keeps raw failure values. Never set `HEXLANDS_E2E_LIVE_ARTIFACTS=on` or
`HEXLANDS_E2E_LIVE_INSECURE_TLS=yes` against the real host. If the server refuses
the room, the run fails at once with `the server refused to create the room: <reason>`. Typical reasons: a wrong
passphrase, the server being full, or the create limit.

1. On the server, before the run, note the games:

   ```sh
   curl -fsS "$URL/healthz" | jq -c .games
   ```

2. On an outside client, from the checkout at the release commit (Node 22, `pnpm install`), with the passphrase
   already exported by the §3 outside-client setup:

   ```sh
   pnpm --filter @hexlands/web exec playwright install --with-deps chromium firefox webkit
   export HEXLANDS_E2E_BASE_URL="$URL"
   export HEXLANDS_OPS_GAME_NIGHT_WINDOWS="$(ssh <server> "sed -n 's/^HEXLANDS_OPS_GAME_NIGHT_WINDOWS=//p' /opt/catan/deploy/.env | tail -n 1")"
   echo "$HEXLANDS_OPS_GAME_NIGHT_WINDOWS"
   (cd apps/web && HEXLANDS_E2E_BROWSERS=all pnpm exec playwright test e2e/live-smoke.spec.ts) 2>&1 | tee /tmp/live-smoke.log; echo "exit ${PIPESTATUS[0]}"
   [ -n "$HEXLANDS_ROOMS_CREATE_PASSPHRASE" ] && grep -cFf <(printf '%s\n' "$HEXLANDS_ROOMS_CREATE_PASSPHRASE") /tmp/live-smoke.log
   find apps/web/test-results \( -name '*.zip' -o -name '*.png' -o -name '*.webm' \) | wc -l
   ```

   The window value is not a secret. The `echo` must print the windows (`[]` when there are none): the smoke fails
   when `HEXLANDS_OPS_GAME_NIGHT_WINDOWS` is unset, so a missing value cannot pass for "no windows". Inside a window it
   fails at once with `refusing the live smoke inside the game-night window …`. `HEXLANDS_E2E_LIVE_OVERRIDE_WINDOW=yes`
   overrides that, which is for an empty server only and never on game night.

3. On the server, at least 11 min after the run (`allDisconnectedAbandonMin` 10 min, plus the 60 s lifecycle check):

   ```sh
   curl -fsS "$URL/healthz" | jq -c .games
   snap_live
   ```

What one run costs on the server, per browser:
- one successful create, of the outside client's 6 per hour (`createsPerIpPerHour`). The first attempt, without the
  passphrase, is refused without a strike.
- one of the 10 active slots (`maxActiveGames`), until the room is abandoned about 11 min after the run.

Run it from a client whose create budget the P-checks have not used up this hour, and when 3 slots are free.

A run that fails before its game starts leaves its room in the lobby. The room keeps its slot until
`lobbyExpiryHours` (24 h) passes. `snap_live` shows it as `lobby`; on provisioning day, P13's clean slate drops it.

P14 passes when:
- the run exits 0 with `3 passed` (chromium, firefox, webkit) and nothing skipped;
- the log has `[live-smoke] <browser>: reload resumed in N ms` for each browser, every N ≤ 5000;
- the passphrase count prints `0` (no line with open creation);
- the artifact count prints `0`;
- after 11 min, `games.active` is back to its value from step 1, and `abandoned` is up by 3. `snap_live` shows the 3
  rooms as `abandoned`; none is left active.

From there the smoke rooms follow the lifecycle policy like any abandoned game: expired after `resumeWindowDays`, then
purged. P13's clean slate drops them today.

#### Close

**P13 · Clean slate, then the game-night pre-flight** (required first-time)

`gamenight-preflight.sh` (#104) was verified with a fake docker only. This is its first run against a real daemon, and
the operator runs it. It is read-only.

1. Drop the test games and take today's backup:

   ```sh
   SHA="$(git rev-parse --short=12 HEAD)"
   DC down && docker volume rm catan_catan-data && deploy/deploy.sh "$SHA" && deploy/backup.sh
   ```

2. Check that a container reaches the site through this host, the way the wrapper runs check 2 (Docker's default
   bridge, with `--add-host <site>:host-gateway`):

   ```sh
   docker run --rm --add-host "$HOST:host-gateway" --entrypoint node "$(IMAGE)" -e "fetch('$URL/healthz').then(async (r) => console.log(r.status, (await r.text()).slice(0, 40)))"
   ```

   It must print `200 {"status":"ok"…`. A bare `200` with an empty body is Caddy answering a host it does not serve.

3. Run the pre-flight:

   ```sh
   deploy/gamenight-preflight.sh --sha "$SHA"; echo "exit $?"
   ```

Pass `--sha` the 12-character tag `deploy.sh` deployed (`$SHA` above), not a full SHA. With a full SHA, check 2 fails
on the version, and the wrapper uses `node:22-bookworm-slim` instead of the deployed image.

**Check 2's address.** The wrapper's container runs on Docker's default bridge, not the compose network, with
`--add-host <site>:host-gateway`.
- **The site's hostname resolves to this host** inside the container. Check 2 then reaches the local Caddy under the
  site's TLS name and Host header, with or without hairpin NAT.
- **Leave `--base` unset.** It then uses `https://<HEXLANDS_SITE_ADDRESS>`.
- **Other `--base` values don't work.**
  - `http://127.0.0.1` or `localhost` would be the container's own loopback, so the wrapper refuses them (exit 2).
  - The bridge gateway (`http://172.17.0.1`) gets Caddy's empty `200` for a host it does not serve. Check 2 reports
    that as "answered 200 without /healthz JSON".
- **If the reachability check fails** (Caddy not published on this host's interfaces, or a firewall between Docker's
  bridge and the host), the wrapper shows check 2 as FAIL and check 1's activity as UNKNOWN. Read checks 1 and 2 from
  an outside client instead:

  ```sh
  curl -fsS "$URL/healthz" | jq -c '{status, version, draining, active: .games.active}'; curl -fsS "$URL/version.txt"; echo
  ```

  Expected (as printed on the local stack, with the deployed tag in place of `<SHA>`):

  ```text
  {"status":"ok","version":"<SHA>","draining":false,"active":0}
  <SHA>
  ```

  That output counts as check 2 PASS, plus check 1's "no game active". Check 1's window part is still the wrapper's
  verdict. Record the fallback output with the run. The pass pattern below is the same either way.

P13 passes with this per-check pattern:

| Check | Expected on provisioning day |
|---|---|
| 1 window and activity | **PASS** (`next game-night window starts …; no game active`). WARN if Q6 has no window yet, which is acceptable today but must be PASS on game night. |
| 2 server healthy, intended build | **PASS** (`/healthz ok, not draining; version and /version.txt = <SHA>`) |
| 3 dashboard: alerts and probe | **PASS** (`no firing alerts in Catan; catan-healthz passing`). Wait until the alerts from P3, P5 and L5/L8 have resolved. |
| 4 room-creation decision (Q9) | **PASS** |
| 5 branch protection | **UNKNOWN** expected on the VM without `gh`. With `gh` it reads both the branch-protection rule and the rulesets on `main` (the rulesets need only read access): PASS when together they require all 7; UNKNOWN when they fall short and the rule is unreadable (403). Verify any UNKNOWN by hand against `docs/README.md` "Repository settings". |
| 6 backup taken | **PASS** (`newest hexlands-<today>.db is from today; remote set (value not shown)`) |

Without `gh`, the run exits 0 with `Result: no failures; verify by hand: 5 branch protection`. Its stderr echo of the docker
command shows mounts and arguments only (`nosecrets` on a saved copy prints `0`s).

### 6. Close-out

| Checks | Close or feed |
|---|---|
| L1, L2, L3 | VB `feece88c9cd363fe1cbd6e10` (V34, V35, evidence, backpressure under load), which closes with X-load `1b9f282ebcf0aade9de8f1be` |
| L4, L6, L7, P1, P2, P3 (#12), P7, P8, P9, P10, P11 | X-deploy `ab004a449c407dc5ee0455ea` provisioning step, the deferrals of VB `af983fde23ab287220d06341` (#1–#12, V23, D11, D12, H1, V31, the baseline). Staging LogQL (b) = P7 + `game-room-errors.test.ts:187` |
| L4 (dashboard markers), L5 (A3), P3 (A1), P4, P5 | X-alerts `a35e74f722d1d0b200ccddd3`, the deferrals of VB `48e4930794d62e76e526e3c6` |
| L8 (A7), P6 | Evolve's A4–A8 `5cf2796baf157dff889317b1`, VB `e627c56e0655964411edd51b` (firing proof for A4, A5, A6, A8 and NFR9 while active: #90 14/14 on 033ca71, #91 `probedown+act`) |
| L3, P12 | V32 on the verification plan `68f17b0f88731394ff18f567` (V32-prep `7f12f6c73e6da131e9c3ca83`) |
| P13 | Gamenight-preflight `78e34c2b6f4e39ceab30619d` (its real-host run), closing item 6 of VB `7ab475e7f351454467ddc3e5` |
| P14 | Live-smoke `62a0182358937fb1595da5c7` (its real-host run), VB `6a67e89a6a910067ad967f66` |
| all of the above | USER playtest `158c48596c08c8c7f50f1111`, gated by X-deploy's provisioning step |

## Game night (playtest, AC34/AC35)

The operator's checklist for the USER playtest (task `158c48596c08c8c7f50f1111`). The pass criteria are Verify's:
the **V44 checklist and Grafana queries** are the V44 row of the verification plan (task `68f17b0f88731394ff18f567`),
and the **sign-off criteria** are Verify's comment on the playtest task (`158c48596c08c8c7f50f1111`). This section
says where to look; it does not restate those queries or thresholds.

Fill in before the night:

- Date and time (with time zone): `<game-night date>`
- Address: `https://<Q14: hostname>`
- Room creation: `<passphrase set | open creation>` (Q9). Share a passphrase only with the host, never in a group chat.

### Pre-flight (day of)

Run `deploy/gamenight-preflight.sh --sha <deployed sha>` on the host, from the repo checkout. It needs only Docker
(and `gh` for step 5): the checks run in the deployed `catan-server:<sha>` image (or `node:22-bookworm-slim`) with the
repo, `deploy/.env` and `deploy/backups` mounted read-only, in the host's time zone. It checks steps 1–6 below and
prints PASS / WARN / FAIL / UNKNOWN for each, exiting 1 on any FAIL. Fix every FAIL, and verify each UNKNOWN by hand
(e.g. branch protection without `gh` or when its token cannot read the settings, or Grafana when `GRAFANA_URL` /
`GRAFANA_SA_TOKEN` are not in `deploy/.env`). It changes nothing and never prints a token or the passphrase.

- **Step 2 from the container.** The container reaches the site by name through this host: the wrapper adds
  `--add-host <site>:host-gateway`, with the bare hostname taken from `--base` or `HEXLANDS_SITE_ADDRESS`. So
  `/healthz` goes to the local Caddy with the site's TLS name and Host header, also where the router has no hairpin NAT.
  This works because compose publishes Caddy's 80/443 on all interfaces. If Caddy is ever bound to a specific
  address, step 2 reports unreachable. `--base` must name the site; `127.0.0.1` or `localhost` would be the container
  itself and is refused.
- **Step 5 reads both** the branch-protection rule (`gh api repos/<repo>/branches/main/protection`) and the rulesets
  active on `main` (`gh api repos/<repo>/rules/branches/main`), and counts a check as required if either requires it.
  It is FAIL only when both were read and still miss one of the 7 checks. With a 403 from either, it is UNKNOWN unless
  the other covers all 7.

1. **No deploy during the night.** The window is in `HEXLANDS_OPS_GAME_NIGHT_WINDOWS` (`deploy/.env`, e.g.
   `[{"start":"<ISO start>","end":"<ISO end>"}]`); `deploy.sh` syncs it to the alert time interval and the dashboard
   regions. Deploy, if at all, before the window starts, and with no game active: the guard refuses while
   `games.active > 0` (see "Deploy"); do not use `--force` on game night.
2. **Server healthy and on the intended build.** `https://<Q14: hostname>/healthz` returns `status: ok`,
   `draining: false`, and `version` equal to the SHA you deployed (also `/version.txt`).
3. **Dashboard green.** *Catan — game night* in Grafana: no firing alerts (folder *Catan*), the Synthetic Monitoring
   check `catan-healthz` passing, `Disk free` comfortable, `Slots used` at 0.
4. **Room creation decided (Q9).** Either `HEXLANDS_ROOMS_CREATE_PASSPHRASE` is set, or `HEXLANDS_ALLOW_OPEN_CREATION=yes`
   is a deliberate choice (the server then logs WARN `server.create_passphrase_unset` at start).
5. **Branch protection** on `main` requires the 7 checks listed in `docs/README.md` ("Repository settings"), so nothing
   unreviewed can be deployed.
6. **Backup taken.** Run `deploy/backup.sh` (or check the newest `deploy/backups/hexlands-<stamp>.db` is from today, and
   that it reached `HEXLANDS_BACKUP_REMOTE` if set). "Restore a backup" below is the way back.
7. **Optional, not part of the wrapper: live browser smoke, before the window opens.** On an outside client, run P14 step 2 with
   `--project=chromium` in place of `HEXLANDS_E2E_BROWSERS=all`, so only one room is used. Finish at least 15 min
   before the window starts, so its room is abandoned and its active slot is free again before anyone arrives. The
   pass bar is P14's, for one browser. Inside the window the smoke refuses to run; do not override it on game night.

### Running the game

1. **Create the room** at `https://<Q14: hostname>/` (host name, then *Create game*; with a passphrase, enter it when
   asked).
2. **Share links.**
   - The **Invite link** (`…/#join=<room code>`) is for everyone joining. Send it privately (a direct message);
     avoid group chats that build link previews.
   - Each player's **Your rejoin link** (`…/#seat=<room code>.<seat token>`) is personal: it is that seat. Never share
     it; a player keeps their own to return from another device.
   - Both are fragment links: the part after `#` is not part of any HTTP request, so it never reaches a proxy or an
     access log, and the server never logs codes or tokens.
3. **Lobby.** Seat order (↑/↓, *Shuffle seats*), rules and the absent-player policy (*Pause the game*, *Pause; the
   host can skip them*, or *Turn timer*, with its `skipAfterSec`) are set by the host before *Start game*. Check that
   at least one player is on a phone (the AC34 device mix). Each device in the mix runs the **Device check (V47)**
   below during the game, and the operator records it in the device-matrix notes.
4. **During play.**
   - A disconnected player shows in the waiting banner; under the skip policies a *Skip* button appears once they have
     been gone `skipAfterSec`.
   - If everyone leaves, the game is abandoned and resumes when a seated player comes back with their rejoin link
     within the resume window.
   - A player who lost their link: the host uses *Reissue link for seat N* in the players panel and sends the *New link*
     privately; the old link stops working at once.

### Device check (V47)

This is the manual smoke on real phones for **V47** (iOS Safari 17+ and Android Chrome, NFR14) in verification plan
`68f17b0f88731394ff18f567`. X-mobile #88 (`6113cdcd8ed79096bf1596d0`) deferred it to the playtest, under VB
`b78c81ed3a69d771e712c1f5`'s partial PASS. That PR's automated checks ran in emulation (`apps/web/e2e/mobile.spec.ts`,
`keyboard.spec.ts`); this is the same flow on real devices. The aim (ADR-0012) is desktop-first, usable on phones.

**Devices.** Run it on every device in the AC34 mix:
- an **iPhone** with **iOS Safari 17+**;
- an **Android phone** with **current Chrome**;
- a **tablet** (iPad or Android), if one is in the mix.

The phone layout applies at **900 px wide or less**: one column, and every dialog is a **bottom sheet**. A tablet wider
than that gets the desktop layout, where dialogs sit in the side panel. Run the same items on it, with item 2 judged
against that layout.

**Per device: what to tap → what to look for.** Each player checks their own device during the game, and the operator
fills in the table below.

1. **Join via a link:**
   - Open the **Invite link** (`…/#join=<room code>`) from a messaging app. → It lands in the lobby at *Take a seat*;
     enter *Your name*, tap *Join*, and the roster lists the player's seat tagged **you**. There is no sign-up or login
     wall.
   - Later, open **Your rejoin link** (`…/#seat=…`) the same way. → It lands straight back in **that** seat (lobby
     tag **you**; in the game, **(you)** in the players panel), with no name prompt.
   - If the messaging app opens its own in-app browser, note that in the notes column.
2. **Layout, no horizontal scroll:**
   - On the home page, the lobby, the game and the win screen, the page never scrolls sideways.
   - The lobby's seat-order buttons (*Move seat N up/down*) are easy thumb targets.
   - In the game, the turn status and actions (*Roll dice*, *Build*, *End turn*) come right after the board.
   - Every dialog opens as a **bottom sheet** along the screen's bottom edge, fully visible, and stays put when the page
     scrolls: **Confirm**, **Discard**, **Choose who to rob**, **Year of Plenty**, **Monopoly**.
3. **Board tap → Confirm:**
   - In setup, tap a highlighted spot on the board. Later in the game, first choose *Settlement*, *Road* or *City*
     under *Build*.
   - → The **Confirm** sheet opens at once. **Confirm** places the piece for everyone; **Cancel** closes it and
     places nothing.
4. **Pinch, zoom and fit:**
   - Pinch the board out and in, and drag it to pan.
   - The **Zoom in** and **Zoom out** buttons zoom, and **Fit board** brings the whole board back into view.
5. **Reload or app-switch → resume in < 5 s (AC35):**
   - Switch to another app or lock the phone for about 10 s, then come back. Then do it once more, pulling down to
     reload.
   - → *Reconnecting…* shows at most briefly, and the player is **back in the game within 5 s** with the same hand,
     board and turn.
   - Write down the time (HH:MM) for the telemetry review, as in "The AC35 step" below.
6. **Discard and robber sheets:**
   - On a 7, a device holding more cards than the discard limit (the lobby's *Discard when holding more than*, 7 by
     default) gets the **Discard** sheet. Pick cards with *One more / One less
     <resource>*, then tap **Discard**.
   - The player who rolled the 7 taps a hex:
     - a hex where someone can be robbed opens **Choose who to rob**; tap a name;
     - an empty hex asks to **Confirm** ("Nobody there can be robbed").
   - Both sheets fit the screen and submit. If no 7 reaches this device during the game, record `–` and say so in the
     notes; the emulated run in `mobile.spec.ts` covers the sheet itself.
7. **Landscape:**
   - Rotate to landscape in the lobby and in the game.
   - → Still usable, no sideways scroll, and an open sheet fits; on a short screen it scrolls inside itself.
8. **Keyboard attached** (if one is available, e.g. an iPad with a keyboard):
   - Tab through the controls. → Every focused control shows a **visible focus ring**; a focused board spot shows a
     thicker mark.
   - When a dialog opens, it takes focus, and Tab / Shift+Tab stay inside it.
   - Escape closes the dialogs that can be cancelled (Confirm, Choose who to rob, Year of Plenty, Monopoly; not
     Discard), and focus returns to where it was (C-A11Y #101).
   - Without a keyboard, record `–`.

**Known issue KI-1:**
- WebKit checks the built-in styles of its own `<select>` controls against the page's Content Security Policy. For
  the lobby's absent-player policy select, it logs: "Refused to apply a stylesheet because its hash, its nonce, or
  'unsafe-inline' appears in neither the style-src directive nor the default-src directive of the Content Security
  Policy."
- It is expected and harmless: the select still renders and works. It is listed in `apps/web/e2e/harness.ts`
  (Playwright's WebKit build) and asserted in `full-game.spec.ts`.
- On an iPhone, the console is visible only with Safari's Web Inspector attached, and Safari may show the same
  message. Any **other** console error is a finding.

**Playtest notes, device matrix.** Attach this to the USER sign-off (`158c48596c08c8c7f50f1111`):
- Fill in one row per device, with `P`, `F` or `–` (not applicable, with the reason in the notes).
- Every `F` is filed as a `bug_report` under Web client, with the device, the browser version and what the player saw.
- Never put a rejoin link, seat token or passphrase in the notes.

```text
Hexlands game night <date>, device check (V47)
| Device (model) | OS / browser + version | Player | 1 join | 2 layout | 3 tap→Confirm | 4 pinch/zoom/fit | 5 resume <5 s (HH:MM) | 6 discard/robber | 7 landscape | 8 keyboard focus | Notes |
|----------------|------------------------|--------|--------|----------|---------------|------------------|-----------------------|------------------|-------------|------------------|-------|
| iPhone …       | iOS 17.x, Safari       |        |        |          |               |                  |                       |                  |             |                  |       |
| Android …      | Android …, Chrome …    |        |        |          |               |                  |                       |                  |             |                  |       |
| Tablet … (opt.)|                        |        |        |          |               |                  |                       |                  |             |                  |       |
```

### The AC35 step (deliberate reconnect)

At least once, mid-game, one player deliberately **reloads the page**, **switches device** (opening their rejoin link
elsewhere) or **switches network** (Wi-Fi ↔ mobile data). Write down who, which of the three, and the time
(`<player>`, `<reload | device | network>`, `<HH:MM, time zone>`), so Verify can find it in telemetry
(`catan.ws.reconnects{outcome="resumed"}` and the client-reported resume gap).

### After the game

1. Let the game reach the win screen (lifecycle `finished`). Note the room code, start and end times.
2. **Telemetry review: run Verify's V44 checklist and queries** (the V44 row of task `68f17b0f88731394ff18f567`) for
   the game's time range, against the sign-off criteria on `158c48596c08c8c7f50f1111`. The
   matching panels are in the *SLIs (NFR)* row of *Catan — game night*:
   - NFR1: *NFR1 actions ≤ 50 ms (share)*, *NFR1 p95 (all / ok)*;
   - NFR2: *NFR2 client action RTT p95 (verdict)*;
   - NFR3: *NFR3 server errors (A1 metric part, 15 min)*;
   - NFR4: *NFR4 rule/turn rejections (excl. auth)*, with *Auth rejections (daily; not in NFR4)* read separately;
   - NFR5: *NFR5 unplanned disconnects per player-hour*;
   - NFR6: *NFR6 raw counts (14 d, by outcome)* only; one evening gives no percentage verdict;
   - NFR9: *NFR9 probe success (range)*, *NFR9 failed probes in 5 min*;
   - NFR10: *NFR10 games lost on restart*.

   The same queries in one command, alongside (not instead of) the checklist: `tooling/load/gamenight-report.ts`
   prints each NFR's verdict, numbers, n and the exact query for the window, and writes them as JSON. It is
   evidence, not a gate: a FAIL means filing a bug. Exit codes are 0 for all PASS (or no verdict by design), 1 for any
   FAIL (even with missing data, which the report then lists at the top), and otherwise 2 for missing data or a
   failed query.
   ```sh
   node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/gamenight-report.ts \
     --prom-url <Grafana Prometheus proxy> --loki-url <Grafana Loki proxy> --cluster prod \
     --probe-instance https://<site>/healthz --from <start, UTC> --to <end, UTC> [--resume-at <deliberate reload, UTC>] \
     --out gamenight-report.json
   ```
   Credentials come from `GRAFANA_SA_TOKEN` or `GRAFANA_BASIC_AUTH` (or the URLs' userinfo) and are never printed.
3. **Survey** (each player, right after the game). Pass bar (AC35): median fun ≥ 4, median ease ≥ 4, and a majority
   answering yes.

   ```text
   Hexlands game night <date>, player: <name>
   1. How fun was it? (1 = not at all, 5 = a lot)                      [1] [2] [3] [4] [5]
   2. How easy was it to join and play? (1 = very hard, 5 = very easy) [1] [2] [3] [4] [5]
   3. Would you play again?                                            [yes] [no]
   4. Anything that got in the way? (optional)
   ```

### If something breaks

- **Blocking** (AC34): anything that stops the game reaching `finished`, or loses or corrupts a game. That covers a
  game that cannot continue, a state that is wrong for some players, an action that cannot be made, a game lost on a
  restart, or a player who cannot get back in. AC34 needs a full game with no blocking bug.
- **Every problem**, blocking or not, and every V44 breach is filed as a `bug_report` under the workstream that owns
  it (Rules engine, Server, Web client, Deploy & observability), with the time, the room code's game, the players
  involved, and what each player saw. Never paste a rejoin link, seat token or passphrase into a bug.
- Mid-game problems: a server restart is safe (players reconnect, the game is restored); do not deploy or restore a
  backup while the game is running unless the game is already lost.

## Restore a backup

Backups are `deploy/backups/hexlands-<UTC stamp>.db` on the host (the newest 7) and in the rclone remote.

```sh
rclone copy <remote>/<path>/hexlands-<stamp>.db deploy/backups/   # only when restoring from the remote
deploy/restore.sh deploy/backups/hexlands-<stamp>.db              # from /opt/catan
```

The backup file may be given relative to the current directory (as above), as an absolute path, or relative to
`deploy/` (`deploy/restore.sh backups/hexlands-<stamp>.db`).

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

The checks that need the real host are in "Provisioning day (ordered checklist)": the external port scan, TLS, Loki
and Tempo in Grafana Cloud, the backup through the remote, the real Synthetic Monitoring check, the alerts firing in
Grafana Cloud with Q11 delivery, and Evolve's baseline evidence. Each comes with its exact command and pass bar.

## Local rehearsal (X-deploy checks #1, #3, #6, #9–#12)

`deploy/validate/rehearse.sh` rehearses the X-deploy checks that need no real host, on this machine's Docker only (no
cloud, no spend). It brings up the production stack with `validate/compose.loki.yml` and `validate/compose.rehearsal.yml`
(64 KiB log rotation; `ops.trustedProxies` narrowed to Caddy's address so local clients are told apart), plays real
games through Caddy with the X-load bots (`validate/rehearse-games.ts`), and prints PASS/FAIL per check:

| # | Check |
|---|---|
| 1 | only Caddy publishes host ports (80/443); catan-server and Alloy publish none |
| 3 | `backup.sh`, then `restore.sh` into a fresh volume: every game (≥ 1 finished, ≥ 1 active) has the same lifecycle, seq and head hash |
| 6 | `docker compose stop` drains inside the 30 s grace (exit 0, `server.stopped {drain_ms}`); the host's `TimeoutStopSec` exceeds the grace; the restart logs `previous_shutdown: clean`, `lost_on_restart: 0`, games identical |
| 9 | the server's json-file logs rotate; the rotated and current files hold none of the rehearsal's room codes or seat tokens and nothing matching A1's secret-shape regex (`validate/scan-logs.ts`) |
| 10 | through the real Caddy, 6 creates with 6 different spoofed `X-Forwarded-For` values are followed by a 429 (the spoof never changes the limiter key), while another client's create succeeds |
| 12 | a build whose `HEXLANDS_BUILD_VERSION` differs from the bundle logs ERROR `server.bundle_version_mismatch` and keeps serving; a matched build logs neither mismatch nor missing |
| 11 | `deploy.sh --force` (with `HEXLANDS_DEPLOY_COMPOSE_OVERLAYS` keeping the local Loki) writes the marker while games are active, rolls the stack, passes the smoke, and `deploy.forced` reaches the local Loki |

```sh
deploy/validate/rehearse.sh            # tears the stack down afterwards; --keep leaves it running
```

It needs Docker with compose, `pnpm install` (the bots run on the host), `curl`, and `sudo` to read the container log
files for #9. It uses `deploy/.env` only when there is none (writing and later removing a placeholder rehearsal
`.env`); an existing `.env` is never touched. Evidence goes to `$OUT` (default `/tmp/hexlands-rehearsal-<stamp>`); the
room codes and seat tokens it records for #9 stay in a 0600 file there and are never printed.

What a local run cannot show, left for the real host: local clients have private addresses, so whether real public
IPv4 and IPv6 clients each get their own limiter key behind Docker's port publishing is checked on provisioning day
(L6 and L7 in "Provisioning day (ordered checklist)"). That section re-runs #1, #3, #6, #9, #10, #11 and #12 on the
real host.

## Load test (X-load, AC32)

Run it in a separate, short-lived environment:
- set `HEXLANDS_ENV=loadtest` in `.env`, so every signal carries `cluster=loadtest` and the run stays out of prod
  baselines;
- add `compose.loadtest.yml`, which raises the per-IP room-create limit, because all bots come from one host;
- start from an empty `catan-data` volume, because `maxActiveGames` (10) also counts leftover lobbies.
- if the environment sets `HEXLANDS_ROOMS_CREATE_PASSPHRASE`, export the same value in the bot host's shell; the
  runner sends it with each room create and never prints it.

```sh
# On the server, from /opt/catan. deploy.sh builds catan-server:<sha>; the overlay then recreates the server with the
# raised limit. Compose needs HEXLANDS_BUILD_VERSION (the image tag) for every command, so set it inline:
deploy/deploy.sh
cd deploy && HEXLANDS_BUILD_VERSION="$(git rev-parse --short=12 HEAD)" docker compose --env-file .env -f docker-compose.yml -f compose.loadtest.yml up -d

# On the bot host (from the repo root). Record where it runs ("same continent"):
node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/run.ts \
  --url https://<host> --games 10 --players 4 --minutes 30 --bot-location "<city, region>" --report load-report.json
#   optional planned restart mid-run:
#   --restart-at-sec 900 --restart-cmd "ssh <server> 'cd /opt/catan/deploy && HEXLANDS_BUILD_VERSION=unused docker compose --env-file .env -f docker-compose.yml -f compose.loadtest.yml restart catan-server'"

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

**Deferred to provisioning:** the 30-min load run, the 2-h soak on the production-size instance, and Evolve's
evidence (trace and log bytes per game, and Alloy RSS/CPU next to the server's). They are L1–L3 in "Provisioning day
(ordered checklist)", with the commands and pass bars.

**Series count (V32):** run this after the load run, against the same Prometheus API. It checks fewer than 500 active
series for the environment (Alloy's own included), the app series against the catalogue's worst case
(`worstCaseSeries()`, 309), a per-metric breakdown, and the resource attributes on `target_info`. It exits 1 if a check
fails:

```sh
node --experimental-strip-types --no-warnings --import ./tooling/ts-resolve-hook.mjs tooling/load/series-count.ts \
  --prom-url https://<stack>.grafana.net/api/datasources/proxy/uid/grafanacloud-prom --cluster loadtest
```

Alloy's own metrics count against the same limit. Exporting them (not done today, per G6) would add about 545 series
for Alloy v1.11.3 under load, enough to fail the check on its own.

Credentials for both tools come from `GRAFANA_SA_TOKEN` or `GRAFANA_BASIC_AUTH` in the environment, or from userinfo in
`--prom-url`. They are sent as an Authorization header and never printed: errors name the URL without its userinfo and
query.
