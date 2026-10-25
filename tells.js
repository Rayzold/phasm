// Ghost tells panel — κοινό για το timers.html (Steam overlay) και το pop-out του index.html.
// Θέλει τα GHOSTS / TELL_EN / HUNT_EN / HUNT_BEHAVIOR(_EN) / RULEOUTS / EV του ghosts-data.js.
// Ένα μόνο global (PhasmoTells). Η επιλογή (έως 3 suspects) και το Short/Full κρατιούνται στο
// localStorage και μοιράζονται ανάμεσα στις σελίδες του ίδιου browser — ο browser του Steam
// overlay έχει δικό του storage.
window.PhasmoTells = (() => {
  const KEY = "phasmo-timers-suspects", DETAIL_KEY = "phasmo-timers-tells-detail", MAX = 3;

  function loadSuspects(){
    try{
      const a = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(a) ? a.filter(n => GHOSTS.some(g => g.name === n)).slice(0, MAX) : [];
    }catch(e){ return []; }
  }
  const saveSuspects = a => { try{ localStorage.setItem(KEY, JSON.stringify(a)); }catch(e){/* ignore */} };
  const isFull = () => { try{ return localStorage.getItem(DETAIL_KEY) === "full"; }catch(e){ return false; } };
  const setFull = on => { try{ localStorage.setItem(DETAIL_KEY, on ? "full" : "short"); }catch(e){/* ignore */} };

  const CSS = `
  .tl-ctl{display:flex;gap:4px;flex-wrap:wrap;margin:4px 0}
  .tl-ctl button,.tl-pick button{font:inherit;font-size:11.5px;border:1px solid var(--line);background:#0c1118;color:#B9C2CE;border-radius:12px;padding:2px 8px;cursor:pointer}
  .tl-ctl .tl-chip{border-color:var(--nv-dim);color:var(--nv);background:rgba(143,227,136,.08)}
  .tl-ctl .tl-add{border-color:var(--warn);color:var(--warn)}
  .tl-ctl .tl-det{margin-left:auto}
  .tl-ctl .tl-det.on{border-color:var(--nv);color:var(--nv)}
  .tl-pick{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:4px;margin:4px 0 6px;max-height:190px;overflow:auto}
  .tl-pick button{border-radius:6px;padding:3px 4px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tl-pick button:hover:not(:disabled){border-color:var(--nv);color:var(--nv)}
  .tl-pick button:disabled{opacity:.35;cursor:default}
  .tl-empty{font-size:11.5px;color:var(--muted);margin:2px 0 2px}
  .tl-card{border-top:1px solid var(--line);padding:5px 0 3px}
  .tl-ctl + .tl-card, .tl-pick + .tl-card, .tl-empty + .tl-card{border-top:none}
  .tl-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px}
  .tl-h b{font-family:"Special Elite",monospace;font-size:15px;font-weight:400;color:#EAEDF2;letter-spacing:1px}
  .tl-ev{font-size:13px;letter-spacing:2px}
  .tl-hunt{font-size:11px;color:var(--warn);margin-left:auto}
  .tl-t{font-size:12px;line-height:1.4;color:#B9C2CE}
  .tl-sub{font-family:"Special Elite",monospace;font-size:10.5px;letter-spacing:1.5px;text-transform:uppercase;color:var(--nv-dim);margin:6px 0 2px}
  .tl-sub.x{color:var(--danger)} .tl-sub.pos{color:var(--nv)}
  .tl-l{list-style:none;margin:0;padding:0;display:grid;gap:3px}
  .tl-l li{font-size:11.5px;line-height:1.35;color:#9aa4b3}
  .tl-l li b{color:#D7DCE4;font-weight:600}
  /* Full: accordion — ανοιχτό ένα ghost τη φορά, τα άλλα μόνο με το header */
  .tl-card.acc .tl-h{cursor:pointer;user-select:none}
  .tl-card.acc .tl-h b::before{content:"▸ ";color:var(--nv-dim);font-size:12px}
  .tl-card.acc.open .tl-h b::before{content:"▾ "}
  .tl-card.acc:not(.open) .tl-h{margin-bottom:0}
  .tl-card.acc .tl-h:hover b{color:var(--nv)}
  body.min:not(.reveal) .tl-ctl, body.min:not(.reveal) .tl-pick, body.min:not(.reveal) .tl-empty,
  body.min:not(.reveal) .tl-none{display:none}
  `;

  const esc = s => String(s).replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
  const evIc = k => (EV.find(e => e.k === k) || {}).ic || k;
  const evName = k => (EV.find(e => e.k === k) || {}).n || k;

  // Short: evidence + hunt threshold + tell.
  // Full (χωρίς τα 3 evidence, που τα ξέρεις ήδη από το board): hunt threshold, tell, τι κάνει στο
  // hunt, και όλα τα σχετικά entries του RULEOUTS — τι το επιβεβαιώνει, τι το αποκλείει, σημειώσεις.
  // open: στο Full, αν η κάρτα είναι ανοιχτή (accordion) — κλειστή δείχνει μόνο όνομα + hunt threshold.
  function card(n, lang, full, open){
    const g = GHOSTS.find(x => x.name === n);
    const L = (el, en) => lang === "en" ? en : el;
    const tell = lang === "en" ? (TELL_EN[n] || g.tell) : g.tell;
    const hunt = lang === "en" ? (HUNT_EN[n] || g.hunt) : g.hunt;
    // data-passthru: το header αλλάζει ghost και στο minimal χωρίς να εμφανίζει τα κουμπιά
    let h = full
      ? `<div class="tl-card acc${open ? " open" : ""}"><div class="tl-h" data-open="${esc(n)}" data-passthru="1" title="${L("Άνοιγμα / κλείσιμο", "Expand / collapse")}"><b>${esc(n)}</b>`
      : `<div class="tl-card"><div class="tl-h"><b>${esc(n)}</b>`;
    if(!full) h += `<span class="tl-ev" title="${esc(g.ev.map(evName).join(" · "))}">${g.ev.map(evIc).join(" ")}</span>`;
    h += `<span class="tl-hunt">hunt ${esc(hunt)}</span></div>`;
    if(full && !open) return h + `</div>`;
    h += `<div class="tl-t">${esc(tell)}</div>`;
    if(!full) return h + `</div>`;

    const beh = lang === "en" ? (HUNT_BEHAVIOR_EN[n] || HUNT_BEHAVIOR[n]) : HUNT_BEHAVIOR[n];
    if(beh) h += `<div class="tl-sub">🏃 ${L("Στο hunt", "During a hunt")}</div><div class="tl-t">${esc(beh)}</div>`;
    const list = (kind, cls, title) => {
      const rows = RULEOUTS.filter(r => r.kind === kind && r.g.includes(n));
      if(!rows.length) return "";
      const seen = new Set();
      const lis = rows.map(r => r[lang] || r.en).filter(([t, d]) => !seen.has(t + d) && seen.add(t + d))
        .map(([t, d]) => `<li><b>${esc(t)}</b> — ${esc(d)}</li>`).join("");
      return `<div class="tl-sub ${cls}">${title}</div><ul class="tl-l">${lis}</ul>`;
    };
    h += list("pos", "pos", "✓ " + L("Το επιβεβαιώνει", "Confirms it"));
    h += list("x", "x", "✗ " + L("Το αποκλείει", "Rules it out"));
    h += list("info", "", "ℹ " + L("Σημειώσεις", "Notes"));
    return h + `</div>`;
  }

  const mounts = new Set();
  window.addEventListener("storage", e => { if(e.key === KEY || e.key === DETAIL_KEY) mounts.forEach(m => m.render()); });

  // root: το element που γεμίζει (μπορεί να ανήκει σε άλλο document, π.χ. το PiP window).
  // getLang: () => "el" | "en". onCount(n): πλήθος suspects (π.χ. για κρύψιμο του κουτιού όταν είναι άδειο).
  function mount(root, getLang, onCount){
    const doc = root.ownerDocument;
    if(!doc.getElementById("tells-css")){
      const st = doc.createElement("style"); st.id = "tells-css"; st.textContent = CSS; doc.head.appendChild(st);
    }
    // Full: ποιο ghost είναι ανοιχτό (ανά σελίδα). undefined = αυτόματα το πρώτο, null = όλα κλειστά.
    let picking = false, openName;

    function render(){
      const lang = getLang(), sel = loadSuspects(), full = isFull(), atMax = sel.length >= MAX;
      if(atMax) picking = false;
      let h = `<div class="tl-ctl">`
        + sel.map(n => `<button class="tl-chip" data-rm="${esc(n)}" title="${lang === "el" ? "Αφαίρεση" : "Remove"}">${esc(n)} ✕</button>`).join("")
        + (atMax ? "" : `<button class="tl-add" data-pick="1">${picking ? "✕" : "＋ Ghost"}</button>`)
        + (sel.length ? `<button class="tl-det${full ? " on" : ""}" data-det="1" title="${lang === "el" ? "Σύντομα / πλήρη στοιχεία (F)" : "Short / full detail (F)"}">${full ? "≡ Full" : "− Short"}</button>` : "")
        + `</div>`;
      if(picking){
        h += `<div class="tl-pick">` + [...GHOSTS].sort((a, b) => a.name.localeCompare(b.name))
          .map(g => `<button data-add="${esc(g.name)}"${sel.includes(g.name) ? " disabled" : ""}>${esc(g.name)}</button>`).join("") + `</div>`;
      } else if(!sel.length){
        h += `<div class="tl-empty">${lang === "el" ? "Διάλεξε έως 3 ghosts που υποψιάζεσαι για να δεις τα tells τους." : "Pick up to 3 suspected ghosts to see their tells."}</div>`;
      }
      if(openName !== null && !sel.includes(openName)) openName = sel[0];
      h += sel.map(n => card(n, lang, full, n === openName)).join("");
      root.innerHTML = h;
      if(onCount) onCount(sel.length);
    }

    const onClick = e => {
      const hd = e.target.closest("[data-open]");
      if(hd && root.contains(hd)){ openName = openName === hd.dataset.open ? null : hd.dataset.open; render(); return; }
      const b = e.target.closest("button");
      if(!b || !root.contains(b)) return;
      const sel = loadSuspects();
      if(b.dataset.pick) picking = !picking;
      else if(b.dataset.det) setFull(!isFull());
      else if(b.dataset.add){ if(!sel.includes(b.dataset.add) && sel.length < MAX){ sel.push(b.dataset.add); saveSuspects(sel); openName = b.dataset.add; } }
      else if(b.dataset.rm) saveSuspects(sel.filter(n => n !== b.dataset.rm));
      else return;
      render();
    };
    root.addEventListener("click", onClick);

    const api = {
      render,
      togglePick(){ if(loadSuspects().length < MAX){ picking = !picking; render(); } },
      toggleDetail(){ setFull(!isFull()); render(); },
      destroy(){ mounts.delete(api); root.removeEventListener("click", onClick); }
    };
    mounts.add(api);
    render();
    return api;
  }

  return {KEY, MAX, mount};
})();
