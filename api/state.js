const { getState } = require('./_lib/upstream');

module.exports = async (req, res) => {
  const state = await getState(req);
  const code = state.dashboard?.status === 'live' ? 200 : 503;
  res.status(code).json(state);
};
