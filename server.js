const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');
const readline = require('readline');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ───────────────────────────────────────────────────────────────────

const OPENCLAW_HOME = path.join(process.env.USERPROFILE || process.env.HOME, '.openclaw');
const OPENCLAW_JSON = path.join(OPENCLAW_HOME, 'openclaw.json');
const SKILLS_DIR = path.join(OPENCLAW_HOME, 'workspace', 'skills');
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
  skills: {
    total: 0,
    newCount: 0,
    updatedAt: null,
    recent: [],
  },
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

const MAX_FEED = 120;
const activityFeed = [];

const STATUS_POLL_INTERVAL_MS = 1000;
const SYSTEM_POLL_INTERVAL_MS = 30000;
const METRICS_BROADCAST_INTERVAL_MS = 1000;

let statusFetchInFlight = null;
let systemFetchInFlight = null;
let latestStatusData = null;
let operatorStatus = {
  now: null,
  done: [],
  next: null,
  refreshedAt: null,
};

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

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function fetchLocalSessionSnapshot() {
  const agentsRoot = path.join(OPENCLAW_HOME, 'agents');
  const agentDirs = [
    { dir: 'main', agentId: 'sai' },
    { dir: 'cody', agentId: 'cody' },
    { dir: 'rory', agentId: 'rory' },
    { dir: 'jamal', agentId: 'jamal' },
  ];

  const byAgent = [];
  const recent = [];

  for (const entry of agentDirs) {
    const sessionsPath = path.join(agentsRoot, entry.dir, 'sessions', 'sessions.json');
    const sessions = readJsonIfExists(sessionsPath) || {};
    const mapped = Object.entries(sessions).map(([key, session]) => ({
      ...session,
      key,
      age: session.updatedAt != null ? Math.max(Date.now() - safeNumber(session.updatedAt), 0) : null,
    }));

    mapped.sort((a, b) => safeNumber(a.updatedAt) < safeNumber(b.updatedAt) ? 1 : -1);
    byAgent.push({ agentId: entry.agentId, count: mapped.length, recent: mapped.slice(0, 20) });
    recent.push(...mapped.slice(0, 40));
  }

  recent.sort((a, b) => safeNumber(a.updatedAt) < safeNumber(b.updatedAt) ? 1 : -1);
  return { sessions: { byAgent, recent, count: recent.length } };
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
  if (statusFetchInFlight) return statusFetchInFlight;

  statusFetchInFlight = new Promise((resolve) => {
    exec('openclaw gateway call status --json', { timeout: 15000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '').trim();
        resolve(JSON.parse(clean));
      } catch (e) {
        resolve(null);
      }
    });
  }).finally(() => {
    statusFetchInFlight = null;
  });

  return statusFetchInFlight;
}

function normalizeCronStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return 'scheduled';
  if (s.includes('ok') || s.includes('success')) return 'ok';
  if (s.includes('error') || s.includes('fail') || s.includes('timeout')) return 'error';
  if (s.includes('run')) return 'running';
  return s;
}

function formatDuration(ms) {
  const totalMs = safeNumber(ms);
  if (!totalMs) return '';

  const totalSeconds = Math.round(totalMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatCronSchedule(schedule) {
  if (!schedule) return '';
  if (typeof schedule === 'string') return schedule;

  if (schedule.kind === 'cron') {
    return schedule.tz ? `${schedule.expr} · ${schedule.tz}` : (schedule.expr || 'cron');
  }

  if (schedule.kind === 'every') {
    const every = formatDuration(schedule.everyMs);
    const anchor = schedule.anchorMs ? ` from ${new Date(schedule.anchorMs).toLocaleString()}` : '';
    return every ? `Every ${every}${anchor}` : 'Every interval';
  }

  if (schedule.kind === 'at') {
    return schedule.at ? `At ${new Date(schedule.at).toLocaleString()}` : 'One-time';
  }

  return schedule.kind || 'scheduled';
}

function formatCronNextRun(job) {
  if (job.state?.runningAtMs) return 'Running now';
  if (job.state?.nextRunAtMs) return new Date(job.state.nextRunAtMs).toLocaleString();
  return job.next || '';
}

function deriveCronStatus(job) {
  if (!job?.enabled) return 'disabled';
  if (job?.state?.runningAtMs) return 'running';

  const payloadKind = job?.payload?.kind || '';
  const sessionTarget = job?.sessionTarget || '';
  const rawStatus = normalizeCronStatus(job?.state?.lastStatus || job?.state?.lastRunStatus || job?.status);

  if (payloadKind === 'systemEvent' && sessionTarget === 'main') {
    return rawStatus === 'running' ? 'running' : 'scheduled';
  }

  return rawStatus;
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


function summarizeText(value, max = 160) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, Math.max(max - 1, 1)).trimEnd()}…` : clean;
}

function flattenTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    return '';
  }).join(' ').trim();
}

async function readRecentJsonLines(filePath, maxLines = 160) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  const lines = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line || !line.trim()) continue;
      lines.push(line);
      if (lines.length > maxLines) lines.shift();
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (_) {}
  }
  return parsed;
}

const LOW_SIGNAL_MESSAGES = new Set([
  'hi', 'hello', 'hey', 'yo', 'sup', 'ok', 'okay', 'kk', 'k', 'yes', 'yep', 'yeah', 'sure', 'thanks', 'thank you', 'ty', 'cool', 'nice', 'got it', 'sounds good', 'done'
]);

function cleanOperatorText(value) {
  return String(value || '')
    .replace(/<<<[\s\S]+?>>>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b[A-Z]:\\[^\s]+/g, ' ')
    .replace(/\bsource:\s*subagent\b/gi, ' ')
    .replace(/\bsession_(?:key|id):\s*\S+/gi, ' ')
    .replace(/\bstatus:\s*completed successfully\b/gi, ' ')
    .replace(/\bStats:[\s\S]*$/i, ' ')
    .replace(/\bAction:[\s\S]*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLowSignalText(text) {
  const clean = cleanOperatorText(text).toLowerCase().replace(/[.!?,]+$/g, '').trim();
  if (!clean) return true;
  if (LOW_SIGNAL_MESSAGES.has(clean)) return true;
  if (clean.length <= 3 && /^[a-z]+$/.test(clean)) return true;
  return false;
}

function normalizeTaskText(text) {
  const clean = cleanOperatorText(text)
    .replace(/^You are [^.]+\.?/i, '')
    .replace(/^TASK:\s*/i, '')
    .replace(/^DELIVERABLE:\s*/i, '')
    .replace(/^Context:\s*/i, '')
    .trim();
  return summarizeText(clean, 150);
}

function extractTaskSummary(text) {
  const raw = String(text || '');
  const patterns = [
    /(?:^|\n)TASK:\s*([\s\S]+?)(?:\n\n|\n[A-Z][A-Z _-]+:|$)/i,
    /(?:^|\n)Subagent Task:\s*([\s\S]+?)(?:\n\n|$)/i,
    /(?:^|\n)task:\s*([\s\S]+?)(?:\nstatus:|$)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const firstMeaningfulLine = match[1]
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line && !/^[-*\d.)\s]+$/.test(line) && !/^(context|constraints|deliverable|goal|required outcome):/i.test(line));
      if (firstMeaningfulLine) return normalizeTaskText(firstMeaningfulLine);
    }
  }
  return normalizeTaskText(raw);
}

function extractUsefulResultSummary(text) {
  const raw = String(text || '')
    .replace(/<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>/g, '')
    .replace(/<<<END_UNTRUSTED_CHILD_RESULT>>>/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b[A-Z]:\\[^\s]+/g, ' ')
    .replace(/^Done\.\s*/i, '')
    .replace(/^Accomplished:\s*/i, '')
    .trim();

  const lines = raw
    .split(/\r?\n/)
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)
    .filter(line => !/^what i found:?$/i.test(line))
    .filter(line => !/^relevant details:?$/i.test(line))
    .filter(line => !/^exact paths changed:?$/i.test(line))
    .filter(line => !/^verified(?: scaffold output)?:?$/i.test(line))
    .filter(line => !/^deliverable:?$/i.test(line))
    .filter(line => !/^one note:?$/i.test(line))
    .filter(line => !/^top \d+:?$/i.test(line))
    .filter(line => !/^live url:?$/i.test(line))
    .filter(line => !/^[A-Z]:\\/i.test(line))
    .filter(line => !/^you are /i.test(line));

  const best = lines.find(line => line.length > 24 && !/^(run|then|fast next step|return):/i.test(line)) || lines[0] || cleanOperatorText(raw);
  return summarizeText(cleanOperatorText(best), 160);
}

function parseTaskLabelFromText(text) {
  return extractTaskSummary(text);
}

function extractUserIntentText(content) {
  const text = flattenTextContent(content);
  if (!text) return '';
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !line.startsWith('Conversation info'))
    .filter(line => !line.startsWith('Sender (untrusted metadata)'))
    .filter(line => line !== '```json' && line !== '```')
    .filter(line => !/^\[.*\]$/.test(line))
    .filter(line => !/^This context is runtime-generated/i.test(line))
    .filter(line => !/^OpenClaw runtime context/i.test(line));

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('}') && !line.startsWith('"') && !isLowSignalText(line)) {
      return summarizeText(cleanOperatorText(line), 160);
    }
  }

  const combined = summarizeText(cleanOperatorText(text), 160);
  return isLowSignalText(combined) ? '' : combined;
}

function inferNextStepFromText(text) {
  const clean = cleanOperatorText(text);
  if (!clean) return '';
  const match = clean.match(/(?:next step|fast next step|recommended next step)s?:\s*([\s\S]+)/i);
  if (match?.[1]) return summarizeText(match[1].split(/\r?\n/)[0], 180);
  if (/\bdeploy\b/i.test(clean)) return 'Deploy the finished patch and verify the live dashboard output.';
  if (/\bverify|test|smoke-test\b/i.test(clean)) return 'Verify the latest patch locally and confirm the operator cards read cleanly.';
  return '';
}

async function buildOperatorStatus(snapshot) {
  const mainGroup = snapshot?.sessions?.byAgent?.find(entry => entry.agentId === 'sai');
  const mainSession = mainGroup?.recent?.[0] || null;
  const mainEvents = await readRecentJsonLines(mainSession?.sessionFile, 260);

  const activeSubagents = (snapshot?.sessions?.recent || [])
    .filter(session => String(session.key || '').includes(':subagent:') && safeNumber(session.age) < 300000)
    .sort((a, b) => safeNumber(b.updatedAt) - safeNumber(a.updatedAt));

  const recentMessages = mainEvents
    .filter(event => event?.type === 'message' && event?.message?.role)
    .slice(-120);

  const meaningfulUserMessages = [...recentMessages]
    .reverse()
    .filter(event => event.message.role === 'user')
    .filter(event => !flattenTextContent(event.message.content).includes('[Internal task completion event]'))
    .map(event => ({ event, text: extractUserIntentText(event.message.content) }))
    .filter(item => item.text);

  const latestMeaningfulUser = meaningfulUserMessages[0]?.event || null;
  const latestMeaningfulUserText = meaningfulUserMessages[0]?.text || '';

  const latestAssistantFinal = [...recentMessages].reverse().find(event => {
    if (event.message.role !== 'assistant') return false;
    return Array.isArray(event.message.content) && event.message.content.some(part => part?.textSignature?.phase === 'final_answer');
  });

  const latestAssistantCommentary = [...recentMessages].reverse().find(event => {
    if (event.message.role !== 'assistant') return false;
    return Array.isArray(event.message.content) && event.message.content.some(part => part?.textSignature?.phase === 'commentary');
  });

  const completionEvents = recentMessages
    .filter(event => event.message.role === 'user')
    .filter(event => flattenTextContent(event.message.content).includes('[Internal task completion event]'))
    .slice(-10)
    .reverse();

  const done = [];

  for (const event of completionEvents) {
    const text = flattenTextContent(event.message.content);
    const taskMatch = text.match(/task:\s*([\s\S]+?)status:\s*completed successfully/i);
    const resultMatch = text.match(/<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>[\s\S]+?<<<END_UNTRUSTED_CHILD_RESULT>>>/i);
    const label = extractTaskSummary(taskMatch ? taskMatch[1] : 'Completed subagent task');
    const detail = extractUsefulResultSummary(resultMatch ? resultMatch[0] : text);
    done.push({
      type: 'subagent',
      label: label || 'Completed subagent task',
      detail: detail || 'Completed work captured from recent session history.',
      ts: event.timestamp || Date.now(),
    });
    if (done.length >= 4) break;
  }

  if (latestAssistantFinal) {
    const replyText = extractUsefulResultSummary(flattenTextContent(latestAssistantFinal.message.content));
    if (replyText) {
      done.unshift({
        type: 'reply',
        label: 'Last delivered update',
        detail: replyText,
        ts: latestAssistantFinal.timestamp || Date.now(),
      });
    }
  }

  const activeSubagentSummaries = [];
  for (const session of activeSubagents.slice(0, 3)) {
    const subEvents = await readRecentJsonLines(session.sessionFile, 80);
    const latestTaskEvent = [...subEvents].reverse().find(event => event?.type === 'message' && event?.message?.role === 'user');
    activeSubagentSummaries.push({
      agentId: parseAgentFromSessionKey(session.key),
      model: session.model || null,
      label: parseTaskLabelFromText(flattenTextContent(latestTaskEvent?.message?.content) || humanizeSubagentTask(session) || 'Subagent task active'),
      ts: session.updatedAt || Date.now(),
    });
  }

  const nowLabel = activeSubagentSummaries[0]?.label || latestMeaningfulUserText || 'Monitoring for the next meaningful request';
  const nowDetail = activeSubagentSummaries.length > 0
    ? activeSubagentSummaries.map(item => `${agents[item.agentId]?.name || item.agentId}: ${item.label}`).join(' • ')
    : latestMeaningfulUserText
      ? 'No subagents running. Current focus is based on the latest substantive request.'
      : 'No active task signal found in recent session history.';

  const now = {
    label: summarizeText(nowLabel, 120),
    detail: summarizeText(nowDetail, 220),
    source: activeSubagentSummaries.length > 0
      ? 'Active subagent sessions'
      : latestMeaningfulUser ? 'Recent substantive user request' : 'Recent session history',
    ts: activeSubagentSummaries[0]?.ts || latestMeaningfulUser?.timestamp || Date.now(),
    subagents: activeSubagentSummaries,
  };

  let nextDetail = '';
  let nextSource = '';
  let nextTs = Date.now();

  if (activeSubagentSummaries.length > 0) {
    nextDetail = activeSubagentSummaries.length === 1
      ? `Review ${agents[activeSubagentSummaries[0].agentId]?.name || 'the active subagent'} output when it finishes, then deliver the result or queue the follow-up.`
      : `Wait for the active subagents to finish, then consolidate their outputs into one operator update.`;
    nextSource = 'Inferred from active subagent work';
    nextTs = activeSubagentSummaries[0].ts;
  } else {
    const commentaryText = flattenTextContent(latestAssistantCommentary?.message?.content);
    nextDetail = inferNextStepFromText(commentaryText) || 'No strong follow-up is currently active; the next step is likely to review the latest completed work or wait for a new substantive request.';
    nextSource = commentaryText ? 'Recent assistant commentary' : 'Session inference';
    nextTs = latestAssistantCommentary?.timestamp || Date.now();
  }

  return {
    now,
    done: done
      .filter(item => item?.label && item?.detail)
      .sort((a, b) => safeNumber(b.ts) - safeNumber(a.ts))
      .slice(0, 4),
    next: {
      label: 'Next useful step',
      detail: summarizeText(nextDetail, 220),
      source: nextSource,
      ts: nextTs,
      inferred: true,
    },
    refreshedAt: new Date().toISOString(),
  };
}

function fetchSkillInventory() {
  try {
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => {
        const fullPath = path.join(SKILLS_DIR, entry.name);
        const stats = fs.statSync(fullPath);
        return {
          name: entry.name,
          mtimeMs: stats.mtimeMs || 0,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const cutoff = Date.now() - (72 * 60 * 60 * 1000);
    return {
      total: entries.length,
      newCount: entries.filter(entry => entry.mtimeMs >= cutoff).length,
      updatedAt: Date.now(),
      recent: entries.slice(0, 12).map(entry => entry.name),
    };
  } catch (_) {
    return {
      total: 0,
      newCount: 0,
      updatedAt: Date.now(),
      recent: [],
    };
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
  system.skills = fetchSkillInventory();

  const crons = await fetchCronList();
  system.cronJobs = crons.map(job => {
    const status = deriveCronStatus(job);
    const shouldShowError = status === 'error';
    return {
      ...job,
      schedule: formatCronSchedule(job.schedule),
      next: formatCronNextRun(job),
      status,
      error: shouldShowError ? (job.state?.lastError || '') : '',
    };
  });
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
    const data = fetchLocalSessionSnapshot();
    updateFromOpenClaw(data);
    operatorStatus = await buildOperatorStatus(data);

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

async function pollSystem(force = false) {
  if (systemFetchInFlight) return systemFetchInFlight;

  systemFetchInFlight = (async () => {
    const data = force ? await fetchOpenClawStatus() : (latestStatusData || await fetchOpenClawStatus());
    if (data) latestStatusData = data;
    await updateSystem(data);
    broadcast('system', system);
  })().finally(() => {
    systemFetchInFlight = null;
  });

  return systemFetchInFlight;
}

setInterval(pollAll, STATUS_POLL_INTERVAL_MS);
setInterval(() => pollSystem(), SYSTEM_POLL_INTERVAL_MS);

setTimeout(async () => {
  await pollAll();
  await pollSystem(true);
  pushEvent('sai', 'info', `Dashboard connected — key state refreshes every ${STATUS_POLL_INTERVAL_MS / 1000}s`);
}, 1000);

setInterval(() => {
  broadcast('metrics', {
    ...metrics,
    uptimeMs: Date.now() - metrics.uptime,
  });
}, METRICS_BROADCAST_INTERVAL_MS);

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  res.json({
    agents: Object.values(agents),
    feed: activityFeed.slice(-50),
    metrics: { ...metrics, uptimeMs: Date.now() - metrics.uptime },
    system,
    operatorStatus,
    dashboard: {
      mode: 'local',
      status: 'live',
      message: 'Live state is being served directly from the local dashboard process.',
      upstreamBaseUrl: `http://localhost:${PORT}`,
      refreshedAt: new Date().toISOString(),
      truth: 'This dashboard is connected directly to the machine running OpenClaw, not to a static snapshot.',
    },
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
