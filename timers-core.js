// Κοινός πυρήνας των timers του Phasmo Journal: timers.html (Steam overlay) και pop-out του index.html.
// Ένα μόνο global (PhasmoTimers), ώστε να μη συγκρούεται με ονόματα των σελίδων που τον φορτώνουν.
// Θέλει το DIFFICULTIES του ghosts-data.js μόνο όταν καλείται το huntsFor().
window.PhasmoTimers = (() => {
  const KEYS = {
    contract: "phasmo-journal-contract",   // {t0, beep} — κοινό contract για όλες τις σελίδες
    show: "phasmo-timers-show",            // ποια κουτιά φαίνονται + minimal
    beepClaim: "phasmo-timers-beep-claim", // ποια σελίδα χτύπησε ήδη μια προειδοποίηση
    journal: "phasmo-journal-v1"           // state του index.html (για το Custom difficulty)
  };
  const fmt = s => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");

  // ---------- audio ----------
  // Οι browsers κρατάνε το AudioContext «suspended» μέχρι το πρώτο user gesture. Μετά από reload με
  // timers που τρέχουν (π.χ. το Steam ξανανοίγει τα tabs στην αρχή του game) δεν θα ακουγόταν
  // τίποτα. Γι' αυτό: δημιουργία από την αρχή, resume σε ΚΑΘΕ gesture, και audioReady() ώστε οι
  // σελίδες να δείχνουν ένδειξη 🔇 όσο ο ήχος είναι κλειδωμένος.
  let ctx = null;
  const audioSubs = new Set();
  function ensureAudio(){
    try{
      if(!ctx){
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        ctx.onstatechange = () => audioSubs.forEach(f => f());
      }
      if(ctx.state === "suspended") ctx.resume().catch(() => {});
    }catch(e){/* χωρίς audio — οι timers δουλεύουν κανονικά */}
  }
  const audioReady = () => !!ctx && ctx.state === "running";
  // Όσο είναι suspended δεν προγραμματίζουμε ήχο: το currentTime είναι παγωμένο και το beep θα
  // έπαιζε με καθυστέρηση τη στιγμή του resume, άσχετα με το πότε έληξε ο timer.
  function beep(freq, times){
    if(!audioReady()) return false;
    try{
      for(let i = 0; i < times; i++){
        const t = ctx.currentTime + i * 0.5, o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.15, t); o.start(t); o.stop(t + 0.35);
      }
      return true;
    }catch(e){ return false; }
  }
  // capture: τρέχει πριν από handlers που κάνουν stopPropagation (π.χ. το reveal του minimal)
  function unlockOn(target){ ["pointerdown", "keydown"].forEach(ev => target.addEventListener(ev, ensureAudio, true)); }
  const onAudioChange = f => { audioSubs.add(f); return () => audioSubs.delete(f); };
  ensureAudio();
  unlockOn(window);

  // Αν η ίδια προειδοποίηση φτάνει σε δύο σελίδες του ίδιου browser (pop-out + timers.html), χτυπάει
  // μόνο η πρώτη που έχει ενεργό ήχο. Το claim γράφεται ΜΟΝΟ όταν όντως παίζει ήχος, ώστε μια
  // βουβή σελίδα να μην «κλέψει» το beep από μια που ακούγεται.
  // (καλεί api.audioReady/api.beep ώστε ένα test να μπορεί να τα αντικαταστήσει)
  function beepOnce(id, freq, times){
    if(!api.audioReady()) return false;
    try{
      if(localStorage.getItem(KEYS.beepClaim) === id) return false;
      localStorage.setItem(KEYS.beepClaim, id);
    }catch(e){/* χωρίς storage: απλώς χτύπα */}
    return api.beep(freq, times);
  }

  // ---------- countdown ----------
  // Deadline-based: το υπόλοιπο βγαίνει από το Date.now() και όχι από μέτρημα ticks, γιατί τα
  // background tabs στραγγαλίζουν τα intervals. Το tick() είναι idempotent — το καλεί το κοινό
  // loop και, όσο είναι ανοιχτό, το (μη στραγγαλισμένο) interval του pop-out.
  //   idle:   δευτερόλεπτα που δείχνει όταν δεν τρέχει
  //   store:  προαιρετικό {get()→{dl,tot}|null, set({dl,tot})} για να επιβιώνει σε reload
  //   onRun:  προαιρετικό (running) => … — π.χ. wake lock
  const tickers = new Set();
  function countdown({idle, onDone, store, onRun}){
    const views = [];
    let dl = 0, tot = idle, running = false;
    const s0 = store && store.get();
    if(s0 && typeof s0.dl === "number" && s0.dl > 0 && typeof s0.tot === "number" && s0.tot > 0){ dl = s0.dl; tot = s0.tot; }
    let fired = !dl || dl <= Date.now();   // μην ξαναχτυπήσεις timer που έληξε πριν το reload
    const remaining = () => Math.max(0, Math.ceil((dl - Date.now()) / 1000));
    const setRun = r => { if(r !== running){ running = r; if(onRun) onRun(r); } };
    const persist = () => { if(store) store.set({dl, tot}); };
    // γράφει στο DOM μόνο όταν αλλάξει κάτι — το loop τρέχει 4 φορές/δευτερόλεπτο
    function paint(v){
      const rem = dl ? remaining() : idle;
      const key = dl ? rem + "/" + tot : "idle";
      if(v.last === key) return;
      v.last = key;
      v.display.textContent = fmt(rem);
      v.display.classList.toggle("done", !!dl && rem <= 0);
      v.bar.style.width = dl ? (rem / tot * 100) + "%" : "100%";
    }
    const api = {
      start(secs){ ensureAudio(); dl = Date.now() + secs * 1000; tot = secs; fired = false; persist(); setRun(true); api.tick(); },
      reset(){ dl = 0; tot = idle; fired = true; persist(); setRun(false); api.tick(); },
      // ξαναζωγράφισε όλα τα views από την αρχή (π.χ. αν κάποιος άλλος άγγιξε το DOM τους)
      repaint(){ views.forEach(v => { v.last = null; paint(v); }); },
      tick(){
        views.forEach(paint);
        if(dl && !fired && remaining() <= 0){ fired = true; setRun(false); onDone(); }
      },
      isActive: () => !!dl && !fired,
      addView(display, bar){
        const v = {display, bar}; views.push(v); paint(v);
        return () => { const k = views.indexOf(v); if(k >= 0) views.splice(k, 1); };
      }
    };
    if(!fired) setRun(true);
    tickers.add(api);
    return api;
  }

  // ---------- Obambo ----------
  // Ξεκινά Calm, 1η αλλαγή +1:00 από το πρώτο άνοιγμα της εξώπορτας, μετά εναλλαγή κάθε 2:00.
  // Πρόβλεψη από το ρολόι — αν το παιχνίδι αλλάξει τους χρόνους, άλλαξε αυτές τις σταθερές.
  const OBAMBO = {first: 60, every: 120, warn: 5};
  function obamboAt(t){
    if(t < OBAMBO.first) return {aggr: false, next: OBAMBO.first - t, idx: 0};
    const k = Math.floor((t - OBAMBO.first) / OBAMBO.every);
    return {aggr: k % 2 === 0, next: OBAMBO.first + OBAMBO.every * (k + 1) - t, idx: k + 1};
  }

  // ---------- contract (κοινό ανάμεσα στις σελίδες μέσω localStorage) ----------
  const contract = {
    t0: 0, beepOn: true, lastWarn: -1, views: [],
    // idempotent: στο φόρτωμα και σε κάθε αλλαγή του key από άλλη σελίδα
    load(){
      const prev = this.t0;
      try{
        const d = JSON.parse(localStorage.getItem(KEYS.contract) || "null");
        this.t0 = (d && typeof d.t0 === "number" && d.t0 > 0 && Date.now() - d.t0 < 6 * 3600e3) ? d.t0 : 0;
        this.beepOn = !(d && d.beep === 0);
      }catch(e){/* ignore */}
      if(this.t0 !== prev) this._syncWarn();
    },
    // Νέο/άλλο contract (reload ή start από άλλη σελίδα): μη χάσεις την επόμενη προειδοποίηση,
    // αλλά ούτε ξαναχτυπήσεις μία που είναι ήδη σε εξέλιξη.
    _syncWarn(){
      if(!this.t0){ this.lastWarn = -1; return; }
      const ob = obamboAt(this.elapsed());
      this.lastWarn = ob.next <= OBAMBO.warn ? ob.idx : -1;
    },
    save(){ try{ localStorage.setItem(KEYS.contract, JSON.stringify({t0: this.t0, beep: this.beepOn ? 1 : 0})); }catch(e){/* ignore */} },
    elapsed(){ return this.t0 ? Math.floor((Date.now() - this.t0) / 1000) : 0; },
    start(){ ensureAudio(); this.t0 = Date.now(); this.lastWarn = -1; this.save(); this.tick(); },
    reset(){ this.t0 = 0; this.lastWarn = -1; this.save(); this.tick(); },
    setBeep(on){ this.beepOn = on; this.save(); this.tick(); },
    isActive(){ return !!this.t0; },
    tick(){
      const t = this.elapsed(), ob = obamboAt(t);
      if(this.t0 && this.beepOn && ob.next <= OBAMBO.warn && this.lastWarn !== ob.idx){
        this.lastWarn = ob.idx;
        beepOnce("ob:" + this.t0 + ":" + ob.idx, 520, 3);
      }
      // τα views ξαναζωγραφίζονται μόνο όταν αλλάξει δευτερόλεπτο/contract/Obambo
      const key = this.t0 + "|" + t + "|" + this.beepOn;
      if(key === this._last) return;
      this._last = key;
      this.views.forEach(v => v(t, ob));
    },
    // ξαναζωγράφισε τα views ακόμα κι αν δεν άλλαξε τίποτα εδώ (π.χ. άλλαξε η γλώσσα της σελίδας)
    repaint(){ this._last = null; this.tick(); },
    addView(f){
      this.views.push(f); f(this.elapsed(), obamboAt(this.elapsed()));
      return () => { const k = this.views.indexOf(f); if(k >= 0) this.views.splice(k, 1); };
    }
  };
  contract.load();
  tickers.add(contract);

  // ---------- show/hide + minimal (κοινά ανάμεσα στις σελίδες) ----------
  // Το "ob" (Obambo: γραμμή + beeps) ζει μέσα στο contract (beepOn), όχι εδώ.
  const SHOW_DEF = {sm: true, hu: true, ct: true, tl: true, min: false};
  const prefs = {
    show: {...SHOW_DEF}, subs: new Set(),
    load(){
      this.show = {...SHOW_DEF};
      try{
        const d = JSON.parse(localStorage.getItem(KEYS.show) || "null");
        if(d && typeof d === "object") for(const k in SHOW_DEF) if(typeof d[k] === "boolean") this.show[k] = d[k];
      }catch(e){/* ignore */}
    },
    isOn(k){ return k === "ob" ? contract.beepOn : !!this.show[k]; },
    toggle(k){
      if(k === "ob") contract.setBeep(!contract.beepOn);
      else if(k in SHOW_DEF){ this.show[k] = !this.show[k]; try{ localStorage.setItem(KEYS.show, JSON.stringify(this.show)); }catch(e){/* ignore */} }
      this.emit();
    },
    onChange(f){ this.subs.add(f); return () => this.subs.delete(f); },
    emit(){ this.subs.forEach(f => f()); }
  };
  prefs.load();

  // Chips [data-v] → toggles. Επιστρέφει paint() για να ξαναζωγραφίζονται όταν αλλάξει κάτι.
  function bindVisChips(container){
    const btns = [...container.querySelectorAll("[data-v]")];
    btns.forEach(b => b.onclick = () => prefs.toggle(b.dataset.v));
    return () => btns.forEach(b => b.classList.toggle("off", !prefs.isOn(b.dataset.v)));
  }

  // Minimal: τα controls κρύβονται. Πρώτο κλικ οπουδήποτε τα δείχνει χωρίς να «πατήσει» τίποτα,
  // κλικ σε timer κουμπί (.btn) τα ξανακρύβει αμέσως, αλλιώς κρύβονται μόνα τους σε 5s.
  // doc/win: το document και το window της σελίδας (για το pop-out είναι του PiP window).
  function minimalReveal(doc, win){
    const body = doc.body;
    let t = null;
    const isMin = () => !!prefs.show.min;
    const hide = () => { body.classList.remove("reveal"); win.clearTimeout(t); t = null; };
    const show = () => { body.classList.add("reveal"); win.clearTimeout(t); t = win.setTimeout(hide, 5000); };
    doc.addEventListener("click", e => {
      if(!isMin() || e.target.closest("[data-passthru]")) return;   // π.χ. headers των tells
      if(!body.classList.contains("reveal")){ e.preventDefault(); e.stopPropagation(); show(); return; }
      if(e.target.closest(".btn")) hide(); else show();
    }, true);
    doc.addEventListener("change", () => { if(isMin() && body.classList.contains("reveal")) show(); });
    return {
      show, hide,
      apply(){ body.classList.toggle("min", isMin()); if(!isMin()) hide(); }
    };
  }

  // 🔇 ένδειξη: φαίνεται όσο ο ήχος είναι κλειδωμένος ΚΑΙ κάτι τρέχει (αλλιώς δεν μας νοιάζει).
  function bindSoundBadge(el){
    const paint = () => el.classList.toggle("hide", api.audioReady() || ![...tickers].some(t => t.isActive()));
    onAudioChange(paint);
    const ticker = {tick: paint, isActive: () => false};
    tickers.add(ticker);
    paint();
    return () => tickers.delete(ticker);
  }

  // ---------- difficulty ----------
  // Base τιμές: DIFFICULTIES (ghosts-data.js). Custom: οι ρυθμίσεις του Journal (index.html) στον
  // ίδιο browser — αν δεν υπάρχουν, οι default του custom.
  function huntsFor(diff){
    if(diff === "custom"){
      try{
        const cc = (JSON.parse(localStorage.getItem(KEYS.journal) || "null") || {}).cc;
        const ok = n => typeof n === "number" && n > 0 && n <= 300;
        if(cc && ok(cc.small) && ok(cc.medium) && ok(cc.large)) return {small: cc.small, medium: cc.medium, large: cc.large};
      }catch(e){/* ignore */}
    }
    return (DIFFICULTIES[diff] || DIFFICULTIES.nightmare).hunts;
  }

  // ---------- κοινό loop + συγχρονισμός ανάμεσα σε σελίδες ----------
  const tickAll = () => tickers.forEach(t => t.tick());
  setInterval(tickAll, 250);
  window.addEventListener("storage", e => {
    if(e.key === KEYS.contract){ contract.load(); contract.tick(); prefs.emit(); }
    else if(e.key === KEYS.show){ prefs.load(); prefs.emit(); }
  });

  const api = {KEYS, fmt, ensureAudio, beep, audioReady, onAudioChange, unlockOn, countdown, OBAMBO, obamboAt,
               contract, prefs, bindVisChips, minimalReveal, bindSoundBadge, huntsFor, tickAll};
  return api;
})();
