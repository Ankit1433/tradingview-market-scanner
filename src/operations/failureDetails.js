// Only fixed operational labels and numeric status codes may leave an error.
const stages=new Set(['storage','bootstrap_admin','scanner_ownership','provider_setup','outcome_storage','scanner_start','outbox_start','telegram_worker','configuration','instrument_RELIANCE','quote_RELIANCE','daily_RELIANCE','five_minute_RELIANCE','instrument_NIFTY','quote_NIFTY','daily_NIFTY','five_minute_NIFTY','telegram_poll','signal_discovery','scanner_monitor','paper_evaluation','paper_delivery','alert_delivery']);
const codes=new Set(['MARKET_WORKER_ALREADY_OWNED','WORKER_ACQUISITION_CANCELLED','PERSONAL_ALERT_WORKER_REQUIRES_DATABASE','UPSTOX_CORPORATE_ACTION_REVIEW_REQUIRED','UPSTOX_CORPORATE_ACTION_DATA_INVALID','UPSTOX_CORPORATE_ACTION_ISIN_INVALID','UPSTOX_COMPARISON_REQUIRED','UPSTOX_AUTH_REJECTED','UPSTOX_AUTH_REJECTED_ROTATE_TOKEN','UPSTOX_TOKEN_MISSING','UPSTOX_INSTRUMENT_MASTER_UNAVAILABLE','UPSTOX_INSTRUMENT_MISSING_OR_AMBIGUOUS','UPSTOX_STALE_OR_MISSING_QUOTE','UPSTOX_INVALID_CANDLE','UPSTOX_INVALID_CANDLES','UPSTOX_INVALID_RESPONSE','UPSTOX_REQUEST_FAILED','UPSTOX_NO_COMPLETED_CANDLES','UPSTOX_DAILY_CANDLE_GAP','UPSTOX_CANDLE_GAP','UPSTOX_EQUITY_VOLUME_MISSING','UPSTOX_CALENDAR_COVERAGE_MISSING','UPSTOX_STALE_DAILY_CANDLES','UPSTOX_STALE_INTRADAY_CANDLES','UPSTOX_INVALID_FINALIZATION_DELAY','UPSTOX_CONNECTIVITY_CHECK_FAILED']);
const resources=new Set(['app_users','signal_events','alert_queue','personal_trades','personal_reminders','scanner_state','rpc/enqueue_personal_alert','rpc/acquire_worker_lease']);
function details(error,stage){
 const result={stage:stages.has(stage)?stage:'unknown',code:'OPERATION_FAILED'};
 const message=String(error?.message||'');
 if(codes.has(message)||/^UPSTOX_HTTP_[45]\d\d$/.test(message))result.code=message;
 const status=error?.response?.status;
 if(Number.isInteger(status)&&status>=400&&status<=599)result.httpStatus=status;
 if(['ETIMEDOUT','ECONNABORTED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ECONNREFUSED'].includes(error?.code))result.code=error.code;
 const db=/^Supabase ([a-z_/]+) request failed \(HTTP ([45]\d\d)\)$/.exec(message);
 if(db&&resources.has(db[1])){result.code='DATABASE_REQUEST_FAILED';result.resource=db[1];result.httpStatus=Number(db[2]);}
 if(result.code==='UPSTOX_DAILY_CANDLE_GAP')for(const key of ['previousSession','expectedSession','actualSession'])if(typeof error?.[key]==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(error[key]))result[key]=error[key];
 return result;
}
module.exports={details};
