const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');

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
};

const metrics = {
  totalSessions: 0,
  activeSessions: 0,
  activeAgents: 0,
  totalTokensUsed: 0,
  uptime: Date.now(),
};

const MAX_FEED = 200;
const activityFeed = [];

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
        // Strip ANSI codes
        const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
        resolve(JSON.parse(clean));
      } catch (e) { resolve(null); }
    });
  });
}

function fetchCronList() {
  return new Promise((resolve) => {
    exec('openclaw cron list --json', { timeout: 10000 }, (error, stdout) => {
      if (!error && stdout.trim()) {
        try {
          const parsed = JSON.parse(stdout.trim());
          // Handle { jobs: [...], total: N } format
          if (parsed.jobs && Array.isArray(parsed.jobs)) {
            return resolve(parsed.jobs);
          }
          if (Array.isArray(parsed)) return resolve(parsed);
          return resolve([parsed]);
        } catch (_) {}
      }
      // Fallback: parse text output
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

  // Reset all agents to offline first
  for (const agent of Object.values(agents)) {
    agent.status = 'OFFLINE';
    agent.task = null;
    agent.percentUsed = 0;
    agent.totalTokens = 0;
    agent.sessionCount = 0;
  }

  // Map agent data from sessions
  for (const agentGroup of byAgent) {
    const agentId = agentGroup.agentId;
    const agent = agents[agentId] || agents[
      agentId === 'main' ? 'sai' : agentId
    ];
    if (!agent) continue;

    const sessions = agentGroup.recent || [];
    agent.sessionCount = agentGroup.count || sessions.length;

    if (sessions.length === 0) continue;

    // Find the most relevant session (non-cron, most recent)
    const primarySession = sessions.find(s =>
      s.key && !s.key.includes(':cron:') && !s.key.includes(':run:')
    ) || sessions[0];

    // Status based on age
    const age = primarySession.age != null ? primarySession.age : Infinity;
    if (age < 120000) { // 2 minutes
      agent.status = 'ACTIVE';
    } else if (age < 600000) { // 10 minutes
      agent.status = 'IDLE';
    } else {
      agent.status = 'OFFLINE';
    }

    // Check if any subagent session matches this agent
    const subagentSession = allRecent.find(s =>
      s.key && s.key.includes('subagent') && s.age < 120000
    );

    // Model
    if (primarySession.model) {
      agent.model = primarySession.model;
    }

    // Token usage
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

    // Last seen
    if (primarySession.updatedAt) {
      agent.lastSeen = primarySession.updatedAt;
    }

    // Task from session key
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

  // Check for active subagents that map to cody/rory/jamal
  for (const session of allRecent) {
    if (!session.key) continue;
    const age = session.age || Infinity;

    // Subagent sessions are under main but may represent cody/rory/jamal
    if (session.key.includes('subagent') && age < 300000) {
      // This is a subagent — mark as Cody (most likely) or check label
      // For now, if there's an active subagent, at least one sub-agent is busy
      const subModel = session.model || '';
      if (subModel.includes('opus')) {
        // Could be Cody on opus or Jamal
        if (agents.cody.status === 'OFFLINE') {
          agents.cody.status = 'ACTIVE';
          agents.cody.model = subModel;
          agents.cody.task = 'Active sub-agent session';
          agents.cody.lastSeen = session.updatedAt;
          if (session.percentUsed != null) agents.cody.percentUsed = session.percentUsed;
          if (session.totalTokens != null) agents.cody.totalTokens = session.totalTokens;
        }
      }
    }
  }

  // Update metrics
  metrics.totalSessions = data?.sessions?.count || 0;
  metrics.activeSessions = allRecent.filter(s => (s.age || Infinity) < 300000).length;
  metrics.activeAgents = Object.values(agents).filter(a => a.status === 'ACTIVE').length;
  metrics.totalTokensUsed = allRecent.reduce((sum, s) => sum + (s.totalTokens || 0), 0);
}

async function updateSystem() {
  // TTS
  const tts = await fetchTTSHealth();
  system.ttsStatus = tts.status || 'offline';
  system.ttsModel = tts.model || system.ttsVoice;

  // Cron
  const crons = await fetchCronList();
  system.cronJobs = crons;
  system.cronCount = crons.length;
}

// ── Poll loop ────────────────────────────────────────────────────────────────

let lastFeedState = '';

async function pollAll() {
  try {
    const data = await fetchOpenClawStatus();
    if (data) {
      updateFromOpenClaw(data);

      // Generate activity events for state changes
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
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

async function pollSystem() {
  await updateSystem();
  broadcast('system', system);
}

// Poll agents every 8 seconds, system every 30 seconds
setInterval(pollAll, 8000);
setInterval(pollSystem, 30000);

// Initial polls
setTimeout(async () => {
  await pollAll();
  await pollSystem();
  // Push initial startup event
  pushEvent('sai', 'info', 'Dashboard connected — polling live data');
}, 1000);

// Uptime ticker every second
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
