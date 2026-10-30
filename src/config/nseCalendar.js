// NSE Capital Market (equities), checked against the listed official circulars.
// Keep historical years: daily lookbacks cross the current-year boundary.
module.exports = {
  2025: {
    verified: true,
    source: 'https://nsearchives.nseindia.com/content/circulars/CMTR65587.pdf',
    sources: ['CMTR65587', 'CMTR65729', 'CMTR70319'],
    checkedAt: '2026-10-30',
    holidays: [
      '2025-01-26', '2025-02-26', '2025-03-14', '2025-03-31',
      '2025-04-06', '2025-04-10', '2025-04-14', '2025-04-18',
      '2025-05-01', '2025-06-07', '2025-07-06', '2025-08-15',
      '2025-08-27', '2025-10-02', '2025-10-21', '2025-10-22',
      '2025-11-05', '2025-12-25',
    ],
    sessions: {
      '2025-02-01': {open:{h:9,m:15},close:{h:15,m:30},complete:{h:15,m:45}},
      '2025-10-21': {open:{h:13,m:45},close:{h:14,m:45},complete:{h:15,m:0}},
    },
  },
  2026: {
    verified: true,
    source: 'https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',
    sources: ['CMTR71775', 'CMTR72260', 'CMTR72349'],
    checkedAt: '2026-10-30',
    // November 8 Muhurat timings still need the specific timing circular.
    // Warn after this horizon rather than claim complete special-session coverage.
    verifiedThrough: '2026-11-07',
    pendingSpecialSessions: ['2026-11-08'],
    holidays: [
      '2026-01-15', '2026-01-26', '2026-02-15', '2026-03-03',
      '2026-03-21', '2026-03-26', '2026-03-31', '2026-04-03',
      '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26',
      '2026-08-15', '2026-09-14', '2026-10-02', '2026-10-20',
      '2026-11-08', '2026-11-10', '2026-11-24', '2026-12-25',
    ],
    sessions: {
      '2026-02-01': {open:{h:9,m:15},close:{h:15,m:30},complete:{h:15,m:45}},
    },
  },
};
