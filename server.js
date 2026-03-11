const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory state ──────────────────────────────────────────────────────────

const agents = {
  sai:   { id: 'sai',   name: 'Sai',   emoji: '⚡', status: 'ACTIVE',  task: 'Orchestrating task pipeline', lastSeen: Date.now() },
  cody:  { id: 'cody',  name: 'Cody',  emoji: '🧑‍💻', status: 'ACTIVE',  task: 'Writing unit tests for auth module', lastSeen: Date.now() },
  rory:  { id: 'rory',  name: 'Rory',  emoji: '🔍', status: 'IDLE',    task: null, lastSeen: Date.now() },
  jamal: { id: 'jamal', name: 'Jamal', emoji: '✅', status: 'WAITING', task: 'Waiting for Cody to finish tests', lastSeen: Date.now() },
};

const metrics = {
  tasksCompleted: 142,
  tasksActive: 3,
  tasksFailed: 2,
  uptime: Date.now(),
  messagesProcessed: 4821,
};

const MAX_FEED = 200;
const activityFeed = [];

// ── SSE client registry ──────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// ── Seed initial feed ────────────────────────────────────────────────────────

const SEED_EVENTS = [
  { agentId: 'sai',   type: 'info',    message: 'Pipeline started — 4 tasks queued' },
  { agentId: 'cody',  type: 'info',    message: 'Cloned repo and checked out feature/auth-refactor' },
  { agentId: 'rory',  type: 'success', message: 'Code review complete — 0 blockers found' },
  { agentId: 'jamal', type: 'info',    message: 'Test plan generated for auth module' },
  { agentId: 'sai',   type: 'info',    message: 'Delegated auth testing to Cody' },
  { agentId: 'cody',  type: 'warning', message: 'Flaky test detected in login flow — retrying' },
  { agentId: 'cody',  type: 'success', message: 'All 47 unit tests passing' },
  { agentId: 'jamal', type: 'info',    message: 'Verification queued, waiting on Cody' },
];

let seedTs = Date.now() - SEED_EVENTS.length * 18000;
for (const e of SEED_EVENTS) {
  activityFeed.push({ ...e, id: crypto.randomUUID(), ts: (seedTs += 18000) });
}

function pushEvent(agentId, type, message) {
  const event = { id: crypto.randomUUID(), agentId, type, message, ts: Date.now() };
  activityFeed.push(event);
  if (activityFeed.length > MAX_FEED) activityFeed.shift();
  if (agents[agentId]) agents[agentId].lastSeen = event.ts;
  broadcast('activity', event);
  return event;
}

// ── Demo simulation ──────────────────────────────────────────────────────────

const SIM_EVENTS = [
  () => { agents.sai.status = 'ACTIVE'; agents.sai.task = 'Reviewing PR #88'; pushEvent('sai', 'info', 'Started PR review for feature/auth-refactor'); },
  () => { agents.cody.status = 'ACTIVE'; agents.cody.task = 'Fixing lint errors'; pushEvent('cody', 'warning', 'ESLint found 3 errors in auth.js — fixing'); },
  () => { pushEvent('cody', 'success', 'Lint errors resolved and committed'); agents.cody.task = 'Idle'; agents.cody.status = 'IDLE'; metrics.tasksCompleted++; },
  () => { agents.rory.status = 'ACTIVE'; agents.rory.task = 'Scanning for security issues'; pushEvent('rory', 'info', 'Running dependency vulnerability scan'); },
  () => { pushEvent('rory', 'info', 'Scanning 142 packages…'); },
  () => { pushEvent('rory', 'success', 'No critical vulnerabilities found'); agents.rory.status = 'IDLE'; agents.rory.task = null; metrics.tasksCompleted++; },
  () => { agents.jamal.status = 'ACTIVE'; agents.jamal.task = 'Running integration tests'; pushEvent('jamal', 'info', 'Starting integration test suite — 12 scenarios'); },
  () => { pushEvent('jamal', 'info', '8/12 scenarios passed…'); },
  () => { pushEvent('jamal', 'warning', 'Scenario #9 timed out — retrying'); },
  () => { pushEvent('jamal', 'success', '12/12 scenarios passed'); agents.jamal.status = 'IDLE'; agents.jamal.task = null; metrics.tasksCompleted++; },
  () => { agents.sai.status = 'ACTIVE'; agents.sai.task = 'Merging approved PR'; pushEvent('sai', 'success', 'PR #88 approved — merging to main'); metrics.tasksCompleted++; },
  () => { pushEvent('sai', 'info', 'Triggering deployment pipeline'); agents.sai.task = 'Monitoring deployment'; },
  () => { pushEvent('sai', 'success', 'Deployment complete — v2.4.1 live'); agents.sai.status = 'IDLE'; agents.sai.task = null; metrics.tasksCompleted++; },
  () => { agents.sai.status = 'ACTIVE'; agents.sai.task = 'Orchestrating task pipeline'; pushEvent('sai', 'info', 'New task batch received — 3 items'); },
  () => { agents.cody.status = 'ACTIVE'; agents.cody.task = 'Writing API documentation'; pushEvent('cody', 'info', 'Generating OpenAPI spec from route handlers'); },
  () => { agents.rory.status = 'ACTIVE'; agents.rory.task = 'Reviewing code quality metrics'; pushEvent('rory', 'info', 'Running code complexity analysis'); },
];

let simIndex = 0;

function runSimStep() {
  if (simIndex < SIM_EVENTS.length) {
    SIM_EVENTS[simIndex++]();
  } else {
    // After all scripted events, keep ticking with heartbeats
    pushEvent('sai', 'info', 'Heartbeat — system nominal');
    metrics.messagesProcessed += Math.floor(Math.random() * 5) + 1;
  }
  metrics.tasksActive = Object.values(agents).filter(a => a.status === 'ACTIVE').length;
  broadcast('agents', Object.values(agents));
  broadcast('metrics', { ...metrics, uptimeMs: Date.now() - metrics.uptime });
}

setInterval(runSimStep, 4000);

// Slower heartbeat for uptime ticker
setInterval(() => {
  broadcast('metrics', { ...metrics, uptimeMs: Date.now() - metrics.uptime });
}, 1000);

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  res.json({
    agents: Object.values(agents),
    feed: activityFeed.slice(-50),
    metrics: { ...metrics, uptimeMs: Date.now() - metrics.uptime },
  });
});

// Manual agent update (for real OpenClaw integration)
app.post('/api/agent/:id', (req, res) => {
  const agent = agents[req.params.id];
  if (!agent) return res.status(404).json({ error: 'Unknown agent' });
  Object.assign(agent, req.body, { lastSeen: Date.now() });
  broadcast('agents', Object.values(agents));
  res.json(agent);
});

// Post an activity event (for real OpenClaw integration)
app.post('/api/event', (req, res) => {
  const { agentId, type, message } = req.body;
  if (!agentId || !message) return res.status(400).json({ error: 'agentId and message required' });
  const event = pushEvent(agentId, type || 'info', message);
  res.json(event);
});

// ── SSE endpoint ─────────────────────────────────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send current state immediately on connect
  res.write(`event: agents\ndata: ${JSON.stringify(Object.values(agents))}\n\n`);
  res.write(`event: metrics\ndata: ${JSON.stringify({ ...metrics, uptimeMs: Date.now() - metrics.uptime })}\n\n`);
  res.write(`event: feed\ndata: ${JSON.stringify(activityFeed.slice(-50))}\n\n`);

  sseClients.add(res);

  req.on('close', () => sseClients.delete(res));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Sai Dashboard running at http://localhost:${PORT}`);
});
