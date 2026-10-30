// Operational screening may quarantine an unusable symbol; direct history reads
// still reject it. Never convert an auth/network outage into an empty market.
const reasons=new Set(['UPSTOX_DAILY_CANDLE_GAP','UPSTOX_CANDLE_GAP','UPSTOX_NO_COMPLETED_CANDLES','UPSTOX_EQUITY_VOLUME_MISSING','UPSTOX_STALE_DAILY_CANDLES','UPSTOX_STALE_INTRADAY_CANDLES','UPSTOX_CORPORATE_ACTION_DATA_INVALID','UPSTOX_CORPORATE_ACTION_ISIN_INVALID']);
function exclusion(error){if(!reasons.has(error?.message))return null;const result={reason:error.message};for(const key of ['previousSession','expectedSession','actualSession'])if(typeof error[key]==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(error[key]))result[key]=error[key];return result;}
module.exports={exclusion};
