// Ghost tells panel — κοινό για το timers.html (Steam overlay) και το pop-out του index.html.
// Θέλει τα GHOSTS / TELL_EN / HUNT_EN / EV του ghosts-data.js (φόρτωσέ το πρώτα).
// Η επιλογή (έως 3 suspects) κρατιέται στο localStorage και μοιράζεται ανάμεσα στις σελίδες
// του ίδιου browser — ο browser του Steam overlay έχει δικό του storage.
const TELLS_KEY = "phasmo-timers-suspects", TELLS_MAX = 3;

function loadSuspects(){
  try{
    const a = JSON.parse(localStorage.getItem(TELLS_KEY) || "[]");
    return Array.isArray(a) ? a.filter(n => GHOSTS.some(g => g.name === n)).slice(0, TELLS_MAX) : [];
  }catch(e){ return []; }
}
function saveSuspects(a){ try{ localStorage.setItem(TELLS_KEY, JSON.stringify(a)); }catch(e){/* ignore */} }

const TELLS_CSS = `
  .tl-ctl{display:flex;gap:4px;flex-wrap:wrap;margin:4px 0}
  .tl-ctl button,.tl-pick button{font:inherit;font-size:11.5px;border:1px solid var(--line);background:#0c1118;color:#B9C2CE;border-radius:12px;padding:2px 8px;cursor:pointer}
  .tl-ctl .tl-chip{border-color:var(--nv-dim);color:var(--nv);background:rgba(143,227,136,.08)}
  .tl-ctl .tl-add{border-color:var(--warn);color:var(--warn)}
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
  body.min:not(.reveal) .tl-ctl, body.min:not(.reveal) .tl-pick, body.min:not(.reveal) .tl-empty,
  body.min:not(.reveal) .tl-none{display:none}
`;

// root: το element που γεμίζει (μπορεί να ανήκει σε άλλο document, π.χ. το PiP window).
// getLang: () => "el" | "en". onCount(n): ενημέρωση για το πλήθος των suspects (π.χ. για κρύψιμο
// του κουτιού στο minimal όταν είναι άδειο).
function mountTells(root, getLang, onCount){
  const doc = root.ownerDocument;
  if(!doc.getElementById("tells-css")){
    const st = doc.createElement("style"); st.id = "tells-css"; st.textContent = TELLS_CSS; doc.head.appendChild(st);
  }
  let picking = false;
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[ch]));
  const evIc = k => (EV.find(e => e.k === k) || {}).ic || k;
  const evName = k => (EV.find(e => e.k === k) || {}).n || k;

  function render(){
    const lang = getLang(), sel = loadSuspects(), full = sel.length >= TELLS_MAX;
    if(full) picking = false;
    let h = `<div class="tl-ctl">`
      + sel.map(n => `<button class="tl-chip" data-rm="${esc(n)}" title="${lang==="el"?"Αφαίρεση":"Remove"}">${esc(n)} ✕</button>`).join("")
      + (full ? "" : `<button class="tl-add" data-pick="1">${picking ? "✕" : "＋ Ghost"}</button>`)
      + `</div>`;
    if(picking){
      h += `<div class="tl-pick">` + [...GHOSTS].sort((a,b) => a.name.localeCompare(b.name))
        .map(g => `<button data-add="${esc(g.name)}"${sel.includes(g.name) ? " disabled" : ""}>${esc(g.name)}</button>`).join("") + `</div>`;
    } else if(!sel.length){
      h += `<div class="tl-empty">${lang==="el" ? "Διάλεξε έως 3 ghosts που υποψιάζεσαι για να δεις τα tells τους." : "Pick up to 3 suspected ghosts to see their tells."}</div>`;
    }
    h += sel.map(n => {
      const g = GHOSTS.find(x => x.name === n);
      const tell = lang === "en" ? (TELL_EN[n] || g.tell) : g.tell;
      const hunt = lang === "en" ? (HUNT_EN[n] || g.hunt) : g.hunt;
      return `<div class="tl-card"><div class="tl-h"><b>${esc(n)}</b>`
        + `<span class="tl-ev" title="${esc(g.ev.map(evName).join(" · "))}">${g.ev.map(evIc).join(" ")}</span>`
        + `<span class="tl-hunt">hunt ${esc(hunt)}</span></div><div class="tl-t">${esc(tell)}</div></div>`;
    }).join("");
    root.innerHTML = h;
    if(onCount) onCount(sel.length);
  }

  root.addEventListener("click", e => {
    const b = e.target.closest("button");
    if(!b || !root.contains(b)) return;
    let sel = loadSuspects();
    if(b.dataset.pick) picking = !picking;
    else if(b.dataset.add){ if(!sel.includes(b.dataset.add) && sel.length < TELLS_MAX){ sel.push(b.dataset.add); saveSuspects(sel); } }
    else if(b.dataset.rm) saveSuspects(sel.filter(n => n !== b.dataset.rm));
    else return;
    render();
  });

  render();
  return {
    render,
    togglePick(){ if(loadSuspects().length < TELLS_MAX){ picking = !picking; render(); } },
    clear(){ saveSuspects([]); picking = false; render(); }
  };
}
