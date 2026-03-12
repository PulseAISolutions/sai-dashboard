const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DASHBOARD_META_PATH = path.join(PUBLIC_DIR, 'dashboard-meta.json');
const TUNNEL_INFO_PATH = path.join(PUBLIC_DIR, 'tunnel-info.json');

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function getDashboardMeta() {
  return readJson(DASHBOARD_META_PATH);
}

function getTunnelInfo() {
  return readJson(TUNNEL_INFO_PATH);
}

function normalizeBaseUrl(value) {
  if (!value) return '';
  return String(value).trim().replace(/\/$/, '');
}

function getPublishedTunnelBaseUrl() {
  const info = getTunnelInfo();
  return normalizeBaseUrl(info?.apiBase);
}

function getUpstreamBaseUrl(req) {
  const fromEnv = normalizeBaseUrl(process.env.OPENCLAW_API_BASE || process.env.SAI_DASHBOARD_API_BASE);
  if (fromEnv) return fromEnv;

  const fromQuery = normalizeBaseUrl(req?.query?.api);
  if (fromQuery) return fromQuery;

  const fromPublishedTunnel = getPublishedTunnelBaseUrl();
  if (fromPublishedTunnel) return fromPublishedTunnel;

  return '';
}

function buildFallbackState(reason, upstreamBaseUrl) {
  const deployment = getDashboardMeta();
  const now = Date.now();

  return {
    agents: [],
    feed: [
      {
        id: `dashboard-${now}`,
        agentId: 'sai',
        type: 'warning',
        message: reason,
        ts: now,
      },
    ],
    metrics: {
      totalSessions: 0,
      activeSessions: 0,
      activeAgents: 0,
      totalTokensUsed: 0,
      uptimeMs: 0,
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        forecastStatus: 'unavailable',
        forecastNote: 'Live OpenClaw state is unavailable from this deployment.',
        recentSessionSample: 0,
      },
    },
    system: {
      ttsStatus: 'unknown',
      ttsModel: null,
      heartbeatInterval: 'unknown',
      heartbeatModel: 'unknown',
      cronJobs: [],
      cronCount: 0,
      gatewayPort: null,
      openclawVersion: 'Unavailable',
      gatewayUptime: null,
      teamContracts: [],
      skills: {
        total: 0,
        newCount: 0,
        updatedAt: null,
        recent: [],
      },
    },
    dashboard: {
      mode: 'unavailable',
      status: 'degraded',
      message: reason,
      upstreamBaseUrl: upstreamBaseUrl || null,
      deployment,
      refreshedAt: new Date(now).toISOString(),
      truth: 'This Vercel deployment is honest about live-state availability. It only shows live data when a real upstream OpenClaw API is configured or published via tunnel-info.json and reachable.',
    },
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'accept': 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstream ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function getState(req) {
  const upstreamBaseUrl = getUpstreamBaseUrl(req);

  if (!upstreamBaseUrl) {
    return buildFallbackState(
      'Live API is not configured for this deployment. The public dashboard is available, but it is not claiming to show real-time state.',
      ''
    );
  }

  try {
    const state = await fetchJson(`${upstreamBaseUrl}/api/state`);
    return {
      ...state,
      dashboard: {
        mode: 'proxy',
        status: 'live',
        message: 'Live state is being proxied through this deployment from a configured OpenClaw API.',
        upstreamBaseUrl,
        deployment: getDashboardMeta(),
        refreshedAt: new Date().toISOString(),
        truth: 'Agent and system data come from the configured upstream OpenClaw API, not from Vercel itself.',
      },
    };
  } catch (error) {
    return buildFallbackState(
      `Configured live API is unreachable right now. ${error.message}`,
      upstreamBaseUrl
    );
  }
}

module.exports = {
  getDashboardMeta,
  getPublishedTunnelBaseUrl,
  getState,
};
