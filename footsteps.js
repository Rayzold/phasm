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

  // ───────────── Spectral-flux onsets (ανθεκτικό σε σταθερό θόρυβο: βροχή, αέρας, βουητό) ─────────────
  // Μετράει πόσο ΑΥΞΑΝΕΤΑΙ ξαφνικά το φάσμα (log-magnitude) από frame σε frame, όχι πόσο δυνατός
  // είναι ο ήχος. Βάση: Dixon 2006 «Onset detection revisited», Böck & Widmer 2013 «SuperFlux»
  // (max-filter στη συχνότητα + σύγκριση με frame μ=2 πίσω), peak-picking κατά Böck 2012.

  /** In-place iterative radix-2 FFT (re, im: Float64Array μήκους 2^k). */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < h; k++) {
          const a = i + k, b = a + h;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  class FluxOnsets {
    /** @param {{fs:number, onOnset:(t:number,strength:number)=>void, onLevel?:(l:{db:number,floor:number})=>void}} o */
    constructor(o) {
      this.fs = o.fs; this.onOnset = o.onOnset; this.onLevel = o.onLevel || null; this.onLow = o.onLow || null;
      this.N = 1 << Math.round(Math.log2(this.fs * 0.032));           // ~32 ms παράθυρο
      this.hop = Math.round(this.fs / 200);                             // 5 ms
      this.fps = this.fs / this.hop;
      this.kLo = Math.max(1, Math.ceil(FLUX_LO_HZ * this.N / this.fs));
      this.kHi = Math.floor(Math.min(FLUX_HI_HZ, this.fs * 0.45) * this.N / this.fs);
      this.kLowN = Math.max(1, Math.floor(AC_HI_HZ * this.N / this.fs) - this.kLo + 1); // bins 60–1000 Hz για το rhythm path
      this.win = new Float64Array(this.N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N));
      this.ring = new Float32Array(this.N); this.rpos = 0; this.filled = 0; this.sinceHop = 0;
      this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
      this.hist = [];                         // log-spectra των τελευταίων frames (για μ=2)
      this.flux = []; this.bandDb = []; this.cent = []; this.bass = []; // ανά frame
      this.kB0 = Math.max(1, Math.ceil(30 * this.N / this.fs)); this.kB100 = Math.floor(100 * this.N / this.fs);
      this.kB1 = Math.floor(1000 * this.N / this.fs);
      this.frame = 0; this.lastOnset = -1e9;
      this.dbHist = []; this.floor = -90;
      this.setSensitivity(0.5);
    }
    setSensitivity(s) {
      this.alpha = lerp(2.6, 1.5, s);         // πόσες φορές πάνω από τον τοπικό μέσο όρο του flux
      this.delta = lerp(0.9, 0.35, s);        // + σταθερό περιθώριο (μονάδες flux / bin)
      this.gate = lerp(-58, -72, s);          // απόλυτο κατώφλι ενέργειας band (dBFS)
    }
    process(x) {
      for (let i = 0; i < x.length; i++) {
        this.ring[this.rpos] = x[i]; this.rpos = (this.rpos + 1) % this.N;
        if (this.filled < this.N) this.filled++;
        if (++this.sinceHop >= this.hop) { this.sinceHop = 0; if (this.filled === this.N) this._frame(); }
      }
    }
    _frame() {
      const N = this.N, re = this.re, im = this.im;
      for (let i = 0; i < N; i++) { re[i] = this.ring[(this.rpos + i) % N] * this.win[i]; im[i] = 0; }
      fft(re, im);
      const K = this.kHi - this.kLo + 1, L = new Float32Array(K);
      let pow = 0, pf = 0;
      for (let k = 0; k < K; k++) {
        const kk = k + this.kLo, p = re[kk] * re[kk] + im[kk] * im[kk];
        pow += p; pf += p * kk;
        L[k] = Math.log1p(FLUX_GAMMA * Math.sqrt(p) / N);
      }
      this.cent.push(pow > 0 ? pf / pow * this.fs / N : 0); // spectral centroid (Hz) του frame
      let bLo = 0, bAll = 0; // μερίδιο ενέργειας κάτω από 100 Hz (μέσα στα 30–1000 Hz): ο χτύπος καρδιάς είναι σχεδόν όλος εκεί
      for (let kk = this.kB0; kk <= this.kB1; kk++) { const p = re[kk] * re[kk] + im[kk] * im[kk]; bAll += p; if (kk <= this.kB100) bLo += p; }
      this.bass.push(bAll > 0 ? bLo / bAll : 0);
      const db = 10 * Math.log10(pow / (N * N) + 1e-12);
      // SuperFlux: σύγκριση με frame 2 πίσω, max-filter ±1 bin στη συχνότητα (αγνοεί μικρές μετατοπίσεις).
      const prev = this.hist.length >= 2 ? this.hist[this.hist.length - 2] : null;
      let f = 0;
      if (prev) for (let k = 0; k < K; k++) {
        const ref = Math.max(prev[k], k > 0 ? prev[k - 1] : 0, k < K - 1 ? prev[k + 1] : 0);
        const d = L[k] - ref; if (d > 0) f += d;
      }
      f /= K;
      if (this.onLow) { // απλό flux χαμηλών (χωρίς max-filter) για autocorrelation: πιάνει και σιγανά/πνιγμένα βήματα
        let lf = 0; if (prev) for (let k = 0; k < this.kLowN; k++) { const d = L[k] - prev[k]; if (d > 0) lf += d; }
        const cent = this.cent[this.cent.length - 1];
        this.onLow(cent > CLICK_CENTROID_HZ ? 0 : lf / this.kLowN); // clicks (διακόπτης) έξω και από εδώ
      }
      this.hist.push(L); if (this.hist.length > 3) this.hist.shift();
      this.flux.push(f); this.bandDb.push(db);
      const n = this.frame++;

      // Θόρυβος βάθους (για ένταση/meter): 25ο εκατοστημόριο των τελευταίων ~3 s.
      this.dbHist.push(db); if (this.dbHist.length > 3 * this.fps) this.dbHist.shift();
      if (n % 20 === 0) { const s = this.dbHist.slice().sort((a, b) => a - b); this.floor = s[Math.floor(s.length * 0.25)]; }
      if (this.onLevel && n % 20 === 0) this.onLevel({ db, floor: this.floor });

      // Peak-picking με καθυστέρηση W_POST frames: το frame c είναι onset αν είναι τοπικό μέγιστο
      // στο [c-W_PRE, c+W_POST] και ξεπερνά τον μέσο όρο του [c-W_AVG, c+W_POST] × alpha + delta.
      const c = n - W_POST;
      if (c < W_AVG) { this._trim(); return; }
      const F = this.flux, off = this.frame - F.length, at = i => F[i - off];
      const fc = at(c);
      let isMax = true;
      for (let i = c - W_PRE; i <= c + W_POST; i++) if (i !== c && at(i) > fc) { isMax = false; break; }
      if (isMax) {
        let m = 0; for (let i = c - W_AVG; i <= c + W_POST; i++) m += at(i);
        m /= (W_AVG + W_POST + 1);
        const loudDb = Math.max(this.bandDb[c - off], this.bandDb[c - off + 1] ?? -200, this.bandDb[c - off + 2] ?? -200);
        // Click (διακόπτης, πόρτα, αντικείμενο): ενέργεια ψηλά στο φάσμα. Τα βήματα είναι γδούποι κάτω από ~500 Hz.
        let cl = 0, cd = -200, bs = 0;
        for (let i = c; i <= c + 2; i++) { const d = this.bandDb[i - off] ?? -200; if (d > cd) { cd = d; cl = this.cent[i - off]; bs = this.bass[i - off]; } }
        const click = cl > CLICK_CENTROID_HZ;
        if (!click && fc >= m * this.alpha + this.delta * FLUX_UNIT && loudDb > this.gate && (c - this.lastOnset) / this.fps >= MIN_STEP_S) {
          this.lastOnset = c;
          // Ένταση βήματος: μέγιστη ενέργεια band στα επόμενα ~40 ms, πάνω από τον θόρυβο βάθους.
          let pk = -200; for (let i = c; i <= Math.min(n, c + 8); i++) pk = Math.max(pk, this.bandDb[i - off]);
          this.onOnset(c / this.fps, pk - this.floor, bs);
        }
      }
      this._trim();
    }
    _trim() { const keep = W_AVG + W_POST + 12; if (this.flux.length > keep) { const d = this.flux.length - keep; this.flux.splice(0, d); this.bandDb.splice(0, d); this.cent.splice(0, d); this.bass.splice(0, d); } }
  }
  const FLUX_LO_HZ = 60, FLUX_HI_HZ = 4000, FLUX_GAMMA = 100, FLUX_UNIT = 0.02;
  // Σε πραγματικό ήχο (7/11): διακόπτης φωτός median centroid ~2000 Hz (90% > 1270), βήματα ghost/παίκτη 170–450 Hz.
  const CLICK_CENTROID_HZ = 1000;
  // Χτύπος καρδιάς (7/11, Kormos + Deogen κοντά): περίοδος 0.60–0.61 s, 89–97% ενέργειας < 100 Hz· βήματα 7–30%.
  const HEART_LO_S = 0.595, HEART_HI_S = 0.625, HEART_BASS = 0.75;

  // ───────── Rhythm path: autocorrelation του low-band flux (χαλί, βήματα κάτω από ανάσα) ─────────
  // Πιάνει τον ρυθμό χωρίς να χρειάζεται κάθε βήμα ξεχωριστά. Σε πραγματικό ήχο (7/11): σκληρό δάπεδο
  // και χαλί 1.61 m/s (παίκτης), Normal 1.69 (1.7)· score βημάτων 0.10–0.26, διακόπτης/ησυχία 0.01–0.05.
  const AC_HI_HZ = 1000, AC_WIN_S = 12, AC_MIN_S = 8, AC_EVERY_S = 0.5, AC_MIN_SCORE = 0.08, AC_IDLE_S = 3;
  // shortcut: το rhythm path αναφέρει ΜΟΝΟ ρυθμό περπατήματος παίκτη (δικά σου βήματα σε χαλί κ.λπ.).
  // Σε hunt Deogen βγάζει 1.46 / 0.66 m/s χωρίς ground truth → θα έδειχνε λάθος ghosts. Άνοιξέ το για
  // ghosts όταν υπάρξουν ηχογραφήσεις με γνωστά βήματα ghost σε χαλί / κάτω από ανάσα.
  /**
   * Περίοδος βημάτων από envelope onsets με comb autocorrelation: μέσο AC στα P,2P,3P,4P μείον τις
   * κοιλάδες ανάμεσα. Το comb λύνει τη σύγχυση αρμονικών (P vs 2P/3P) που έχει το σκέτο μέγιστο AC.
   * @param {ArrayLike<number>} env  ένα δείγμα ανά frame
   * @returns {{period:number,bpm:number,speed:number,score:number}|null}
   */
  function combTempo(env, fps) {
    const n = env.length; if (n < 2 * fps) return null;
    let mu = 0; for (let i = 0; i < n; i++) mu += env[i]; mu /= n;
    const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = env[i] - mu;
    const maxLag = Math.min(Math.round(6 * fps), n >> 1), ac = new Float64Array(maxLag + 1);
    for (let l = 0; l <= maxLag; l++) { let s = 0; for (let i = 0; i + l < n; i++) s += x[i] * x[i + l]; ac[l] = s; }
    if (!(ac[0] > 0)) return null;
    for (let l = maxLag; l >= 0; l--) ac[l] /= ac[0];
    const at = L => { const i = Math.round(L * fps), w = Math.max(1, Math.round(0.03 * i)); if (i + w > maxLag) return NaN;
      let m = -Infinity; for (let j = i - w; j <= i + w; j++) m = Math.max(m, ac[j]); return m; };
    const lim = maxLag / fps;
    let best = null;
    for (let P = 0.3; P <= MAX_STEP_S; P += 0.005) {
      let pk = 0, va = 0, c = 0;
      for (let k = 1; k <= 4 && k * P <= lim; k++) { const a = at(k * P), b = at((k - 0.5) * P); if (Number.isNaN(a) || Number.isNaN(b)) break; pk += a; va += b; c++; }
      if (c < 2) continue;
      const score = (pk - va) / c;
      if (!best || score > best.score + 0.01) best = { period: P, score }; // αύξουσα P + περιθώριο: σε ισοπαλία η μικρότερη περίοδος
    }
    if (!best) return null;
    // Ακριβέστερη περίοδος: κορυφή (με παραβολική παρεμβολή) γύρω από kP, μέσος όρος των peak_k / k.
    const ests = [];
    for (let k = 1; k <= 4 && k * best.period <= lim; k++) {
      const c0 = k * best.period * fps, lo = Math.max(1, Math.floor(c0 * 0.95)), hi = Math.min(maxLag - 1, Math.ceil(c0 * 1.05));
      let j = lo; for (let i = lo; i <= hi; i++) if (ac[i] > ac[j]) j = i;
      const den = ac[j - 1] - 2 * ac[j] + ac[j + 1], d = den < 0 ? 0.5 * (ac[j - 1] - ac[j + 1]) / den : 0;
      ests.push((j + d) / fps / k);
    }
    const period = ests.length ? median(ests) : best.period;
    const bpm = 60 / period;
    return { period, bpm, speed: bpmToSpeed(bpm), score: best.score };
  }
  const W_PRE = 6, W_POST = 3, W_AVG = 40;   // frames των 5 ms: ±30/15 ms max, ~200 ms μέσος όρος

  const lerp = (a, b, t) => a + (b - a) * t;
  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** v (m/s) ↔ βήματα ανά λεπτό. Ίδια σχέση με το Footstep Tapper. */
  function bpmToSpeed(bpm) { return bpm / (60 + 0.075 * bpm); }
  function speedToBpm(v) { return 60 * v / (1 - 0.075 * v); }

  // Όρια φυσικής: πιο γρήγορο ghost 3.71 m/s → ~308 bpm (βήμα / 195 ms), πιο αργό 0.4 → ~25 bpm.
  // Τα όρια κλιμακώνονται με το «Ghost speed» του custom difficulty (50–150%): στο 150% το πιο
  // γρήγορο ghost πατάει κάθε ~105 ms, στο 50% το πιο αργό κάθε ~5 s. Βλ. setGhostSpeed().
  const BASE_MIN_STEP_S = 0.17, BASE_MAX_STEP_S = 2.7, BASE_RESET_GAP_S = 3.2;
  let MIN_STEP_S = BASE_MIN_STEP_S, MAX_STEP_S = BASE_MAX_STEP_S, RESET_GAP_S = BASE_RESET_GAP_S;
  let GHOST_SPEED = 1;
  /** Πολλαπλασιαστής ταχύτητας ghost (custom difficulty). Οι ταχύτητες του analyzeHunt βγαίνουν
   *  πλέον στη «βασική» κλίμακα (÷ mult), ώστε να συγκρίνονται με τους πίνακες των ghosts. */
  function setGhostSpeed(m) {
    GHOST_SPEED = Number.isFinite(m) && m > 0 ? Math.min(2, Math.max(0.25, m)) : 1;
    // Το βήμα δεν κλιμακώνεται γραμμικά (βήμα = 1/v − 0.075 s), οπότε τα όρια βγαίνουν από τις
    // ακραίες ταχύτητες (3.71 και 0.4 m/s) με το ίδιο περιθώριο που έχουν τα βασικά (×0.87, ×1.11).
    const period = v => 1 / v - 0.075;
    MIN_STEP_S = GHOST_SPEED > 1 ? Math.min(BASE_MIN_STEP_S, 0.87 * period(3.71 * GHOST_SPEED)) : BASE_MIN_STEP_S;
    MAX_STEP_S = GHOST_SPEED < 1 ? Math.max(BASE_MAX_STEP_S, 1.11 * period(0.4 * GHOST_SPEED)) : BASE_MAX_STEP_S;
    RESET_GAP_S = BASE_RESET_GAP_S * MAX_STEP_S / BASE_MAX_STEP_S;
    return GHOST_SPEED;
  }
  const getGhostSpeed = () => GHOST_SPEED;
  // Ένα βήμα είναι σύντομο: η ενέργεια πρέπει να πέσει DECAY_DB κάτω από το peak μέσα σε CONFIRM_S.
  const DECAY_DB = 8, CONFIRM_S = 0.16;
  // Πόσο σίγουρος/μακρύς πρέπει να είναι ο ρυθμός για να θεωρηθεί «βήματα».
  // Ένα βήμα είναι «ρυθμικό» μόνο αν τα δύο τελευταία παράθυρα των 6 βημάτων έχουν από μόνα τους
  // καθαρό ρυθμό (σιγουριά ≥ LOCAL_CONF) και συμφωνούν μεταξύ τους (±8%). Τυχαίοι ήχοι το περνούν
  // σπάνια (~1%), ενώ τα βήματα ενός ghost σχεδόν πάντα.
  const LOCAL_WIN = 6, LOCAL_CONF = 0.6, LOCAL_AGREE = 0.08;
  const SLOW_PERIOD_S = 1.2, SLOW_CONF = 0.8;
  // «Δικά σου βήματα»: ο παίκτης περπατάει με 1.6 m/s και τρέχει με 3.0 m/s για ≤3 s (Phasmophobia
  // Wiki, Player). Σε πραγματικό ήχο (Ridgeview, βροχή) τα βήματα του παίκτη μετρήθηκαν 1.57–1.60 m/s
  // και του Gallu (normal, 1.7) 1.65–1.72, ενώ η ένταση άλλαζε ±2–6 dB και στα δύο, οπότε η
  // διάκριση γίνεται με την ταχύτητα. Προσοχή: Twins (1.53), Moroi, Hantu μπορεί να πέσουν κοντά.
  const PLAYER_WALK_LO = 1.54, PLAYER_WALK_HI = 1.615;
  const PLAYER_SPRINT_LO = 2.88, PLAYER_SPRINT_HI = 3.12, PLAYER_SPRINT_MAX_S = 3.5;
  const isPlayerWalk = v => v >= PLAYER_WALK_LO && v <= PLAYER_WALK_HI;
  const isPlayerSprintSpeed = v => v >= PLAYER_SPRINT_LO && v <= PLAYER_SPRINT_HI;

  /** Διασπορά έντασης μιας σειράς βημάτων (dB πάνω από τον θόρυβο). */
  function loudness(strengths) {
    const a = strengths.filter(x => Number.isFinite(x));
    if (a.length < 2) return null;
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    const std = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    const sorted = a.slice().sort((x, y) => x - y);
    const range = sorted[Math.floor(a.length * 0.9 - 1e-9)] - sorted[Math.floor(a.length * 0.1)]; // 10–90%: αγνοεί 1 κακό βήμα
    return { mean: m, std, range, n: a.length };
  }

  class FootstepDetector {
    /**
     * @param {object} o
     * @param {number} o.sampleRate
     * @param {number} [o.sensitivity=0.5]  0 = μόνο δυνατά βήματα, 1 = πιάνει και σιγανά (περισσότερα false positives)
     * @param {(e:{t:number,strength:number,tempo:object|null,rhythmic:boolean,selfLike:boolean,maybeSprint:boolean})=>void} [o.onStep]
     *        t σε δευτερόλεπτα ροής· strength = peak σε dB πάνω από τον θόρυβο
     * @param {(e:{bpm:number,speed:number,steps:number,confidence:number,rhythmic:boolean,selfLike:boolean,maybeSprint:boolean}|null)=>void} [o.onTempo]
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
      this.strengths = [];          // ένταση κάθε βήματος (peak dB πάνω από τον θόρυβο)
      this._bass = [];              // μερίδιο < 100 Hz κάθε βήματος (για τον χτύπο καρδιάς)
      this._prevLocal = null;       // ρυθμός του προηγούμενου παραθύρου 6 βημάτων
      this._run = 0;                // πόσα διαδοχικά ρυθμικά βήματα
      this._lastTempo = null;
      // "flux" (προεπιλογή): spectral flux, αγνοεί σταθερό θόρυβο. "energy": το αρχικό band-energy.
      this.method = o.method || "flux";
      if (this.method === "flux") {
        this._flux = new FluxOnsets({ fs: this.fs, onOnset: (t, st, b) => { this._checkGap(t); this._addStep(t, st, b); },
          onLevel: l => { if (this.onLevel) this.onLevel(l); this._checkGap(this._flux.frame / this._flux.fps); },
          onLow: v => this._acPush(v) });
        const fps = this._flux.fps;
        this._ac = new Float32Array(Math.round(AC_WIN_S * fps)); this._acN = 0; this._acPos = 0;
        this._acEvery = Math.round(AC_EVERY_S * fps); this._lastRhythmicT = -1e9;
        this._flux.setSensitivity(this.sensitivity);
      }
    }

    // Rhythm path: τρέχει μόνο όταν τα μεμονωμένα βήματα δεν δίνουν ρυθμό (χαλί, ανάσα από πάνω).
    _acPush(v) {
      const buf = this._ac; buf[this._acPos] = v; this._acPos = (this._acPos + 1) % buf.length;
      if (this._acN < buf.length) this._acN++;
      const fps = this._flux.fps, t = this._flux.frame / fps;
      if (this._flux.frame % this._acEvery || this._acN < AC_MIN_S * fps || t - this._lastRhythmicT < AC_IDLE_S || !this.onTempo) return;
      const n = this._acN, env = new Float32Array(n);
      for (let i = 0; i < n; i++) env[i] = buf[(this._acPos - n + i + buf.length) % buf.length];
      const r = combTempo(env, fps);
      if (!r || r.score < AC_MIN_SCORE || !isPlayerWalk(r.speed)) return;
      this.onTempo({ bpm: r.bpm, speed: r.speed, steps: 0, confidence: Math.min(1, r.score / 0.25), rhythmic: true,
        selfLike: isPlayerWalk(r.speed), maybeSprint: isPlayerSprintSpeed(r.speed), source: "ac" });
    }

    _checkGap(t) { if (this.steps.length && t - this.steps[this.steps.length - 1] > RESET_GAP_S) this.reset(); }

    setSensitivity(s) {
      this.sensitivity = Math.max(0, Math.min(1, s));
      if (this._flux) this._flux.setSensitivity(this.sensitivity);
      this._overFloor = lerp(16, 7, this.sensitivity); // dB πάνω από τον θόρυβο βάθους
      this._rise = lerp(9, 4, this.sensitivity);       // dB άνοδος μέσα σε ~30 ms
      this._gate = lerp(-50, -66, this.sensitivity);   // απόλυτο κατώφλι dBFS
    }

    reset() { this.steps = []; this.strengths = []; this._bass = []; this._prevLocal = null; this._run = 0; this._lastTempo = null; if (this.onTempo) this.onTempo(null); }

    /** @param {Float32Array|number[]} samples mono, -1..1 */
    process(samples) {
      if (this._flux) { this._flux.process(samples); return; }
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
        if ((f - p.f) / this._fps < 0.04) { p.e += energy; p.n++; } // ένταση = μέση ενέργεια των πρώτων 40 ms (σταθερότερη από ένα frame)
        if (db <= p.peak - DECAY_DB) { this._pending = null; this._addStep(p.t, 10 * Math.log10(p.e / p.n + 1e-12) - p.floor); }
        else if ((f - p.f) / this._fps > CONFIRM_S) this._pending = null;
      }

      const refractory = (f - this._lastOnsetFrame) / this._fps >= MIN_STEP_S;
      if (!this._pending && loud && rise >= this._rise && this._armed && refractory) {
        this._lastOnsetFrame = f; this._armed = false; this._peakSince = db;
        this._pending = { t, f, peak: db, floor: this._floor, e: energy, n: 1 };
      }

      // Λήξη σειράς αν σταμάτησαν τα βήματα.
      if (this.steps.length && t - this.steps[this.steps.length - 1] > RESET_GAP_S) this.reset();
    }

    _addStep(t, strength, bass) {
      if (this.steps.length && t - this.steps[this.steps.length - 1] > RESET_GAP_S) { this.steps = []; this.strengths = []; this._bass = []; this._prevLocal = null; this._run = 0; }
      this.steps.push(t); this.strengths.push(strength); this._bass.push(bass ?? 0);
      if (this.steps.length > 16) { this.steps.shift(); this.strengths.shift(); this._bass.shift(); }

      // rhythmic: το βήμα ανήκει σε σταθερό ρυθμό. Πόρτες, φωνές, αντικείμενα δεν σχηματίζουν ρυθμό.
      const local = this.steps.length >= LOCAL_WIN ? estimateTempo(this.steps.slice(-LOCAL_WIN)) : null;
      const prev = this._prevLocal;
      // Πολύ αργά βήματα (Deogen κοντά σου, 1 βήμα / 1.2–2.4 s): δεν προλαβαίνουν δύο παράθυρα,
      // οπότε αρκεί ένα με πολύ καθαρό ρυθμό.
      const slow = !!local && 60 / local.bpm >= SLOW_PERIOD_S && local.confidence >= SLOW_CONF;
      // Χτύπος καρδιάς του παίκτη (ghost κοντά σε hunt): σταθερά ~98 bpm, σχεδόν όλος κάτω από 100 Hz.
      // Και τα δύο μαζί → δεν είναι βήματα. Ghost με πραγματικά βήματα στα ~1.46 m/s (Hantu) έχει κανονικό φάσμα.
      const heartbeat = !!local && 60 / local.bpm >= HEART_LO_S && 60 / local.bpm <= HEART_HI_S &&
                        median(this._bass.slice(-LOCAL_WIN)) >= HEART_BASS;
      const rhythmic = !heartbeat && (slow || (!!local && local.confidence >= LOCAL_CONF && !!prev && prev.confidence >= LOCAL_CONF &&
                       Math.abs(local.speed - prev.speed) <= LOCAL_AGREE * local.speed));
      this._prevLocal = local;
      this._run = rhythmic ? this._run + 1 : 0;
      if (rhythmic) this._lastRhythmicT = t;

      // Ένδειξη: ο ρυθμός όλης της σειράς αν συμφωνεί με τον τοπικό (πιο σταθερός), αλλιώς ο τοπικός
      // (π.χ. μόλις άλλαξε ταχύτητα, Revenant 1.0 → 3.0).
      const global = estimateTempo(this.steps);
      let tempo = rhythmic ? ((global && Math.abs(global.speed - local.speed) <= 0.1 * local.speed) ? global : local) : (global || local);
      // Δικά σου βήματα: ρυθμός στην ταχύτητα περπατήματος του παίκτη (1.6 m/s).
      const selfLike = rhythmic && !!tempo && isPlayerWalk(tempo.speed);
      // 3.0 m/s: είτε Revenant που σε βλέπει είτε εσύ που τρέχεις (sprint ≤3 s) — μόνο ετικέτα.
      const maybeSprint = rhythmic && !!tempo && isPlayerSprintSpeed(tempo.speed);
      if (tempo) { tempo = Object.assign({}, tempo, { rhythmic, selfLike, maybeSprint, steps: this.steps.length }); }
      this._lastTempo = tempo;
      // run === 1: μόλις αναγνωρίστηκε ρυθμός → τα προηγούμενα βήματα του παραθύρου ανήκουν κι αυτά σε αυτόν.
      const backfill = rhythmic && this._run === 1
        ? this.steps.slice(-(LOCAL_WIN + 1), -1).map((x, i, a) => [x, this.strengths[this.strengths.length - 1 - a.length + i]])
        : null;
      if (this.onStep) this.onStep({ t, strength, tempo, rhythmic, selfLike, maybeSprint, backfill });
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

  // ───────────────────────── Ανάλυση hunt ─────────────────────────
  const WIN = 6;           // βήματα ανά σημείο καμπύλης (5 διαστήματα ≈ 1.5–5 s ανάλογα την ταχύτητα)
  const MIN_CONF = 0.4;    // σημεία με χαμηλότερη σιγουριά δεν μπαίνουν στην καμπύλη
  const MIN_CURVE = 5;     // λιγότερα σημεία = όχι hunt (λίγα τυχαία χτυπήματα)
  const MIN_COVERAGE = 0.6;
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const mad = (a, m) => a.reduce((s, x) => s + Math.abs(x - m), 0);

  /**
   * Καμπύλη ταχύτητας και στατιστικά ενός hunt.
   * @param {number[]} times  χρόνοι βημάτων σε δευτερόλεπτα από την αρχή του hunt (αύξουσα σειρά·
   *                          κενά > MAX_STEP_S = το ghost δεν ακουγόταν, χωρίζουν τμήματα)
   * @param {number[]} [strengths]  ένταση κάθε βήματος (dB πάνω από τον θόρυβο), ίδιο μήκος με times
   * @returns {null|{
   *   curve:[number,number][], duration:number, steps:number, segments:number,
   *   start:number, end:number, mean:number, min:number, max:number,
   *   trend:"constant"|"accelerating"|"slowing"|"switch"|"variable", from?:number, to?:number, switchAt?:number,
   *   steady:number  // δευτερόλεπτα που η ταχύτητα έμεινε σταθερή (για «χωρίς LoS accel»)
   * }}
   */
  function analyzeHunt(times, strengths) {
    if (!times || times.length < WIN) return null;
    // Τμήματα συνεχόμενων βημάτων
    const segs = [[times[0]]];
    for (let i = 1; i < times.length; i++) {
      if (times[i] - times[i - 1] > MAX_STEP_S) segs.push([]);
      segs[segs.length - 1].push(times[i]);
    }
    const curve = [], wins = []; // wins: [τέλος παραθύρου, αρχή παραθύρου, πέρασε;]
    for (const s of segs) {
      for (let i = WIN - 1; i < s.length; i++) {
        const r = estimateTempo(s.slice(i - WIN + 1, i + 1));
        const ok = !!r && r.confidence >= MIN_CONF;
        wins.push([s[i], s[i - WIN + 1], ok]);
        if (ok) curve.push([s[i], r.speed]);
      }
    }
    if (curve.length < MIN_CURVE) return null;
    // Ρυθμικό τμήμα = από την αρχή του πρώτου καλού παραθύρου ως το τέλος του τελευταίου.
    // Θόρυβος πριν/μετά κόβεται· αν μέσα στο τμήμα τα περισσότερα παράθυρα ΔΕΝ έχουν ρυθμό,
    // δεν είναι βήματα (τυχαίοι ήχοι που κατά σύμπτωση έπεσαν σε ρυθμό για λίγο).
    const firstT0 = curve[0][0], lastT0 = curve[curve.length - 1][0];
    const inSpan = wins.filter(w => w[0] >= firstT0 && w[0] <= lastT0);
    const coverage = inSpan.filter(w => w[2]).length / inSpan.length;
    if (coverage < MIN_COVERAGE) return null;

    // Κόψιμο άκρων: ένα παράθυρο 6 βημάτων «περνάει» ακόμα κι αν 1–2 από αυτά είναι θόρυβος,
    // οπότε το τμήμα απλώνεται πάνω σε ήχους πριν/μετά το hunt. Στις άκρες κρατάμε ένα βήμα μόνο
    // αν το διάστημά του είναι συνεπές με τα δύο επόμενα (ίδιο ±20%, ή διπλό/μισό = χαμένο βήμα).
    // Συγκρίνει διαστήματα μεταξύ τους, άρα αντέχει και σταδιακή επιτάχυνση/επιβράδυνση.
    const cons = (a, b) => { const r = a / b; return (r > 0.8 && r < 1.25) || (r > 1.65 && r < 2.4) || (r > 0.42 && r < 0.6); };
    const ok3 = (d0, d1, d2) => cons(d0, d1) && cons(d1, d2);
    let span = times.filter(t => t >= wins.find(w => w[2])[1] - 1e-9 && t <= lastT0 + 1e-9);
    while (span.length > WIN && !ok3(span[1] - span[0], span[2] - span[1], span[3] - span[2])) span.shift();
    const L = () => span.length - 1;
    while (span.length > WIN && !ok3(span[L()] - span[L() - 1], span[L() - 1] - span[L() - 2], span[L() - 2] - span[L() - 3])) span.pop();
    const spanStart = span[0], lastT = span[span.length - 1];
    const trimmed = curve.filter(p => p[0] >= spanStart + 1e-9 && p[0] <= lastT + 1e-9);
    if (trimmed.length >= MIN_CURVE) { curve.length = 0; curve.push(...trimmed); }

    // Median filter 5 σημείων (στις άκρες το παράθυρο μετατοπίζεται μέσα, ώστε να έχει πάντα 5):
    // έως 2 διαδοχικά λάθος παράθυρα (π.χ. διπλή περίοδος από χαμένα βήματα → μισή ταχύτητα) δεν
    // γίνονται «min» ή «αρχική ταχύτητα». Πραγματικές αλλαγές (Revenant 1→3) διατηρούνται,
    // γιατί ο median κρατάει τα σκαλοπάτια.
    const raw = curve.map(p => p[1]), F = Math.min(5, raw.length);
    for (let i = 0; i < curve.length; i++) {
      const a = Math.max(0, Math.min(raw.length - F, i - (F >> 1)));
      curve[i][1] = median(raw.slice(a, a + F));
    }
    const v = curve.map(p => p[1]);
    const head = v.slice(0, Math.min(3, v.length)), tail = v.slice(-Math.min(3, v.length));
    const out = {
      curve, coverage, segments: segs.filter(s => s.length >= 2).length,
      steps: span.length,
      loudness: null, selfLike: false, playerSprint: false,
      duration: lastT - spanStart, spanStart, spanEnd: lastT,
      start: median(head), end: median(tail), mean: mean(v),
      min: Math.min(...v), max: Math.max(...v),
    };

    // Μοντέλα: σταθερό / γραμμικό (επιτάχυνση-επιβράδυνση) / σκαλοπάτι (απότομη αλλαγή).
    const n = v.length, med = median(v);
    const constErr = mad(v, med) / n;
    const t = curve.map(p => p[0]), tm = mean(t), vm = mean(v);
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (t[i] - tm) ** 2; sxy += (t[i] - tm) * (v[i] - vm); }
    const slope = sxx > 0 ? sxy / sxx : 0;
    let linErr = 0;
    for (let i = 0; i < n; i++) linErr += Math.abs(v[i] - (vm + slope * (t[i] - tm)));
    linErr /= n;
    let step = null;
    for (let k = 2; k <= n - 2; k++) {
      const L = v.slice(0, k), R = v.slice(k), mL = median(L), mR = median(R);
      const e = (mad(L, mL) + mad(R, mR)) / n;
      if (!step || e < step.e) step = { e, k, mL, mR };
    }

    if (constErr < 0.06 * med || (out.max - out.min) < 0.15) out.trend = "constant";
    else if (step && step.e < 0.6 * linErr && Math.abs(step.mR - step.mL) > 0.35) {
      out.trend = "switch"; out.from = step.mL; out.to = step.mR; out.switchAt = t[step.k];
    } else if (out.end - out.start > 0.25 && slope > 0) out.trend = "accelerating";
    else if (out.start - out.end > 0.25 && slope < 0) out.trend = "slowing";
    else out.trend = "variable";

    // Η μεγαλύτερη συνεχόμενη διάρκεια με ταχύτητα εντός ±7% (χωρίς επιτάχυνση).
    let steady = 0;
    for (let i = 0; i < n; i++) {
      let j = i;
      while (j + 1 < n && Math.abs(v[j + 1] - v[i]) <= 0.07 * v[i] && t[j + 1] - t[j] <= MAX_STEP_S * 2) j++;
      steady = Math.max(steady, t[j] - t[i]);
    }
    out.steady = steady;
    if (strengths && strengths.length === times.length) {
      const inSpanStr = strengths.filter((_, i) => times[i] >= spanStart - 1e-9 && times[i] <= lastT + 1e-9);
      out.loudness = loudness(inSpanStr);
    }
    // Δικά σου βήματα: όλη η σειρά σταθερά στην ταχύτητα περπατήματος του παίκτη.
    out.selfLike = out.trend === "constant" && isPlayerWalk(median(v));
    // Εσύ που τρέχεις: σύντομη σειρά (≤3.5 s) στα ~3.0 m/s.
    out.playerSprint = out.duration <= PLAYER_SPRINT_MAX_S && isPlayerSprintSpeed(median(v));
    // Ο παίκτης δεν επηρεάζεται από το ghost speed, άρα selfLike/playerSprint μένουν στην πραγματική
    // ταχύτητα· όλα τα υπόλοιπα γυρίζουν στη βασική κλίμακα των ghosts.
    if (GHOST_SPEED !== 1) {
      const k = 1 / GHOST_SPEED;
      out.curve = out.curve.map(([tt, vv]) => [tt, vv * k]);
      for (const f of ["start", "end", "mean", "min", "max", "from", "to"]) if (typeof out[f] === "number") out[f] *= k;
      out.ghostSpeed = GHOST_SPEED;
    }
    return out;
  }

  /**
   * Μοτίβα από hunt σε hunt, με βάση την αρχική ταχύτητα κάθε hunt (πριν τυχόν επιτάχυνση LoS).
   * @param {number[]} starts  αρχικές ταχύτητες, με χρονολογική σειρά
   * @returns {{kind:"twins"|"decreasing"|"increasing"|"stable", detail?:string}|null}
   */
  function analyzeGame(starts) {
    if (!starts || starts.length < 2) return null;
    const near = (x, c) => Math.abs(x - c) <= 0.08;
    const lo = starts.filter(s => near(s, 1.53)).length, hi = starts.filter(s => near(s, 1.87)).length;
    if (lo >= 1 && hi >= 1 && lo + hi === starts.length) return { kind: "twins" };
    if (starts.length >= 3) {
      let dec = true, inc = true;
      for (let i = 1; i < starts.length; i++) {
        if (starts[i] > starts[i - 1] + 0.05) dec = false;
        if (starts[i] < starts[i - 1] - 0.05) inc = false;
      }
      const span = starts[starts.length - 1] - starts[0];
      if (dec && span <= -0.3) return { kind: "decreasing" };
      if (inc && span >= 0.3) return { kind: "increasing" };
    }
    if (Math.max(...starts) - Math.min(...starts) < 0.12) return { kind: "stable" };
    return null;
  }

  const api = { FootstepDetector, estimateTempo, combTempo, bpmToSpeed, speedToBpm, analyzeHunt, analyzeGame, loudness, isPlayerWalk, isPlayerSprintSpeed, setGhostSpeed, getGhostSpeed };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PhasmFootsteps = api;
})(typeof self !== "undefined" ? self : this);
