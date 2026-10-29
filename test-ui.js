process.env.PRIVATE_MODE = 'false';
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { createServer } = require('./src/server');
const { closeClient } = require('./src/services/tvHistory');
async function main() {
  for (const name of ['scanner', 'journal']) {
    const html = fs.readFileSync(`public/${name}.html`, 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    // Dynamic template IDs live inside scripts; validate actual static markup separately.
    const markup = html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
    const staticIds = [...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
    assert.equal(new Set(staticIds).size, staticIds.length, `${name}: duplicate static IDs`);
    assert(ids.includes('main-content'));
    assert(html.includes('PAPER RESEARCH'));
    for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  }
  const code = fs.readFileSync('public/assets/workspace.js', 'utf8');
  let click, listener, stored, observer;
  const classes = new Set();
  const button = { setAttribute(k,v) { this[k] = v; }, addEventListener(_, fn) { click = fn; } };
  const node = { textContent: '—', classList: { remove() {}, add() { throw new Error('Reduced motion must not animate'); } } };
  const reduced = { matches: true, addEventListener(_, fn) { listener = fn; } };
  vm.runInNewContext(code, {
    window: { matchMedia: () => reduced },
    document: { body: { classList: { toggle(k,on) { on ? classes.add(k) : classes.delete(k); } } }, querySelector: () => button, querySelectorAll: () => [node] },
    localStorage: { getItem: () => null, setItem: (k,v) => { stored = v; } },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} }, setTimeout, clearTimeout,
  });
  assert(classes.has('motion-paused')); assert(button.disabled);
  node.textContent = '5'; observer(); node.textContent = '6'; observer();
  reduced.matches = false; listener(); click(); assert.equal(stored, 'false'); assert(!classes.has('motion-paused'));
  click(); assert.equal(stored, 'true'); assert(classes.has('motion-paused'));
  const css = fs.readFileSync('public/assets/workspace.css', 'utf8');
  assert(css.includes('@media(prefers-reduced-motion:reduce)'));
  const sw = fs.readFileSync('public/service-worker.js', 'utf8');
  assert(sw.includes("'/assets/workspace.css'")); assert(sw.includes("'/assets/workspace.js'")); new vm.Script(sw);
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const route of ['/app', '/journal', '/assets/workspace.css', '/assets/workspace.js']) {
      const response = await fetch(base + route); assert.equal(response.status, 200, route);
      const body = await response.text(); assert(body.length > 100);
    }
    assert.equal((await fetch(base + '/assets/missing.css')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('UI checks passed: page contracts, scripts, motion controls, offline asset list and HTTP routes');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(closeClient);
