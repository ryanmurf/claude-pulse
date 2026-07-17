# Deploying the central pod (usage.murphytek.com)

Runbook for rolling a new `main` build of claude-pulse onto the **central
receiver** that serves https://usage.murphytek.com.

> **Where it runs:** the pod is a **microk8s** Deployment on **tron**
> (`usage.murphytek.com` → `66.7.119.163` is tron's public IP behind NAT). So
> the deploy runs **on tron**, using `microk8s kubectl` (plain `kubectl` on tron
> is mis-configured — always prefix `microk8s`).
>
> | Thing | Value |
> |---|---|
> | Namespace | **`herodevs`** (NOT `murphytek` — that ns is the homepage/minecraft) |
> | Deployment | `claude-pulse-dashboard` · container name **`dashboard`** |
> | Image | `localhost:32000/claude-pulse-dashboard:<tag>` (microk8s **registry** addon at `localhost:32000`) |
> | Pull policy | `IfNotPresent` → **bump the tag every deploy** or it won't re-pull |
> | Service / ingress | ClusterIP `:7778` ← ingress `usage-dashboard` (herodevs ns) |
> | DB | Postgres via `CLAUDE_PULSE_PG_URL` env on the deploy |
> | Dashboard account | data is under `ryanmurf@gmail.com` (the oauth-proxy email) |

---

## When you need to deploy (vs. when you don't)

The central pod is a **pure receiver**: reporters (tron, clu, …) compute their
own `effective_limit`/`context_pct` and POST them. So:

| Change | Needs a pod redeploy? |
|---|---|
| **Context-window limits** (`src/context.ts` `MODEL_LIMITS`) | **No** — recomputed by each reporter at upload time. It lands as soon as every reporter is rebuilt + re-uploads. |
| **Dashboard / API rendering** (`src/server.ts`, e.g. the 3-sessions-per-machine cap on `/api/context`) | **Yes** — this runs in the pod. |

The current change (`#10`, commit `e2c1cb3`) has **both**: the 1M-limit fix
(already live via tron + clu uploads) **and** the `/api/context` cap of 3
sessions/machine (**needs this deploy**).

---

## What the pod is

A container built from the repo `Dockerfile`:

- `FROM node:24-slim`, `npm ci --omit=dev`, copies the **prebuilt `dist/`**.
- Runs `node dist/index.js` with `CLAUDE_PULSE_SERVER_ONLY=1` (receiver-only:
  no pollers, no MCP stdio), `CLAUDE_PULSE_PORT=7778`, `HOME=/home/ryan`.
- Stateless image — Postgres (`CLAUDE_PULSE_PG_URL`) + auth come from the
  deploy's env, **not** baked in. `set image` preserves that env.

CI (`.github/workflows/`) **builds + tests** on push to `main` and **publishes
to npm only on a GitHub *release***. **Neither workflow builds/pushes the
container image, nor deploys.** The image build + rollout is **manual on tron**
(steps below).

---

## Deploy steps (run on tron)

```bash
# 1. Get the merged code
cd ~/IdeaProjects/claude-pulse
git checkout main && git pull --ff-only origin main
git log --oneline -1                       # confirm the commit you intend to ship

# 2. Build deps + dist (the Dockerfile COPYs a PREbuilt dist/)
npm ci
npm run build                              # tsc → dist/   (must exit 0)

# 3. Build + push the image to the microk8s registry. BUMP THE TAG
#    (pullPolicy IfNotPresent will not re-pull a reused tag). Current: 0.5.6
#    (deployed 2026-06-12, PR #19 — settings behind header gear toggle; 0.5.5 =
#    PRs #14-#18 hardening batch).
TAG=0.5.7                                  # next version
docker build -t localhost:32000/claude-pulse-dashboard:$TAG .
docker push        localhost:32000/claude-pulse-dashboard:$TAG

# 4. Roll it out (note: microk8s kubectl, herodevs ns, container name 'dashboard')
microk8s kubectl -n herodevs set image deploy/claude-pulse-dashboard \
  dashboard=localhost:32000/claude-pulse-dashboard:$TAG
microk8s kubectl -n herodevs rollout status deploy/claude-pulse-dashboard --timeout=120s
```

---

## Verify the deploy

```bash
# 1. New pod is Running on the tag you shipped, 0 restarts, receiver-only:
microk8s kubectl -n herodevs get pod -l app=claude-pulse-dashboard \
  -o jsonpath='{range .items[*]}{.metadata.name}  {.status.phase}  {.status.containerStatuses[0].image}  restarts={.status.containerStatuses[0].restartCount}{"\n"}{end}'
microk8s kubectl -n herodevs logs deploy/claude-pulse-dashboard --tail=4   # expect "Receiver-only mode"

# 2. Site responds (302 = oauth-proxy redirect, normal):
curl -s -o /dev/null -w "%{http_code}\n" https://usage.murphytek.com/

# 3. Cap is live — port-forward past the oauth proxy and query as the
#    DATA-OWNING account (ryanmurf@gmail.com, not ryanm@herodevs.com):
microk8s kubectl -n herodevs port-forward deploy/claude-pulse-dashboard 17799:7778 >/tmp/pf.log 2>&1 &
PF=$!; sleep 4
curl -s http://127.0.0.1:17799/api/context -H "X-Auth-Request-Email: ryanmurf@gmail.com" | \
  python3 -c 'import sys,json
d=json.load(sys.stdin)
c=[(p["profile"],m["machine"],len(m["sessions"])) for p in d for m in p["machines"]]
print(c); print("MAX/machine:", max([x[2] for x in c], default=0), "=> OK:", max([x[2] for x in c], default=0)<=3)'
kill $PF
# every machine's session count must be <= 3
```

Also confirm an Opus 4.8 session reads ~ (tokens / 1,000,000), not >100% — though
that comes from the **reporters** (rebuild + re-upload each box), not this deploy.
