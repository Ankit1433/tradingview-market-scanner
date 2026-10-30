(function () {
  'use strict';
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  var paused = reduced.matches;
  try { paused = paused || localStorage.getItem('ankquant-motion-paused') === 'true'; } catch (_) {}
  var button = document.querySelector('.motion-toggle');
  function apply() {
    document.body.classList.toggle('motion-paused', paused || reduced.matches);
    if (button) {
      button.setAttribute('aria-pressed', String(paused || reduced.matches));
      button.textContent = paused || reduced.matches ? 'Motion off' : 'Motion on';
      button.disabled = reduced.matches;
      button.title = reduced.matches ? 'Reduced motion is enabled in your device settings' : 'Toggle decorative animations';
    }
  }
  if (button) button.addEventListener('click', function () {
    paused = !paused;
    try { localStorage.setItem('ankquant-motion-paused', String(paused)); } catch (_) {}
    apply();
  });
  if (reduced.addEventListener) reduced.addEventListener('change', apply);
  apply();
  // Highlight changed values, without changing numbers or announcing fake activity.
  document.querySelectorAll('.metric-value').forEach(function (node) {
    var last = node.textContent;
    var timer;
    new MutationObserver(function () {
      var current = node.textContent;
      if (current === last) return;
      var initial = last.trim() === '—';
      last = current;
      if (initial || paused || reduced.matches) return;
      node.classList.remove('data-updated');
      void node.offsetWidth;
      node.classList.add('data-updated');
      clearTimeout(timer);
      timer = setTimeout(function () { node.classList.remove('data-updated'); }, 850);
    }).observe(node, { childList: true, characterData: true, subtree: true });
  });
})();

(function(){
 if(typeof fetch!=='function'||!document.querySelector('#main-content'))return;
 fetch('/api/public/market/status').then(function(response){if(!response.ok)return null;return response.json();}).then(function(data){if(data&&data.marketData&&data.marketData.screeningVerification==='unverified-paper'){var note=document.createElement('p');note.className='paper-banner';note.setAttribute('role','note');note.textContent='UNVERIFIED PAPER SCANNING · Screener comparison skipped. Informational signals only; no orders placed.';document.querySelector('#main-content').prepend(note);}}).catch(function(){});
})();
