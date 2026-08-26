const express = require('express');
const router = express.Router();
const { state } = require('../state/dailyState');
const scanLoop = require('../jobs/scanLoop');
const { requireKey } = require('../middleware/auth');

router.get('/health', (req, res) => {
  res.json({ ok: true, running: scanLoop.isRunning() });
});

router.get('/stocks', (req, res) => {
  res.json({ count: Object.keys(state.current).length, stocks: state.current });
});

router.get('/positions', (req, res) => {
  const open = Object.fromEntries(Object.entries(state.openPositions).filter(([, p]) => !p.closed));
  res.json({ open });
});

router.get('/summary', (req, res) => {
  res.json({
    tracked: state.lastTrackedCount,
    newAlerts: state.newAlertCount,
    removedAlerts: state.removedAlertCount,
    confluenceAlerts: state.confluenceAlertCount,
    realizedPnl: state.totalRealizedPnl,
    positionsOpened: state.positionsOpenedCount,
    stopHits: state.stopHitCount,
    targetHits: state.targetHitCount,
    trailExits: state.trailExitCount,
    squareOffs: state.squareOffCount,
    topSectors: Object.entries(state.lastSectorCounter)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5),
  });
});

const SIGNAL_SETS = {
  pullback: 'pullbackAlerted',
  orb: 'orbAlerted',
  momentum: 'momentumAlerted',
  volume: 'volumeAlerted',
  vwap: 'vwapAlerted',
  runner: 'noPullbackAlerted',
  afternoon: 'afternoonBreakoutAlerted',
  strong: 'confluenceAlertedStocks',
};

router.get('/signals/:type', (req, res) => {
  const key = SIGNAL_SETS[req.params.type];
  if (!key) {
    return res.status(404).json({ error: `Unknown signal type. Use one of: ${Object.keys(SIGNAL_SETS).join(', ')}` });
  }
  res.json({ type: req.params.type, stocks: [...state[key]] });
});

router.post('/admin/start', requireKey, async (req, res) => {
  await scanLoop.start();
  res.json({ started: true });
});

router.post('/admin/stop', requireKey, (req, res) => {
  scanLoop.stop();
  res.json({ stopped: true });
});

module.exports = router;
