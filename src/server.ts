import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { redactProfile } from "./redact.js";
import {
  listProfiles,
  getLatestSnapshot,
  getLatestSnapshots,
  getHistory,
  getTriggeredAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
  listAlertSubscriptions,
  createAlertSubscription,
  removeAlertSubscription,
  getProfile,
  getLatestGeminiQuota,
} from "./store.js";
import { pollProfile, pollAllProfiles } from "./poller.js";
import { formatGeminiQuotaSnapshots, pollGeminiQuota } from "./gemini.js";
import type { AlertType } from "./types.js";

let httpServer: http.Server | undefined;

const DEFAULT_PORT = 7778;

function log(msg: string): void {
  process.stderr.write(`[claude-pulse] ${new Date().toISOString()} ${msg}\n`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, { error: message }, status);
}

// ── Pace computation (shared with get_pace tool) ─────────────────────────────

interface PaceInfo {
  profile: string;
  window: string;
  used_pct: number;
  remaining: string;
  elapsed_pct: number;
  pace: string;
}

const WINDOW_DURATIONS: Record<string, number> = {
  five_hour: 5 * 60 * 60 * 1000,
  seven_day: 7 * 24 * 60 * 60 * 1000,
};

function formatRemaining(ms: number): string {
  if (ms <= 0) return "resetting now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h ${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d ${rh}h` : `${days}d`;
}

function computePace(profileFilter?: string): PaceInfo[] {
  const results: PaceInfo[] = [];
  const names = profileFilter
    ? [profileFilter]
    : listProfiles().map((p) => p.name);

  for (const name of names) {
    const snap = getLatestSnapshot(name);
    if (!snap) continue;

    const windows = [
      { key: "five_hour", label: "5h", pct: snap.five_hour_pct, resets: snap.five_hour_resets_at },
      { key: "seven_day", label: "7d", pct: snap.seven_day_pct, resets: snap.seven_day_resets_at },
    ];

    for (const w of windows) {
      if (w.pct === null || !w.resets) continue;
      const duration = WINDOW_DURATIONS[w.key];
      if (!duration) continue;

      const now = Date.now();
      const resetMs = new Date(w.resets).getTime();
      const remaining = resetMs - now;
      const elapsed = duration - remaining;
      const elapsedPct = Math.max((elapsed / duration) * 100, 1);
      const ratio = w.pct / elapsedPct;

      let pace: string;
      if (ratio > 1.5 && w.pct > 50) pace = "conserve";
      else if (ratio < 0.5 && remaining < 3_600_000) pace = "capacity available";
      else if (ratio > 1.2) pace = "slightly fast";
      else pace = "on track";

      results.push({
        profile: name,
        window: w.label,
        used_pct: w.pct,
        remaining: formatRemaining(remaining),
        elapsed_pct: Math.round(elapsedPct * 10) / 10,
        pace,
      });
    }
  }
  return results;
}

// ── Request router ───────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  try {
    // Dashboard
    if (pathname === "/" && method === "GET") {
      sendHtml(res, DASHBOARD_HTML);
      return;
    }

    // GET /api/profiles
    if (pathname === "/api/profiles" && method === "GET") {
      sendJson(res, listProfiles().map(redactProfile));
      return;
    }

    // GET /api/usage
    if (pathname === "/api/usage" && method === "GET") {
      const snapshots = getLatestSnapshots();
      const profiles = listProfiles();
      const result = profiles.map((p) => {
        const snap = snapshots.find((s) => s.profile === p.name);
        return {
          profile: p.name,
          five_hour_pct: snap?.five_hour_pct ?? null,
          five_hour_resets_at: snap?.five_hour_resets_at ?? null,
          seven_day_pct: snap?.seven_day_pct ?? null,
          seven_day_resets_at: snap?.seven_day_resets_at ?? null,
          polled_at: snap?.polled_at ?? null,
        };
      });
      sendJson(res, result);
      return;
    }

    // GET /api/gemini-quota
    if (pathname === "/api/gemini-quota" && method === "GET") {
      sendJson(res, formatGeminiQuotaSnapshots(getLatestGeminiQuota()));
      return;
    }

    // GET /api/history?profile=X&hours=24
    if (pathname === "/api/history" && method === "GET") {
      const profile = url.searchParams.get("profile");
      if (!profile) { sendError(res, 400, "Missing profile parameter"); return; }
      const hours = parseInt(url.searchParams.get("hours") || "24", 10);
      const limit = parseInt(url.searchParams.get("limit") || "100", 10);
      sendJson(res, getHistory(profile, hours, limit));
      return;
    }

    // GET /api/pace
    if (pathname === "/api/pace" && method === "GET") {
      const profile = url.searchParams.get("profile") || undefined;
      sendJson(res, computePace(profile));
      return;
    }

    // GET /api/alerts
    if (pathname === "/api/alerts" && method === "GET") {
      const profile = url.searchParams.get("profile") || undefined;
      const hours = parseInt(url.searchParams.get("hours") || "24", 10);
      const unacked = url.searchParams.get("unacknowledged_only") === "true";
      sendJson(res, getTriggeredAlerts(profile, hours, unacked));
      return;
    }

    // POST /api/alerts/acknowledge
    if (pathname === "/api/alerts/acknowledge" && method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (body.id !== undefined) {
        sendJson(res, { success: acknowledgeAlert(body.id) });
      } else {
        const count = acknowledgeAllAlerts(body.profile || undefined);
        sendJson(res, { success: true, count });
      }
      return;
    }

    // GET /api/subscriptions
    if (pathname === "/api/subscriptions" && method === "GET") {
      const profile = url.searchParams.get("profile") || undefined;
      sendJson(res, listAlertSubscriptions(profile));
      return;
    }

    // POST /api/subscriptions
    if (pathname === "/api/subscriptions" && method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (!body.profile || !body.alert_type) {
        sendError(res, 400, "Missing profile or alert_type");
        return;
      }
      if (!getProfile(body.profile)) {
        sendError(res, 404, `Profile "${body.profile}" not found`);
        return;
      }
      const threshold = body.alert_type === "auth_failure" ? null : (body.threshold ?? null);
      if (body.alert_type !== "auth_failure" && threshold === null) {
        sendError(res, 400, "Threshold required for threshold alerts");
        return;
      }
      const sub = createAlertSubscription(
        body.profile,
        body.alert_type as AlertType,
        threshold,
        body.channel || null,
        body.cooldown_minutes ?? 30,
      );
      sendJson(res, sub, 201);
      return;
    }

    // DELETE /api/subscriptions/:id
    if (pathname.startsWith("/api/subscriptions/") && method === "DELETE") {
      const id = parseInt(pathname.split("/").pop()!, 10);
      if (isNaN(id)) { sendError(res, 400, "Invalid subscription ID"); return; }
      sendJson(res, { success: removeAlertSubscription(id) });
      return;
    }

    // POST /api/poll
    if (pathname === "/api/poll" && method === "POST") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};
      if (body.profile) {
        sendJson(res, await pollProfile(body.profile));
      } else {
        const [profiles, gemini] = await Promise.all([pollAllProfiles(), pollGeminiQuota()]);
        sendJson(res, { profiles, gemini });
      }
      return;
    }

    sendError(res, 404, "Not found");
  } catch (err) {
    log(`HTTP handler error: ${err}`);
    sendError(res, 500, "Internal server error");
  }
}

// ── Dashboard HTML ───────────────────────────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude-pulse</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cpath d='M2 16h6l4-12 4 24 4-18 4 6h6' fill='none' stroke='%238b5cf6' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0b0b1a;--surface:#111128;--surface-2:#1a1a36;--border:#252548;
  --text:#d0d0e8;--muted:#6e6e8e;
  --green:#10b981;--yellow:#f59e0b;--red:#ef4444;--blue:#3b82f6;--purple:#8b5cf6;
  --font:system-ui,-apple-system,'Segoe UI',sans-serif;
  --mono:'SF Mono','Fira Code','JetBrains Mono',monospace;
}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.5;min-height:100vh}
.container{max-width:1200px;margin:0 auto;padding:24px}

header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid var(--border)}
header h1{font-size:1.5rem;font-weight:600}
header h1 span{color:var(--purple)}
.hdr-right{display:flex;gap:12px;align-items:center}
.status{font-size:.78rem;color:var(--muted);font-family:var(--mono)}

.btn{padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:.85rem;cursor:pointer;transition:all .15s;font-family:var(--font)}
.btn:hover{border-color:var(--purple);background:#1e1e40}
.btn-sm{padding:3px 10px;font-size:.75rem}
.btn-danger{border-color:var(--red);color:var(--red)}
.btn-danger:hover{background:rgba(239,68,68,.15)}

.section{margin-bottom:32px}
.section-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.section-hdr h2{font-size:1.05rem;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}

.usage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px}
.card-title{font-size:1rem;font-weight:600;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}
.card-title .meta{font-size:.72rem;color:var(--muted);font-family:var(--mono);display:flex;gap:10px;align-items:center}
.win-row{margin-bottom:14px}
.win-row:last-child{margin-bottom:0}
.win-lbl{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;font-size:.85rem}
.win-lbl .pct{font-family:var(--mono);font-weight:600}
.win-lbl .resets{font-size:.72rem;color:var(--muted)}
.bar{height:8px;background:var(--surface-2);border-radius:4px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .4s ease}
.bar-green .bar-fill{background:var(--green)}
.bar-yellow .bar-fill{background:var(--yellow)}
.bar-red .bar-fill{background:var(--red)}
.bar-none .bar-fill{background:var(--muted)}

.pace{display:inline-block;font-size:.68rem;padding:1px 7px;border-radius:10px;font-family:var(--mono);margin-left:6px}
.pace-on-track{background:rgba(16,185,129,.12);color:var(--green)}
.pace-slightly-fast{background:rgba(245,158,11,.12);color:var(--yellow)}
.pace-conserve{background:rgba(239,68,68,.12);color:var(--red)}
.pace-capacity-available{background:rgba(59,130,246,.12);color:var(--blue)}

.tbl-wrap{background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;padding:8px 12px;font-weight:500;color:var(--muted);border-bottom:1px solid var(--border);font-size:.78rem}
td{padding:8px 12px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}

.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:.7rem;font-family:var(--mono)}
.badge-acked{background:rgba(16,185,129,.12);color:var(--green)}
.badge-unacked{background:rgba(245,158,11,.12);color:var(--yellow)}
.badge-type{background:rgba(139,92,246,.12);color:var(--purple)}

.form-row{display:flex;gap:8px;align-items:center;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-top:12px;flex-wrap:wrap}
.form-row select,.form-row input{padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:.85rem;font-family:var(--font)}
.form-row select:focus,.form-row input:focus{outline:none;border-color:var(--purple)}
.empty{text-align:center;padding:24px;color:var(--muted);font-size:.88rem}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>claude</span>-pulse</h1>
    <div class="hdr-right">
      <span class="status" id="status">loading...</span>
      <button class="btn" onclick="refresh()">Refresh</button>
      <button class="btn" onclick="pollAll()">Poll All</button>
    </div>
  </header>

  <div class="section">
    <div class="section-hdr"><h2>Usage</h2></div>
    <div class="usage-grid" id="usage-grid"><div class="empty">Loading...</div></div>
  </div>

  <div class="section">
    <div class="section-hdr"><h2>Gemini</h2></div>
    <div class="usage-grid" id="gemini-grid"><div class="empty">Loading...</div></div>
  </div>

  <div class="section">
    <div class="section-hdr">
      <h2>Recent Alerts</h2>
      <button class="btn btn-sm" onclick="ackAll()">Acknowledge All</button>
    </div>
    <div class="tbl-wrap">
      <table><thead><tr><th>Time</th><th>Profile</th><th>Type</th><th>Message</th><th>Status</th><th></th></tr></thead>
      <tbody id="alerts-body"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody></table>
    </div>
  </div>

  <div class="section">
    <div class="section-hdr"><h2>Subscriptions</h2></div>
    <div class="tbl-wrap">
      <table><thead><tr><th>ID</th><th>Profile</th><th>Type</th><th>Threshold</th><th>Cooldown</th><th>Status</th><th></th></tr></thead>
      <tbody id="subs-body"><tr><td colspan="7" class="empty">Loading...</td></tr></tbody></table>
    </div>
    <div class="form-row">
      <select id="sub-profile"></select>
      <select id="sub-type" onchange="toggleThreshold()">
        <option value="five_hour_threshold">5h threshold</option>
        <option value="seven_day_threshold">7d threshold</option>
        <option value="auth_failure">Auth failure</option>
      </select>
      <input type="number" id="sub-threshold" placeholder="Threshold %" min="1" max="100" style="width:100px">
      <input type="number" id="sub-cooldown" placeholder="Cooldown min" value="30" min="1" style="width:110px">
      <button class="btn" onclick="createSub()">Add</button>
    </div>
  </div>
</div>

<script>
const $=s=>document.querySelector(s);

async function fj(url){const r=await fetch(url);return r.json()}
async function pj(url,body={}){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json()}

function timeAgo(iso){
  if(!iso)return'—';
  const d=Date.now()-new Date(iso+(iso.endsWith('Z')?'':'Z')).getTime();
  const m=Math.floor(d/60000);
  if(m<1)return'just now';if(m<60)return m+'m ago';
  const h=Math.floor(m/60);if(h<24)return h+'h ago';
  return Math.floor(h/24)+'d ago';
}
function barColor(p){if(p===null)return'bar-none';if(p>=80)return'bar-red';if(p>=50)return'bar-yellow';return'bar-green'}
function paceClass(p){return'pace-'+p.replace(/ /g,'-')}
function fmtPct(p){return p!==null?p.toFixed(1)+'%':'\\u2014'}
function countdown(iso){
  if(!iso)return'';
  const ms=new Date(iso).getTime()-Date.now();
  if(Number.isNaN(ms))return'';
  if(ms<=0)return'resetting now';
  const m=Math.floor(ms/60000);
  if(m<60)return m+'m';
  const h=Math.floor(m/60),rm=m%60;
  if(h<24)return rm?h+'h '+rm+'m':h+'h';
  const d=Math.floor(h/24),rh=h%24;
  return rh?d+'d '+rh+'h':d+'d';
}

function renderUsage(usage,pace){
  const g=$('#usage-grid');
  if(!usage.length){g.innerHTML='<div class="empty">No profiles configured</div>';return}
  g.innerHTML=usage.map(u=>{
    const fh=pace.find(p=>p.profile===u.profile&&p.window==='5h');
    const sd=pace.find(p=>p.profile===u.profile&&p.window==='7d');
    return\`<div class="card">
      <div class="card-title">\${u.profile}<span class="meta">\${u.polled_at?timeAgo(u.polled_at):'never polled'}
        <button class="btn btn-sm" onclick="pollOne('\${u.profile}')">Poll</button></span></div>
      \${renderWin('5-hour',u.five_hour_pct,fh)}
      \${renderWin('7-day',u.seven_day_pct,sd)}
    </div>\`}).join('');
}
function renderWin(label,pct,pi){
  const v=pct!==null?pct:0,c=barColor(pct);
  const rem=pi?pi.remaining:'';
  const pb=pi?\`<span class="pace \${paceClass(pi.pace)}">\${pi.pace}</span>\`:'';
  return\`<div class="win-row"><div class="win-lbl"><span>\${label} \${pb}</span><span><span class="pct">\${fmtPct(pct)}</span>\${rem?' <span class="resets">'+rem+' left</span>':''}</span></div><div class="bar \${c}"><div class="bar-fill" style="width:\${v}%"></div></div></div>\`;
}

function renderGemini(quota){
  const g=$('#gemini-grid');
  if(!quota.length){g.innerHTML='<div class="empty">No Gemini quota data yet</div>';return}
  g.innerHTML=quota.map(q=>{
    const reset=countdown(q.reset_time);
    return\`<div class="card">
      <div class="card-title">\${q.model_id}<span class="meta">\${q.timestamp?timeAgo(q.timestamp):'never polled'}</span></div>
      <div class="win-row"><div class="win-lbl"><span>quota</span><span><span class="pct">\${fmtPct(q.used_pct)}</span>\${reset?' <span class="resets">'+reset+' left</span>':''}</span></div><div class="bar \${barColor(q.used_pct)}"><div class="bar-fill" style="width:\${Math.max(0,Math.min(100,q.used_pct))}%"></div></div></div>
    </div>\`}).join('');
}

function renderAlerts(alerts){
  const b=$('#alerts-body');
  if(!alerts.length){b.innerHTML='<tr><td colspan="6" class="empty">No recent alerts</td></tr>';return}
  b.innerHTML=alerts.map(a=>\`<tr>
    <td style="font-family:var(--mono);font-size:.72rem">\${timeAgo(a.triggered_at)}</td>
    <td>\${a.profile}</td>
    <td><span class="badge badge-type">\${a.alert_type}</span></td>
    <td>\${a.message}</td>
    <td>\${a.acknowledged?'<span class="badge badge-acked">acked</span>':'<span class="badge badge-unacked">pending</span>'}</td>
    <td>\${!a.acknowledged?'<button class="btn btn-sm" onclick="ackOne('+a.id+')">Ack</button>':''}</td>
  </tr>\`).join('');
}

function renderSubs(subs){
  const b=$('#subs-body');
  if(!subs.length){b.innerHTML='<tr><td colspan="7" class="empty">No subscriptions</td></tr>';return}
  b.innerHTML=subs.map(s=>\`<tr>
    <td style="font-family:var(--mono)">\${s.id}</td>
    <td>\${s.profile}</td>
    <td><span class="badge badge-type">\${s.alert_type}</span></td>
    <td>\${s.threshold!==null?s.threshold+'%':'\\u2014'}</td>
    <td>\${s.cooldown_minutes}m</td>
    <td>\${s.enabled?'<span class="badge badge-acked">active</span>':'<span class="badge badge-unacked">off</span>'}</td>
    <td><button class="btn btn-sm btn-danger" onclick="delSub(\${s.id})">Delete</button></td>
  </tr>\`).join('');
}

function fillProfiles(profiles){
  const s=$('#sub-profile');
  s.innerHTML=profiles.map(p=>'<option value="'+p.name+'">'+p.name+'</option>').join('');
}

function toggleThreshold(){
  $('#sub-threshold').style.display=$('#sub-type').value==='auth_failure'?'none':'';
}

async function refresh(){
  try{
    const[usage,gemini,pace,alerts,subs,profiles]=await Promise.all([
      fj('/api/usage'),fj('/api/gemini-quota'),fj('/api/pace'),fj('/api/alerts?hours=24'),fj('/api/subscriptions'),fj('/api/profiles')
    ]);
    renderUsage(usage,pace);renderGemini(gemini);renderAlerts(alerts);renderSubs(subs);fillProfiles(profiles);
    $('#status').textContent='updated '+new Date().toLocaleTimeString();
  }catch(e){$('#status').textContent='error: '+e.message}
}
async function pollAll(){$('#status').textContent='polling...';await pj('/api/poll');await refresh()}
async function pollOne(p){$('#status').textContent='polling '+p+'...';await pj('/api/poll',{profile:p});await refresh()}
async function ackOne(id){await pj('/api/alerts/acknowledge',{id});await refresh()}
async function ackAll(){await pj('/api/alerts/acknowledge',{});await refresh()}
async function delSub(id){await fetch('/api/subscriptions/'+id,{method:'DELETE'});await refresh()}
async function createSub(){
  const profile=$('#sub-profile').value,at=$('#sub-type').value;
  const th=at==='auth_failure'?undefined:parseFloat($('#sub-threshold').value);
  const cd=parseInt($('#sub-cooldown').value)||30;
  if(at!=='auth_failure'&&(!th||isNaN(th))){alert('Threshold required');return}
  await pj('/api/subscriptions',{profile,alert_type:at,threshold:th,cooldown_minutes:cd});
  $('#sub-threshold').value='';await refresh();
}

refresh();setInterval(refresh,30000);
</script>
</body>
</html>`;

// ── Start / Stop ─────────────────────────────────────────────────────────────

export function startHttpServer(port?: number): void {
  const p = port ?? parseInt(process.env.CLAUDE_PULSE_PORT || String(DEFAULT_PORT), 10);

  httpServer = http.createServer(handleRequest);

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log(`Dashboard port ${p} already in use, HTTP server not started`);
    } else {
      log(`HTTP server error: ${err}`);
    }
  });

  httpServer.listen(p, () => {
    log(`Dashboard available at http://localhost:${p}`);
  });
}

export function stopHttpServer(): void {
  if (httpServer) {
    httpServer.close();
    httpServer = undefined;
    log("HTTP server stopped");
  }
}
