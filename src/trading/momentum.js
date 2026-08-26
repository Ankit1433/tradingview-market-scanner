/**
 * Tracks the last 5 scan cycles per stock and scores whether price/change/
 * relative-volume are all trending up together. Mirrors update_momentum()/
 * momentum_score(). State is module-level, same as the Python globals -
 * reset via resetMomentum() at the start of each trading day.
 */

let momentumHistory = new Map(); // stock -> array of {price, change, relVolume}, max 5, oldest first

function updateMomentum(stock, info) {
  if (!momentumHistory.has(stock)) momentumHistory.set(stock, []);
  const hist = momentumHistory.get(stock);
  hist.push({ price: info.price, change: info.change, relVolume: info.relVolume });
  if (hist.length > 5) hist.shift(); // deque(maxlen=5) equivalent
}

const isSorted = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] <= v);

function momentumScore(stock) {
  const history = momentumHistory.get(stock);
  if (!history || history.length < 5) return 0;

  let score = 0;
  const prices = history.map((x) => x.price);
  const changes = history.map((x) => x.change);
  const relVols = history.map((x) => x.relVolume);

  if (isSorted(prices)) score += 30;
  if (isSorted(changes)) score += 25;
  if (isSorted(relVols)) score += 30;
  if (relVols[relVols.length - 1] >= 2) score += 15;

  return score;
}

function resetMomentum() {
  momentumHistory = new Map();
}

module.exports = { updateMomentum, momentumScore, resetMomentum };
