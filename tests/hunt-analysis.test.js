// node tests/hunt-analysis.test.js
// Ελέγχει analyzeHunt / analyzeGame με συνθετικούς χρόνους βημάτων (χωρίς ήχο):
// σταθερό, επιτάχυνση LoS (×1.65 σε ~13 s), Revenant 1.0→3.0, Deogen που πλησιάζει,
// Dayan, Kormos, θόρυβος χρονισμού, χαμένα/ψεύτικα βήματα, κενά.
"use strict";
const path = require("path");
const { analyzeHunt, analyzeGame, speedToBpm } = require(path.join(__dirname, "..", "footsteps.js"));

// mulberry32: ο απλός LCG έβγαζε συσχετισμένες σειρές (4 «χαμένα» βήματα εναλλάξ στη σειρά),
// που είναι αδύνατο να ξεχωρίσουν από ghost στη μισή ταχύτητα.
let seed = 99;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

/** Βήματα για προφίλ ταχύτητας v(t), διάρκεια dur. */
function walk(vOf, dur, o = {}) {
  const ts = []; let t = 0.3;
  while (t < dur) {
    if (!(o.miss && rnd() < o.miss)) ts.push(t + (o.jitter ?? 0.006) * gauss());
    if (o.extra && rnd() < o.extra) ts.push(t + 0.11 + 0.05 * rnd());
    if (o.gapAt && t > o.gapAt && t < o.gapAt + o.gapLen) { t = o.gapAt + o.gapLen; continue; }
    t += 60 / speedToBpm(vOf(t));
  }
  return ts.sort((a, b) => a - b);
}

let fails = 0, total = 0;
function check(name, cond, info) { total++; if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`); }
const fmt = r => r ? `${r.trend}${r.trend === "switch" ? ` ${r.from.toFixed(2)}→${r.to.toFixed(2)}` : ""} start ${r.start.toFixed(2)} end ${r.end.toFixed(2)} mean ${r.mean.toFixed(2)} min ${r.min.toFixed(2)} max ${r.max.toFixed(2)} steady ${r.steady.toFixed(1)}s` : "null";
const close = (a, b, tol = 0.06) => Math.abs(a - b) <= tol;

for (const s0 of [99, 7, 2026]) {
  seed = s0;
  const tag = `seed ${String(s0).padEnd(4)}`;
  const losAccel = t => t < 3 ? 1.7 : Math.min(1.7 * 1.65, 1.7 * (1 + 0.65 * (t - 3) / 13));

  let r = analyzeHunt(walk(() => 1.7, 25));
  check(`${tag} constant 1.70`, r && r.trend === "constant" && close(r.start, 1.7) && close(r.mean, 1.7) && r.steady > 15, fmt(r));

  r = analyzeHunt(walk(losAccel, 25));
  check(`${tag} LoS accel 1.70→2.80`, r && r.trend === "accelerating" && close(r.start, 1.7, 0.1) && close(r.end, 2.8, 0.12), fmt(r));

  r = analyzeHunt(walk(t => t < 10 ? 1.0 : 3.0, 22));
  check(`${tag} Revenant 1.0→3.0`, r && r.trend === "switch" && close(r.from, 1.0, 0.08) && close(r.to, 3.0, 0.12) && close(r.switchAt, 10, 3), fmt(r));

  r = analyzeHunt(walk(t => Math.max(0.4, 3.0 - 0.12 * t), 25));
  // Κάτω από ~1 m/s τα βήματα αραιώνουν (0.4 m/s = 1 βήμα / 2.4 s), οπότε το τέλος της καμπύλης
  // μένει λίγο πάνω από την πραγματική ταχύτητα· σημασία έχει ότι ανιχνεύεται επιβράδυνση.
  check(`${tag} Deogen 3.0→0.4 (slowing)`, r && (r.trend === "slowing") && r.start > 2.4 && r.end < 1.4, fmt(r));

  r = analyzeHunt(walk(t => (t > 8 && t < 16) ? 2.25 : 1.2, 24));
  check(`${tag} Dayan 1.2↔2.25 (switch or variable, max≈2.25)`, r && (r.trend === "switch" || r.trend === "variable") && close(r.max, 2.25, 0.12) && close(r.min, 1.2, 0.1), fmt(r));

  r = analyzeHunt(walk(t => t < 9 ? 1.7 : 2.21, 22));
  check(`${tag} Kormos 1.7→2.21`, r && r.trend === "switch" && close(r.from, 1.7, 0.08) && close(r.to, 2.21, 0.1), fmt(r));

  r = analyzeHunt(walk(() => 2.5, 20, { miss: 0.1, extra: 0.06, jitter: 0.012 }));
  check(`${tag} 2.5 with missed+extra steps`, r && r.trend === "constant" && close(r.mean, 2.5, 0.08), fmt(r));

  r = analyzeHunt(walk(() => 1.7, 30, { gapAt: 10, gapLen: 6 }));
  check(`${tag} 1.7 with 6 s silent gap`, r && r.trend === "constant" && r.segments === 2 && close(r.mean, 1.7), fmt(r) + ` segs ${r && r.segments}`);
}

check("too few steps → null", analyzeHunt([0, 0.5, 1, 1.5]) === null);

// Τυχαίοι ήχοι (πόρτες, φωνές, αντικείμενα, ambience): ακανόνιστα onsets → ΟΧΙ hunt.
function randomOnsets(rate, dur) { const ts = []; let t = 0.2; while (t < dur) { t += Math.max(0.17, -Math.log(rnd() + 1e-12) / rate); ts.push(t); } return ts; }
let falseHunts = 0, trials = 0;
for (const s0 of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) for (const rate of [0.7, 1.5, 3]) {
  seed = s0 * 31 + rate * 7; trials++;
  if (analyzeHunt(randomOnsets(rate, 25))) falseHunts++;
}
check(`random sounds → no hunt (${trials} trials)`, falseHunts === 0, `${falseHunts} false hunts`);

// Πραγματικό hunt με θόρυβο πριν και μετά: η διάρκεια/τα βήματα αφορούν μόνο το ρυθμικό κομμάτι.
{
  seed = 4040;
  const pre = randomOnsets(1.5, 6), hunt = walk(() => 1.7, 15).map(t => t + 7), post = randomOnsets(1.5, 5).map(t => t + 23);
  const r = analyzeHunt([...pre, ...hunt, ...post].sort((a, b) => a - b));
  check("hunt with junk before/after → trimmed", r && close(r.mean, 1.7) && r.duration < 17 && r.duration > 12 && r.spanStart > 5.5, r ? `${fmt(r)} dur ${r.duration.toFixed(1)} span ${r.spanStart.toFixed(1)}–${r.spanEnd.toFixed(1)} cov ${r.coverage.toFixed(2)}` : "null");
}

// Από hunt σε hunt
const g = s => JSON.stringify(analyzeGame(s));
check("twins 1.53/1.87", analyzeGame([1.53, 1.88, 1.52])?.kind === "twins", g([1.53, 1.88, 1.52]));
check("Thaye ageing", analyzeGame([2.75, 2.4, 2.0, 1.6])?.kind === "decreasing", g([2.75, 2.4, 2.0, 1.6]));
check("Moroi speeding up", analyzeGame([1.5, 1.7, 1.95, 2.2])?.kind === "increasing", g([1.5, 1.7, 1.95, 2.2]));
check("stable 1.7", analyzeGame([1.7, 1.72, 1.69])?.kind === "stable", g([1.7, 1.72, 1.69]));
check("single hunt → null", analyzeGame([1.7]) === null);

console.log(`\n${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
