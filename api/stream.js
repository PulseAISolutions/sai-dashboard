module.exports = async (_req, res) => {
  res.status(410).json({
    error: 'SSE is not exposed from this deployment.',
    message: 'Use /api/state polling. Live data appears only when a real upstream OpenClaw API is configured.',
  });
};
