# NSE equity calendar verification — 30 October 2026

The shared calendar now includes 2025 for historical lookbacks and corrected 2026
equity holidays. It is used by scanners, candle completion/freshness, outcome
evaluation, market status and keepalive. Bank/settlement holidays are not trading
holidays. Known live weekend sessions and the 2025 Muhurat session are explicit
overrides; mock sessions are excluded.

Sources read directly from NSE Capital Market circulars:

- [2025 holidays — CMTR65587](https://nsearchives.nseindia.com/content/circulars/CMTR65587.pdf)
- [2025 Budget session — CMTR65729](https://nsearchives.nseindia.com/content/circulars/CMTR65729.pdf)
- [2025 Muhurat timings — CMTR70319](https://nsearchives.nseindia.com/content/circulars/CMTR70319.pdf)
- [2026 holidays — CMTR71775](https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf)
- [January 15 election closure — CMTR72260](https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf)
- [2026 Budget session — CMTR72349](https://nsearchives.nseindia.com/content/circulars/CMTR72349.pdf)

The inherited calendar had incorrect Holi / Bakri Id dates and omitted January 15,
Ram Navami, Mahavir Jayanti, Muharram and the correct Diwali-Balipratipada closure.
These could make legitimate daily histories appear to contain missing sessions.
Genuine candle gaps still fail closed; diagnostics now include only the prior,
expected and actual session dates to identify any remaining mismatch.

The November 8, 2026 Muhurat date is announced, but its precise session timing
circular has not been verified here. The 2026 verification horizon is therefore
November 7; later dates warn as stale until the explicit session override and
horizon are updated from an official timing circular. Annual verification is not
a guarantee against subsequent ad hoc exchange changes. Unknown years continue
to warn and use the existing weekday fallback.

The 2025 Muhurat completion override uses 15 minutes after the normal session
close; that delay is application policy. Keepalive still excludes every weekend
and configured holiday, even when there is a special trading session, as requested.

## Status corrections — 2 November 2026

Market status now marks `holidayDataVerified:false` after the configured verification horizon, exposes the horizon, official source, pending special dates and reason in `holidayCalendar`, and uses the next session's opening time for `nextOpen`. Warning deduplication distinguishes an unverified source, a missing year and an expired horizon. Existing holiday and scheduler behavior is retained; no special-session timings are inferred.

Official NSE web access was blocked by the execution environment's enforced outbound policy during this update. The existing circular references above have not been newly fetched or extended. In particular, November 8 Muhurat hours remain pending. To complete annual verification, obtain the official Capital Market timing circular, add its session open/close and application completion delay to `src/config/nseCalendar.js`, cite its source, clear that pending date and extend `verifiedThrough` only as supported by the circulars. Do not silence warnings by merely changing `verified:true` or the horizon.
