const { getDashboardMeta, getPublishedTunnelBaseUrl } = require('./_lib/upstream');

module.exports = async (_req, res) => {
  const configuredBase = process.env.OPENCLAW_API_BASE || process.env.SAI_DASHBOARD_API_BASE || getPublishedTunnelBaseUrl();
  res.status(200).json({
    deployment: getDashboardMeta(),
    configured: Boolean(configuredBase),
    upstreamBaseUrl: configuredBase || null,
  });
};
