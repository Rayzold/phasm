// node tests/footsteps.test.js
// Συνθετικά «βήματα» (γδούπος χαμηλών + θόρυβος) σε γνωστές ταχύτητες, με θόρυβο βάθους,
// διακυμάνσεις έντασης, χαμένα βήματα και τυχαίους ήχους-παγίδες. ΔΕΝ είναι ήχος του παιχνιδιού:
// ελέγχει τη λογική, το πραγματικό tuning θέλει ηχογράφηση από Phasmophobia.
"use strict";
const path = require("path");
const { FootstepDetector, estimateTempo, speedToBpm, bpmToSpeed } = require(path.join(__dirname, "..", "footsteps.js"));

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const FS = 16000;

function thud(buf, at, amp) {
  // ~90 ms: ημιτονο 70–110 Hz με γρήγορη απόσβεση + χαμηλοπερασμένος θόρυβος (το «χτύπημα»)
  const f = 70 + rnd() * 40, n = Math.round(0.12 * FS);
  let lp = 0;
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const t = i / FS, env = Math.exp(-t / 0.035) * Math.min(1, i / 16);
    lp += 0.15 * (gauss() - lp);
    buf[at + i] += amp * env * (0.7 * Math.sin(2 * Math.PI * f * t) + 0.9 * lp);
  }
}
function voiceBlip(buf, at, amp) {
  // ~0.4 s τονικός ήχος με αρμονικές (σαν φωνή/μουγκρητό) — παγίδα, δεν είναι βήμα
  const f0 = 120 + rnd() * 150, n = Math.round((0.25 + rnd() * 0.3) * FS);
  for (let i = 0; i < n && at + i < buf.length; i++) {
    const t = i / FS, env = Math.sin(Math.PI * i / n);
    buf[at + i] += amp * env * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t) + 0.25 * Math.sin(6 * Math.PI * f0 * t));
  }
}
function click(buf, at, amp) { for (let i = 0; i < 40 && at + i < buf.length; i++) buf[at + i] += amp * gauss() * Math.exp(-i / 8); }

/** Παράγει ήχο με βήματα σε ταχύτητα v (m/s). */
function scene(v, o = {}) {
  const dur = o.dur || 10, buf = new Float32Array(dur * FS);
  const noise = o.noise == null ? 0.004 : o.noise;   // ~ -48 dBFS
  let pink = 0;
  for (let i = 0; i < buf.length; i++) { pink = 0.98 * pink + 0.02 * gauss(); buf[i] = noise * (gauss() * 0.5 + pink * 3); }
  if (o.hum) for (let i = 0; i < buf.length; i++) buf[i] += o.hum * Math.sin(2 * Math.PI * 50 * i / FS);
  const T = 60 / speedToBpm(v), start = o.start || 1.0;
  const truth = [];
  for (let t = start, k = 0; t < dur - 0.2; t += T, k++) {
    if (o.miss && rnd() < o.miss) continue;
    const approach = o.approach ? 0.25 + 0.75 * (t - start) / (dur - start) : 1; // πλησιάζει → δυναμώνει
    const wander = o.wander ? Math.pow(10, (o.wander * Math.sin(2 * Math.PI * (t - start) / 7)) / 20) : 1; // πλησιάζει-απομακρύνεται
    const amp = (o.amp || 0.25) * approach * wander * (1 + (o.ampVar ?? 0.3) * (rnd() - 0.5));
    const jitter = (o.jitter || 0.004) * gauss();
    thud(buf, Math.round((t + jitter) * FS), amp);
    truth.push(t);
  }
  if (o.voices) for (let i = 0; i < o.voices; i++) voiceBlip(buf, Math.floor(rnd() * (dur - 0.5) * FS), o.voiceAmp || 0.05);
  if (o.clicks) for (let i = 0; i < o.clicks; i++) click(buf, Math.floor(rnd() * dur * FS), o.clickAmp || 0.3);
  return { buf, truth };
}

// last = η τελευταία ένδειξη που θα έβλεπε ο χρήστης (μόνο ρυθμικά βήματα περνούν στο UI)
function run(buf, sens = 0.5) {
  let last = null, any = null; const steps = [];
  const det = new FootstepDetector({ sampleRate: FS, sensitivity: sens,
    onStep: e => steps.push(e.t), onTempo: t => { if (t) { any = t; if (t.rhythmic) last = t; } } });
  for (let i = 0; i < buf.length; i += 320) det.process(buf.subarray(i, i + 320)); // 20 ms chunks σαν τον helper
  return { last, any, steps };
}

let fails = 0, total = 0;
function check(name, cond, info) { total++; if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${info ? "  — " + info : ""}`); }

// 0) Μαθηματικά: ίδια σχέση με τον Tapper του index.html
check("bpm↔speed round trip", Math.abs(bpmToSpeed(speedToBpm(1.7)) - 1.7) < 1e-9, `1.7 m/s = ${speedToBpm(1.7).toFixed(1)} bpm`);
// 1) estimateTempo: χαμένο βήμα, ψεύτικο βήμα, μισή περίοδος
{
  const P = 0.513, ts = []; for (let i = 0; i < 9; i++) ts.push(i * P);
  const miss = ts.filter((_, i) => i !== 4);
  const extra = ts.concat([2 * P + 0.2]).sort((a, b) => a - b);
  const a = estimateTempo(miss), b = estimateTempo(extra), c = estimateTempo(ts);
  check("tempo: clean", Math.abs(c.speed - 1.7) < 0.01, c.speed.toFixed(3));
  check("tempo: one missed step", Math.abs(a.speed - 1.7) < 0.02, a.speed.toFixed(3));
  check("tempo: one spurious onset", Math.abs(b.speed - 1.7) < 0.02, b.speed.toFixed(3));
}

const SPEEDS = [0.4, 1.0, 1.36, 1.5, 1.7, 1.96, 2.25, 2.5, 2.75, 3.0, 3.71];
const CASES = [
  { name: "clean", o: {} },
  { name: "noisy+hum", o: { noise: 0.012, hum: 0.01 } },
  { name: "approaching (quiet→loud)", o: { approach: true } },
  { name: "10% missed steps", o: { miss: 0.1 } },
  { name: "voices+clicks distractors", o: { voices: 4, clicks: 3 } },
];
for (const s0 of [12345, 777, 31337]) {
  seed = s0;
  for (const c of CASES) {
    for (const v of SPEEDS) {
      const dur = v < 0.6 ? 30 : 10; // 0.4 m/s = 1 βήμα / 2.4 s: χρειάζεται ~30 s για αρκετά βήματα
      const { buf, truth } = scene(v, Object.assign({ dur }, c.o));
      const { last, steps } = run(buf);
      const ok = last && Math.abs(last.speed - v) <= Math.max(0.05, 0.03 * v);
      check(`seed ${String(s0).padEnd(5)} ${c.name.padEnd(26)} v=${v.toFixed(2)}`, !!ok,
        last ? `→ ${last.speed.toFixed(2)} m/s (${last.bpm.toFixed(0)} bpm, conf ${last.confidence.toFixed(2)}, ${steps.length}/${truth.length} onsets)` : `no tempo (${steps.length}/${truth.length} onsets)`);
    }
  }
}
// Αλλαγή ταχύτητας μέσα στο hunt (Revenant σε βλέπει): η ένδειξη πρέπει να ακολουθήσει.
{
  seed = 4242;
  const a = scene(1.0, { dur: 6 }), b = scene(3.0, { dur: 6, start: 0.1 });
  const buf = new Float32Array(a.buf.length + b.buf.length); buf.set(a.buf); buf.set(b.buf, a.buf.length);
  const { last } = run(buf);
  check("speed switch 1.0 → 3.0 mid-hunt", last && Math.abs(last.speed - 3.0) < 0.06, last ? last.speed.toFixed(2) : "none");
}
// 1b) Δικά σου βήματα: ο παίκτης περπατάει με 1.6 m/s, το ghost (βασική) με 1.7. Σε πραγματικό ήχο
// (Ridgeview, βροχή) μετρήθηκαν 1.57–1.60 vs 1.65–1.72 — η διάκριση γίνεται με την ταχύτητα.
{
  const seeds = [2468, 1357, 42, 7, 99, 123, 555, 9001, 31, 64];
  let own = 0, ghostFlagged = 0, ghostRuns = 0;
  for (const sd of seeds) {
    seed = sd; const o = run(scene(1.6, { dur: 12, ampVar: 0.06 }).buf); if (o.last && o.last.selfLike) own++;
    seed = sd; const a = run(scene(1.7, { dur: 12, approach: true }).buf); ghostRuns++; if (!a.last || a.last.selfLike) ghostFlagged++;
    seed = sd; const w = run(scene(1.7, { dur: 14, wander: 6 }).buf); ghostRuns++; if (!w.last || w.last.selfLike) ghostFlagged++;
  }
  check(`own footsteps flagged as yours (≥6/${seeds.length}; συντηρητικό ώστε να μην κρύβεται ghost)`, own >= 6, `${own}/${seeds.length}`);
  check(`moving ghost never flagged as yours`, ghostFlagged === 0, `${ghostFlagged}/${ghostRuns} flagged or missing`);
}
// 2) Σιωπή / μόνο θόρυβος / μόνο φωνές: δεν πρέπει να «βρει» ρυθμό με υψηλή σιγουριά
{
  seed = 999;
  const quiet = scene(1.7, { dur: 10, start: 99 }).buf;
  const r1 = run(quiet);
  check("noise only → no tempo", !r1.last, r1.last ? r1.last.speed.toFixed(2) : `${r1.steps.length} onsets`);
  const vox = scene(1.7, { dur: 10, start: 99, voices: 12 }).buf;
  const r2 = run(vox);
  check("voices only → no confident tempo", !r2.last || r2.last.confidence < 0.5, r2.last ? `${r2.last.speed.toFixed(2)} conf ${r2.last.confidence.toFixed(2)}` : `${r2.steps.length} onsets`);
  // Διακόπτης φωτός που αναβοσβήνει ρυθμικά (πραγματικό bug 7/11: έβγαινε «hunt 3.10 m/s»).
  const sw = scene(1.7, { dur: 12, start: 99 }).buf;
  for (let t = 0.5; t < 11.5; t += 0.245) click(sw, Math.round(t * FS), 0.3);
  const r3 = run(sw);
  check("rhythmic light-switch clicks → no tempo", !r3.last, r3.last ? `${r3.last.speed.toFixed(2)} m/s, ${r3.steps.length} onsets` : `${r3.steps.length} onsets`);
}
console.log(`\n${total - fails}/${total} passed`);
process.exit(fails ? 1 : 0);
