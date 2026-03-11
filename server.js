const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ───────────────────────────────────────────────────────────────────

const OPENCLAW_JSON = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw', 'openclaw.json');
let GATEWAY_TOKEN = '';
let GATEWAY_PORT = 18789;

try {
  const cfg = JSON.parse(fs.readFileSync(OPENCLAW_JSON, 'utf8'));
  GATEWAY_TOKEN = cfg?.gateway?.auth?.token || '';
  GATEWAY_PORT = cfg?.gateway?.port || 18789;
} catch (e) {
  console.warn('Could not read openclaw.json:', e.message);
}

// ── Version ──────────────────────────────────────────────────────────────────

let openclawVersion = 'unknown';
try {
  openclawVersion = execSync('openclaw --version', { timeout: 5000 }).toString().trim();
} catch (_) {}

// ── Agent mapping ────────────────────────────────────────────────────────────

const AGENT_DEFS = {
  sai:   { id: 'sai',   name: 'Sai',   emoji: '⚡', role: 'Orchestrator',  defaultModel: 'claude-sonnet-4-6',  fallback: 'gpt-5.4' },
  cody:  { id: 'cody',  name: 'Cody',  emoji: '🧑‍💻', role: 'Coder',         defaultModel: 'gpt-5.4',            fallback: 'kimi-k2.5' },
  rory:  { id: 'rory',  name: 'Rory',  emoji: '🔍', role: 'Researcher',    defaultModel: 'claude-sonnet-4-6',  fallback: 'gpt-5.4' },
  jamal: { id: 'jamal', name: 'Jamal', emoji: '✅', role: 'Tester',        defaultModel: 'claude-opus-4-6',    fallback: 'gpt-5.4' },
};

const TEAM_CONTRACTS = [
  {
    id: 'sai',
    title: 'Sai · Orchestrate',
    summary: 'Owns routing, context, and final delivery. Delegates specialized work and keeps the operator loop clean.',
  },
  {
    id: 'cody',
    title: 'Cody · Build',
    summary: 'Implements code and product changes directly in-repo with practical scope control and clean handoff notes.',
  },
  {
    id: 'rory',
    title: 'Rory · Research',
    summary: 'Finds facts, options, benchmarks, and synthesis before execution decisions or external-facing claims.',
  },
  {
    id: 'jamal',
    title: 'Jamal · Verify',
    summary: 'Checks quality, regressions, and actionability before outputs are treated as ready.',
  },
];

// ── In-memory state ──────────────────────────────────────────────────────────

const agents = {};
for (const [id, def] of Object.entries(AGENT_DEFS)) {
  agents[id] = {
    ...def,
    status: 'OFFLINE',
    task: null,
    model: def.defaultModel,
    lastSeen: null,
    percentUsed: 0,
    totalTokens: 0,
    contextTokens: 200000,
    inputTokens: 0,
    outputTokens: 0,
    sessionCount: 0,
  };
}

const system = {
  ttsVoice: 'en_GB-northern_english_male-medium',
  ttsStatus: 'unknown',
  ttsModel: null,
  heartbeatInterval: '4h',
  heartbeatModel: 'ollama/qwen3:4b',
  cronJobs: [],
  cronCount: 0,
  gatewayPort: GATEWAY_PORT,
  openclawVersion,
  gatewayUptime: Date.now(),
  teamContracts: TEAM_CONTRACTS,
};

const metrics = {
  totalSessions: 0,
  activeSessions: 0,
  activeAgents: 0,
  totalTokensUsed: 0,
  uptime: Date.now(),
  usage: {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    activeMainSessionKey: null,
    activeMainSessionAgeMs: null,
    activeMainSessionTokens: 0,
    currentUtilizationPercent: null,
    currentContextTokens: null,
    burnRateTokensPerHour: null,
    burnRateWindowMinutes: null,
    projectedMinutesToFullContext: null,
    projectedEtaIso: null,
    forecastStatus: 'insufficient_data',
    forecastNote: 'Insufficient data',
    recentSessionSample: 0,
  },
};

const MAX_FEED = 200;
const activityFeed = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function round(value, places = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function parseAgentFromSessionKey(key) {
  const match = String(key || '').match(/^agent:([^:]+):/i);
  if (!match) return null;
  const agentId = match[1].toLowerCase();
  return agentId === 'main' ? 'sai' : agentId;
}

function humanizeSubagentTask(session) {
  const key = String(session?.key || '');
  if (!key.includes(':subagent:')) return null;
  const mappedAgent = parseAgentFromSessionKey(key);
  const role = agents[mappedAgent]?.role || 'Subagent';
  return `${role} task active`;
}

function computeUsageInsights(allRecent) {
  const sessions = Array.isArray(allRecent) ? allRecent : [];
  const totalInputTokens = sessions.reduce((sum, s) => sum + safeNumber(s.inputTokens), 0);
  const totalOutputTokens = sessions.reduce((sum, s) => sum + safeNumber(s.outputTokens), 0);

  const mainCandidates = sessions
    .filter(s => (s.key || '').includes(':main'))
    .sort((a, b) => safeNumber(a.age) - safeNumber(b.age));

  const activeMain = mainCandidates.find(s => safeNumber(s.age) < 300000) || mainCandidates[0] || null;
  const currentUtilizationPercent = activeMain && activeMain.percentUsed != null
    ? safeNumber(activeMain.percentUsed)
    : null;
  const currentContextTokens = activeMain && activeMain.contextTokens != null
    ? safeNumber(activeMain.contextTokens)
    : null;
  const activeMainSessionTokens = activeMain ? safeNumber(activeMain.totalTokens) : 0;

  const burnSessions = sessions.filter(s => {
    const age = safeNumber(s.age);
    const totalTokens = safeNumber(s.totalTokens);
    return age > 0 && age <= 6 * 60 * 60 * 1000 && totalTokens > 0;
  });

  let burnRateTokensPerHour = null;
  let burnRateWindowMinutes = null;

  if (burnSessions.length > 0) {
    const weightedTotal = burnSessions.reduce((sum, s) => sum + safeNumber(s.totalTokens), 0);
    const weightedHours = burnSessions.reduce((sum, s) => {
      const ageHours = Math.max(safeNumber(s.age) / 3600000, 0.08);
      return sum + Math.min(ageHours, 6);
    }, 0);

    if (weightedHours > 0) {
      burnRateTokensPerHour = weightedTotal / weightedHours;
      const oldestAgeMs = burnSessions.reduce((max, s) => Math.max(max, safeNumber(s.age)), 0);
      burnRateWindowMinutes = round(oldestAgeMs / 60000, 0);
    }
  }

  let projectedMinutesToFullContext = null;
  let projectedEtaIso = null;
  let forecastStatus = 'insufficient_data';
  let forecastNote = 'Insufficient data';

  if (activeMain && currentContextTokens && currentContextTokens > 0 && burnRateTokensPerHour && burnRateTokensPerHour > 0) {
    const remainingTokens = Math.max(currentContextTokens - activeMainSessionTokens, 0);
    const minutes = remainingTokens === 0 ? 0 : (remainingTokens / burnRateTokensPerHour) * 60;
    projectedMinutesToFullContext = round(minutes, 0);
    projectedEtaIso = new Date(Date.now() + minutes * 60000).toISOString();
    forecastStatus = remainingTokens === 0 ? 'full' : 'ok';
    forecastNote = remainingTokens === 0
      ? 'Main session is at or above known context capacity.'
      : 'Simple projection based on recent token totals across active sessions.';
  } else if (activeMain && currentUtilizationPercent != null) {
    forecastStatus = 'limited';
    forecastNote = 'Utilization is available, but burn rate is too sparse for a stable ETA.';
  }

  return {
    totalInputTokens,
    totalOutputTokens,
    activeMainSessionKey: activeMain?.key || null,
    activeMainSessionAgeMs: activeMain?.age != null ? safeNumber(activeMain.age) : null,
    activeMainSessionTokens,
    currentUtilizationPercent: currentUtilizationPercent != null ? round(currentUtilizationPercent, 1) : null,
    currentContextTokens: currentContextTokens || null,
    burnRateTokensPerHour: burnRateTokensPerHour != null ? round(burnRateTokensPerHour, 0) : null,
    burnRateWindowMinutes,
    projectedMinutesToFullContext,
    projectedEtaIso,
    forecastStatus,
    forecastNote,
    recentSessionSample: burnSessions.length,
  };
}

// ── SSE ──────────────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

function pushEvent(agentId, type, message) {
  const event = { id: crypto.randomUUID(), agentId, type, message, ts: Date.now() };
  activityFeed.push(event);
  if (activityFeed.length > MAX_FEED) activityFeed.shift();
  broadcast('activity', event);
  return event;
}

// ── Data fetchers ────────────────────────────────────────────────────────────

function fetchOpenClawStatus() {
  return new Promise((resolve) => {
    exec('openclaw gateway call status --json', { timeout: 15000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
        resolve(JSON.parse(clean));
      } catch (e) { resolve(null); }
    });
  });
}

function normalizeCronStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'idle';
  if (s.includes('ok') || s.includes('success')) return 'ok';
  if (s.includes('error') || s.includes('fail') || s.includes('timeout')) return 'error';
  if (s.includes('run')) return 'running';
  return s;
}

function fetchCronList() {
  return new Promise((resolve) => {
    exec('openclaw cron list --json', { timeout: 10000 }, (error, stdout) => {
      if (!error && stdout.trim()) {
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.jobs && Array.isArray(parsed.jobs)) {
            return resolve(parsed.jobs);
          }
          if (Array.isArray(parsed)) return resolve(parsed);
          return resolve([parsed]);
        } catch (_) {}
      }
      exec('openclaw cron list', { timeout: 10000 }, (err2, out2) => {
        if (err2) return resolve([]);
        const clean = (out2 || '').replace(/\x1b\[[0-9;]*m/g, '');
        const lines = clean.trim().split('\n').filter(l => l.trim() && !l.startsWith('ID'));
        resolve(lines.map(l => {
          const parts = l.trim().split(/\s{2,}/);
          return {
            id: parts[0] || '',
            name: parts[1] || '',
            schedule: parts[2] || '',
            next: parts[3] || '',
            last: parts[4] || '',
            status: parts[5] || '',
          };
        }));
      });
    });
  });
}

async function fetchTTSHealth() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch('http://127.0.0.1:5050/health', { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    return data;
  } catch (_) {
    return { status: 'offline' };
  }
}

// ── Update state from real data ──────────────────────────────────────────────

function updateFromOpenClaw(data) {
  if (!data) return;

  const byAgent = data?.sessions?.byAgent || [];
  const allRecent = data?.sessions?.recent || [];

  for (const agent of Object.values(agents)) {
    agent.status = 'OFFLINE';
    agent.task = null;
    agent.percentUsed = 0;
    agent.totalTokens = 0;
    agent.inputTokens = 0;
    agent.outputTokens = 0;
    agent.sessionCount = 0;
  }

  for (const agentGroup of byAgent) {
    const agentId = agentGroup.agentId;
    const agent = agents[agentId] || agents[
      agentId === 'main' ? 'sai' : agentId
    ];
    if (!agent) continue;

    const sessions = agentGroup.recent || [];
    agent.sessionCount = agentGroup.count || sessions.length;

    if (sessions.length === 0) continue;

    const primarySession = sessions.find(s =>
      s.key && !s.key.includes(':cron:') && !s.key.includes(':run:')
    ) || sessions[0];

    const age = primarySession.age != null ? primarySession.age : Infinity;
    const isMainSession = (primarySession.key || '').includes(':main');
    if (age < (isMainSession ? 300000 : 120000)) {
      agent.status = 'ACTIVE';
    } else if (age < 900000) {
      agent.status = 'IDLE';
    } else {
      agent.status = 'OFFLINE';
    }

    const activeSubagents = allRecent.filter(s =>
      s.key && s.key.includes(':subagent:') && (s.age == null || s.age < 300000)
    );
    for (const sub of activeSubagents) {
      const subAgentId = parseAgentFromSessionKey(sub.key);
      const mappedAgent = subAgentId ? agents[subAgentId] : null;
      if (mappedAgent) {
        mappedAgent.status = 'ACTIVE';
        mappedAgent.model = sub.model || mappedAgent.model;
        mappedAgent.percentUsed = safeNumber(sub.percentUsed);
        mappedAgent.totalTokens = safeNumber(sub.totalTokens);
        mappedAgent.contextTokens = safeNumber(sub.contextTokens) || mappedAgent.contextTokens;
        mappedAgent.inputTokens = safeNumber(sub.inputTokens);
        mappedAgent.outputTokens = safeNumber(sub.outputTokens);
        mappedAgent.lastSeen = sub.updatedAt || Date.now();
        mappedAgent.task = humanizeSubagentTask(sub);
      }
    }

    if (primarySession.model) {
      agent.model = primarySession.model;
    }

    if (primarySession.percentUsed != null) {
      agent.percentUsed = primarySession.percentUsed;
    }
    if (primarySession.totalTokens != null) {
      agent.totalTokens = primarySession.totalTokens;
    }
    if (primarySession.contextTokens != null) {
      agent.contextTokens = primarySession.contextTokens;
    }
    if (primarySession.inputTokens != null) {
      agent.inputTokens = primarySession.inputTokens;
    }
    if (primarySession.outputTokens != null) {
      agent.outputTokens = primarySession.outputTokens;
    }

    if (primarySession.updatedAt) {
      agent.lastSeen = primarySession.updatedAt;
    }

    if (agent.status === 'ACTIVE' || agent.status === 'IDLE') {
      const key = primarySession.key || '';
      if (key.includes('subagent')) {
        agent.task = 'Running sub-agent task';
      } else if (key.includes('telegram')) {
        agent.task = 'Telegram session active';
      } else if (key.includes(':main')) {
        agent.task = 'Main session active';
      } else {
        agent.task = 'Processing...';
      }
    }
  }

  for (const session of allRecent) {
    if (!session.key) continue;
    const age = session.age || Infinity;
    if (!(session.key.includes(':subagent:') && age < 300000)) continue;

    const subAgentId = parseAgentFromSessionKey(session.key);
    const mappedAgent = subAgentId ? agents[subAgentId] : null;
    if (!mappedAgent) continue;

    if (mappedAgent.status !== 'ACTIVE') {
      mappedAgent.status = 'ACTIVE';
      mappedAgent.model = session.model || mappedAgent.model;
      mappedAgent.task = humanizeSubagentTask(session);
      mappedAgent.lastSeen = session.updatedAt;
      if (session.percentUsed != null) mappedAgent.percentUsed = session.percentUsed;
      if (session.totalTokens != null) mappedAgent.totalTokens = session.totalTokens;
      if (session.contextTokens != null) mappedAgent.contextTokens = session.contextTokens;
      if (session.inputTokens != null) mappedAgent.inputTokens = session.inputTokens;
      if (session.outputTokens != null) mappedAgent.outputTokens = session.outputTokens;
    }
  }

  metrics.totalSessions = data?.sessions?.count || 0;
  metrics.activeSessions = allRecent.filter(s => (s.age || Infinity) < 300000).length;
  metrics.activeAgents = Object.values(agents).filter(a => a.status === 'ACTIVE' || a.status === 'IDLE').length;
  metrics.totalTokensUsed = allRecent.reduce((sum, s) => sum + (s.totalTokens || 0), 0);
  metrics.usage = computeUsageInsights(allRecent);
}

async function updateSystem(statusData) {
  const tts = await fetchTTSHealth();
  system.ttsStatus = tts.status || 'offline';
  system.ttsModel = tts.model || system.ttsVoice;

  const crons = await fetchCronList();
  system.cronJobs = crons.map(job => ({
    ...job,
    schedule: job.schedule?.expr || job.schedule?.kind || job.schedule || '',
    next: job.state?.nextRunAtMs ? new Date(job.state.nextRunAtMs).toLocaleString() : (job.next || ''),
    status: normalizeCronStatus(job.state?.lastStatus || job.state?.lastRunStatus || job.status),
  }));
  system.cronCount = system.cronJobs.length;

  const heartbeat = statusData?.heartbeat?.agents || [];
  const mainHeartbeat = heartbeat.find(h => h.agentId === 'main' || h.agentId === statusData?.heartbeat?.defaultAgentId);
  if (mainHeartbeat) {
    system.heartbeatInterval = mainHeartbeat.enabled ? (mainHeartbeat.every || `${mainHeartbeat.everyMs}ms`) : 'disabled';
  }
}

// ── Poll loop ────────────────────────────────────────────────────────────────

let lastFeedState = '';

async function pollAll() {
  try {
    const data = await fetchOpenClawStatus();
    if (data) {
      updateFromOpenClaw(data);
      await updateSystem(data);

      const stateKey = Object.values(agents).map(a => `${a.id}:${a.status}`).join('|');
      if (lastFeedState && stateKey !== lastFeedState) {
        for (const agent of Object.values(agents)) {
          const prev = lastFeedState.split('|').find(s => s.startsWith(agent.id + ':'));
          const prevStatus = prev ? prev.split(':')[1] : 'OFFLINE';
          if (prevStatus !== agent.status) {
            const type = agent.status === 'ACTIVE' ? 'success' : agent.status === 'IDLE' ? 'info' : 'warning';
            pushEvent(agent.id, type, `Status changed: ${prevStatus} → ${agent.status}`);
          }
        }
      }
      lastFeedState = stateKey;
    }

    broadcast('agents', Object.values(agents));
    broadcast('metrics', {
      ...metrics,
      uptimeMs: Date.now() - metrics.uptime,
    });
    broadcast('system', system);
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

async function pollSystem() {
  const data = await fetchOpenClawStatus();
  await updateSystem(data);
  broadcast('system', system);
}

setInterval(pollAll, 8000);
setInterval(pollSystem, 30000);

setTimeout(async () => {
  await pollAll();
  await pollSystem();
  pushEvent('sai', 'info', 'Dashboard connected — polling live data');
}, 1000);

setInterval(() => {
  broadcast('metrics', {
    ...metrics,
    uptimeMs: Date.now() - metrics.uptime,
  });
}, 2000);

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  res.json({
    agents: Object.values(agents),
    feed: activityFeed.slice(-50),
    metrics: { ...metrics, uptimeMs: Date.now() - metrics.uptime },
    system,
  });
});

app.get('/api/system', async (req, res) => {
  await updateSystem();
  res.json(system);
});

app.get('/api/raw-status', async (req, res) => {
  const data = await fetchOpenClawStatus();
  if (data) res.json(data);
  else res.status(503).json({ error: 'Could not fetch openclaw status' });
});

// ── SSE endpoint ─────────────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`event: agents\ndata: ${JSON.stringify(Object.values(agents))}\n\n`);
  res.write(`event: metrics\ndata: ${JSON.stringify({ ...metrics, uptimeMs: Date.now() - metrics.uptime })}\n\n`);
  res.write(`event: feed\ndata: ${JSON.stringify(activityFeed.slice(-50))}\n\n`);
  res.write(`event: system\ndata: ${JSON.stringify(system)}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`⚡ Sai Ops Dashboard — http://localhost:${PORT}`);
  console.log(`  Gateway: localhost:${GATEWAY_PORT}`);
  console.log(`  Version: ${openclawVersion}`);
});
