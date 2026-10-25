/**
 * Verifies the pinned body-parser dependency version.
 *
 * body-parser is a transitive dependency (via express). GHSA-27r3-jxmh-p828
 * affects body-parser < 2.1.0; the CVE fix requires moving to the 2.x line.
 * This test guards that the resolved body-parser is the fixed 2.4.0 version
 * so the app does not run the vulnerable parser.
 *
 * Run: node test-body-parser.js
 */

const fs = require('fs');
const path = require('path');

const LOCKFILE = path.join(__dirname, 'package-lock.json');
const EXPECTED = '2.4.0';

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

console.log(`\n=== BODY-PARSER VERSION ===`);

if (!fs.existsSync(LOCKFILE)) {
  console.log('  ✗ package-lock.json is missing');
  fail += 1;
} else {
  let lockfile;
  try {
    lockfile = JSON.parse(fs.readFileSync(LOCKFILE, 'utf8'));
  } catch (e) {
    console.log(`  ✗ package-lock.json is not valid JSON: ${e.message}`);
    fail += 1;
  }

  if (lockfile) {
    const pkg = lockfile.packages && lockfile.packages['node_modules/body-parser'];
    check('body-parser entry exists in lockfile', !!pkg, 'not found in packages');
    if (pkg) {
      check(`resolved version is ${EXPECTED}`, pkg.version === EXPECTED, `got "${pkg.version}"`);
      const major = Number(String(pkg.version).split('.')[0]);
      check('major version is >= 2 (CVE fix line)', major >= 2, `got ${pkg.version}`);
    }
  }
}

console.log(`\n${'='.repeat(50)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail > 0 ? 1 : 0);
