/**
 * Verifies the pinned Node.js runtime version in .node-version.
 *
 * The project pins the Node runtime to a specific security release
 * (Node.js Brotli RCE / CVE-2026-111497). This test guards that the
 * pin is kept at the fixed version so the app runs on a patched Node.
 *
 * Run: node test-node-version.js
 */

const fs = require('fs');
const path = require('path');

const PIN_FILE = path.join(__dirname, '.node-version');
const EXPECTED = '24.22.1';

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    fail += 1;
  }
}

if (!fs.existsSync(PIN_FILE)) {
  console.log('  ✗ .node-version is missing');
  fail += 1;
} else {
  const raw = fs.readFileSync(PIN_FILE, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  const pinned = raw.trim();
  console.log(`\n=== NODE VERSION PIN ===`);
  check('pin file exists', fs.existsSync(PIN_FILE));
  check('pin is a single line', lines.length === 1, `non-empty lines=${lines.length}`);
  check(`pin equals ${EXPECTED}`, pinned === EXPECTED, `got "${pinned}"`);
}

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail > 0 ? 1 : 0);
