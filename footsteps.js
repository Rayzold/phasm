// Phasmo Journal — αυτόματη ανίχνευση βημάτων ghost από ήχο.
// Τρέχει ίδιο σε browser και Node (tests): window.PhasmFootsteps / module.exports.
//
// Pipeline: band-pass (70 Hz – 2 kHz, εκεί ζουν τα «γδούπα» των βημάτων) → ενέργεια ανά 5 ms →
// onset όταν η ενέργεια ξεπερνά τον θόρυβο βάθους ΚΑΙ ανεβαίνει απότομα → median των διαστημάτων
// (ανθεκτικό σε χαμένα/ψεύτικα βήματα) → BPM → m/s με τη σχέση v = bpm / (60 + 0.075·bpm).
// Ο χρόνος μετριέται σε δείγματα ήχου, όχι Date.now(), οπότε δεν επηρεάζεται από lag του tab.
(function (root) {
  "use strict";

  // RBJ biquad (Audio EQ Cookbook)
  function biquad(type, fs, f0, q) {
    const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), a = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
    else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
    const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
    const k = { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return function (x) {
      const y = k.b0 * x + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    };
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** v (m/s) ↔ βήματα ανά λεπτό. Ίδια σχέση με το Footstep Tapper. */
  function bpmToSpeed(bpm) { return bpm / (60 + 0.075 * bpm); }
  function speedToBpm(v) { return 60 * v / (1 - 0.075 * v); }

  // Όρια φυσικής: πιο γρήγορο ghost 3.71 m/s → ~308 bpm (βήμα / 195 ms), πιο αργό 0.4 → ~25 bpm.
  const MIN_STEP_S = 0.17, MAX_STEP_S = 2.7, RESET_GAP_S = 3.2;
  // Ένα βήμα είναι σύντομο: η ενέργεια πρέπει να πέσει DECAY_DB κάτω από το peak μέσα σε CONFIRM_S.
  const DECAY_DB = 8, CONFIRM_S = 0.16;

  class FootstepDetector {
    /**
     * @param {object} o
     * @param {number} o.sampleRate
     * @param {number} [o.sensitivity=0.5]  0 = μόνο δυνατά βήματα, 1 = πιάνει και σιγανά (περισσότερα false positives)
     * @param {(e:{t:number,strength:number})=>void} [o.onStep]   t σε δευτερόλεπτα ροής
     * @param {(e:{bpm:number,speed:number,steps:number,confidence:number}|null)=>void} [o.onTempo]
     * @param {(e:{db:number,floor:number})=>void} [o.onLevel]  ~10 φορές/δευτ., για meter
     */
    constructor(o) {
      this.fs = o.sampleRate;
      this.onStep = o.onStep || null;
      this.onTempo = o.onTempo || null;
      this.onLevel = o.onLevel || null;
      this.setSensitivity(o.sensitivity == null ? 0.5 : o.sensitivity);
      this._hp1 = biquad("hp", this.fs, 70, 0.707);
      this._hp2 = biquad("hp", this.fs, 70, 0.707);
      this._lp1 = biquad("lp", this.fs, Math.min(2000, this.fs * 0.45), 0.707);
      this._lp2 = biquad("lp", this.fs, Math.min(2000, this.fs * 0.45), 0.707);
      this._hop = Math.round(this.fs / 200); // 5 ms
      this._fps = this.fs / this._hop;
      this._acc = 0; this._n = 0;
      this._frame = 0;              // πλήθος frames που έχουν επεξεργαστεί
      this._db = [];                // πρόσφατα dB (για rise)
      this._floorHist = [];         // ~3 s ιστορικό για noise floor
      this._floorLen = Math.round(3 * this._fps);
      this._every100 = Math.max(1, Math.round(0.1 * this._fps));
      this._riseLen = Math.max(2, Math.round(0.03 * this._fps)); // ~30 ms
      this._floor = -90;
      this._lastOnsetFrame = -1e9;
      this._armed = true;           // περιμένει να πέσει η ενέργεια πριν το επόμενο onset
      this._peakSince = -200;
      this.steps = [];              // χρόνοι (s) τρέχουσας σειράς βημάτων
      this._lastTempo = null;
    }

    setSensitivity(s) {
      this.sensitivity = Math.max(0, Math.min(1, s));
      this._overFloor = lerp(16, 7, this.sensitivity); // dB πάνω από τον θόρυβο βάθους
      this._rise = lerp(9, 4, this.sensitivity);       // dB άνοδος μέσα σε ~30 ms
      this._gate = lerp(-50, -66, this.sensitivity);   // απόλυτο κατώφλι dBFS
    }

    reset() { this.steps = []; this._lastTempo = null; if (this.onTempo) this.onTempo(null); }

    /** @param {Float32Array|number[]} samples mono, -1..1 */
    process(samples) {
      for (let i = 0; i < samples.length; i++) {
        const y = this._lp2(this._lp1(this._hp2(this._hp1(samples[i]))));
        this._acc += y * y;
        if (++this._n === this._hop) { this._onFrame(this._acc / this._n); this._acc = 0; this._n = 0; }
      }
    }

    _onFrame(energy) {
      const f = this._frame++;
      const db = 10 * Math.log10(energy + 1e-12);
      const d = this._db; d.push(db); if (d.length > this._riseLen + 1) d.shift();

      // Noise floor = 25ο εκατοστημόριο των τελευταίων ~3 s (ανανέωση κάθε 100 ms).
      const fh = this._floorHist; fh.push(db); if (fh.length > this._floorLen) fh.shift();
      if (f % this._every100 === 0) {
        const s = fh.slice().sort((a, b) => a - b);
        this._floor = s[Math.floor(s.length * 0.25)];
      }
      if (this.onLevel && f % this._every100 === 0) this.onLevel({ db, floor: this._floor });

      const t = f * this._hop / this.fs;
      const prevMin = Math.min(...d.slice(0, -1));
      const rise = d.length > 1 ? db - prevMin : 0;
      const loud = db > this._gate && db > this._floor + this._overFloor;

      // Re-arm όταν η ενέργεια πέσει ξανά κοντά στο floor ή αρκετά κάτω από το τελευταίο peak.
      if (!this._armed) {
        if (db > this._peakSince) this._peakSince = db;
        if (db < this._floor + this._overFloor * 0.5 || db < this._peakSince - 10) this._armed = true;
      }

      // Υποψήφιο βήμα: επιβεβαιώνεται μόνο αν σβήσει γρήγορα (γδούπος). Φωνές, μουγκρητά, drones
      // κρατάνε την ενέργεια ψηλά για εκατοντάδες ms και απορρίπτονται.
      const p = this._pending;
      if (p) {
        if (db > p.peak) p.peak = db;
        if (db <= p.peak - DECAY_DB) { this._pending = null; this._addStep(p.t, p.strength); }
        else if ((f - p.f) / this._fps > CONFIRM_S) this._pending = null;
      }

      const refractory = (f - this._lastOnsetFrame) / this._fps >= MIN_STEP_S;
      if (!this._pending && loud && rise >= this._rise && this._armed && refractory) {
        this._lastOnsetFrame = f; this._armed = false; this._peakSince = db;
        this._pending = { t, f, peak: db, strength: db - this._floor };
      }

      // Λήξη σειράς αν σταμάτησαν τα βήματα.
      if (this.steps.length && t - this.steps[this.steps.length - 1] > RESET_GAP_S) this.reset();
    }

    _addStep(t, strength) {
      if (this.steps.length && t - this.steps[this.steps.length - 1] > RESET_GAP_S) this.steps = [];
      this.steps.push(t);
      if (this.steps.length > 16) this.steps.shift();
      if (this.onStep) this.onStep({ t, strength });
      const tempo = estimateTempo(this.steps);
      this._lastTempo = tempo;
      if (this.onTempo) this.onTempo(tempo);
    }
  }

  /**
   * Ανθεκτική εκτίμηση ρυθμού από χρόνους βημάτων.
   * - median διαστήματος ως άγκυρα
   * - διάστημα ≈2× ή ≈3× median = χαμένο βήμα → μετράει διαιρεμένο
   * - ψεύτικα onsets ανάμεσα σε δύο πραγματικά συγχωνεύονται (άθροισμα γειτονικών ≈ median)
   * @returns {{bpm:number,speed:number,steps:number,confidence:number}|null}
   */
  function estimateTempo(times) {
    if (times.length < 3) return null;
    const ints = [];
    for (let i = 1; i < times.length; i++) ints.push(times[i] - times[i - 1]);
    const recent = ints.slice(-12);

    // Υποψήφιες περίοδοι: κάθε διάστημα και κάθε άθροισμα 2 γειτονικών. Κράτα αυτή που εξηγεί
    // τα περισσότερα διαστήματα (ως πολλαπλάσια) με το μικρότερο σφάλμα.
    const cands = recent.slice();
    for (let i = 1; i < recent.length; i++) cands.push(recent[i - 1] + recent[i]);
    let best = null;
    for (const p of cands) {
      if (p < MIN_STEP_S || p > MAX_STEP_S) continue;
      let covered = 0, err = 0, used = [], beats = 0, missed = 0, merged = 0;
      // Σάρωση με συγχώνευση: προσθέτει διαστήματα μέχρι να φτάσει ακέραιο πολλαπλάσιο του p.
      let run = 0, parts = 0;
      for (const x of recent) {
        run += x; parts++;
        const k = Math.round(run / p);
        if (k >= 1 && Math.abs(run - k * p) <= 0.15 * p && k <= 3) {
          covered += run; err += Math.abs(run - k * p) / p; used.push(run / k);
          beats += k; missed += k - 1; merged += parts - 1; run = 0; parts = 0;
        } else if (run > 3.3 * p) { run = 0; parts = 0; } // δεν ταιριάζει, ξεκίνα πάλι
      }
      if (used.length < 2) continue;
      const total = recent.reduce((a, b) => a + b, 0);
      // Ποινή για «χαμένα» βήματα (αλλιώς η μισή περίοδος εξηγεί τα πάντα ως 2× → διπλή ταχύτητα) και
      // για «ψεύτικα» onsets που συγχωνεύτηκαν (αλλιώς η διπλή περίοδος τα εξηγεί όλα → μισή ταχύτητα).
      const score = covered / total - 0.5 * err / used.length - 0.9 * missed / beats - 1.1 * merged / recent.length;
      if (!best || score > best.score + 1e-9)
        best = { p, score, used, coverage: covered / total };
    }
    if (!best) return null;
    const med = median(best.used);
    const tight = best.used.filter(u => Math.abs(u - med) <= 0.06 * med);
    const period = tight.length ? tight.reduce((a, b) => a + b, 0) / tight.length : med; // μέσος όρος inliers: ακρίβεια κάτω από το frame
    const bpm = 60 / period;
    const spread = best.used.length > 1 ? median(best.used.map(u => Math.abs(u - period))) / period : 0;
    const confidence = Math.max(0, Math.min(1, best.coverage * (1 - 4 * spread) * Math.min(1, best.used.length / 5)));
    return { bpm, speed: bpmToSpeed(bpm), steps: times.length, confidence };
  }

  const api = { FootstepDetector, estimateTempo, bpmToSpeed, speedToBpm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PhasmFootsteps = api;
})(typeof self !== "undefined" ? self : this);
