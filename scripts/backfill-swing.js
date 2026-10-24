require('dotenv').config();

const journal = require('../src/state/signalJournal');
const supabaseStore = require('../src/services/supabaseStore');
const { closeClient } = require('../src/services/tvHistory');
const { runSwingBackfill } = require('../src/jobs/swingBackfill');

async function main() {
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((arg) => !/^--sessions=\d+$/.test(arg));
  if (unknownArgs.length) {
    throw new Error(`Unsupported argument(s): ${unknownArgs.join(', ')}`);
  }

  const sessionsArg = args.find((arg) => arg.startsWith('--sessions='));
  const sessions = sessionsArg ? Number(sessionsArg.split('=')[1]) : 2;
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > 5) {
    throw new Error('--sessions must be an integer between 1 and 5');
  }

  if (!await supabaseStore.connect()) {
    throw new Error('Supabase is unavailable; refusing to run a local-only backfill');
  }
  journal.load();
  await journal.hydrateFromSupabase();

  const result = await runSwingBackfill({ sessions });
  await supabaseStore.flush();
  const status = supabaseStore.status();
  if (!status.healthy) {
    throw new Error(`Supabase write failed${status.lastError ? `: ${status.lastError}` : ''}`);
  }

  console.log(
    `[swing backfill] scanned ${result.scanned} symbols; ` +
    `${result.recorded} new setup(s) recorded for ${result.dates.join(', ') || 'no completed sessions'}; ` +
    `${result.skippedExisting} duplicate(s) skipped`,
  );
}

main()
  .catch((error) => {
    console.error(`[swing backfill] failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => closeClient());
