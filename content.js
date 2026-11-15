// Chess Trainer – content script for chess.com
// Loop: read board -> build FEN -> ask Stockfish -> paint arrow + panel.
// Modes: Humans, Bots, or All games. Stream mode (Alt+S) moves the UI
// into a separate OS window (PiP) so window-capture tools on OBS /
// Discord / YouTube / Teams cannot see anything.

(() => {
  if (window.__chessTrainerLoaded) return;
  window.__chessTrainerLoaded = true;

  const CFG = {
    pollMs: 250,
    hotkey: { alt: true, key: "x" },       // on/off
    streamHotkey: { alt: true, key: "s" }, // stream-safe mode (separate window)
    modeHotkey: { alt: true, key: "m" },   // cycle modes
    storageStream: "ct.stream",
  };

  // Play styles: how many centipawns may a move sacrifice to be more aggressive?
  const STYLES = {
    solid:      { label: "Solid",      icon: "♖", multipv: 3, tol: 20,  prefer: "quiet"  },
    balanced:   { label: "Balanced",   icon: "♗", multipv: 1, tol: 0,   prefer: "best"   },
    aggressive: { label: "Aggressive", icon: "♘", multipv: 4, tol: 60,  prefer: "attack" },
    allin:      { label: "All-in",     icon: "♛", multipv: 5, tol: 150, prefer: "attack" },
  };

  // Mode: where should the trainer run?
  const MODES = {
    all:  { label: "All",   icon: "♚", match: () => true },
    bots: { label: "Bots",  icon: "⚙", match: () => location.pathname.startsWith("/play/computer") },
    humans: {
      label: "Humans",
      icon: "♟",
      match: () => {
        const p = location.pathname;
        if (p.startsWith("/play/computer")) return false;
        return (
          p.startsWith("/play/online") ||
          p.startsWith("/play/") ||
          p.startsWith("/live") ||
          p.startsWith("/game/live") ||
          p.startsWith("/game/daily") ||
          p.startsWith("/daily") ||
          p.startsWith("/analysis")
        );
      },
    },
  };

  const settings = { style: "balanced", think: 0.8, mode: "all" };
  try {
    const saved = JSON.parse(localStorage.getItem("chessTrainerSettings") || "null");
    if (saved && STYLES[saved.style]) settings.style = saved.style;
    if (saved && saved.think >= 0.3 && saved.think <= 3) settings.think = saved.think;
    if (saved && MODES[saved.mode]) settings.mode = saved.mode;
  } catch (e) {}
  function saveSettings() {
    try { localStorage.setItem("chessTrainerSettings", JSON.stringify(settings)); } catch (e) {}
  }

  const ALL_RIGHTS = { K: true, Q: true, k: true, q: true };
  const state = {
    enabled: true,
    stream: false,
    pendingStream: false,
    placement: null,
    prevGrid: null,
    grid: null,
    turn: "w",
    ep: "-",
    castling: { ...ALL_RIGHTS },
    requestedFen: null,
    result: null,
    warnedNoBoard: false,
  };

  // Persist stream preference (PiP requires a user gesture after reload).
  try {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([CFG.storageStream], (res) => {
        if (res && res[CFG.storageStream] === true) state.pendingStream = true;
      });
    } else {
      const v = localStorage.getItem(CFG.storageStream);
      if (v === "true") state.pendingStream = true;
    }
  } catch (_) {}
  function persistStream() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [CFG.storageStream]: !!state.stream });
      } else {
        localStorage.setItem(CFG.storageStream, state.stream ? "true" : "false");
      }
    } catch (_) {}
  }

  // ---------- Board reader ----------
  const findBoard = () => document.querySelector("wc-chess-board") || document.querySelector("chess-board");

  function squareOf(el) {
    for (const cls of el.classList) {
      const m = /^square-(\d)(\d)$/.exec(cls);
      if (m) return { file: +m[1], rank: +m[2] };
    }
    return null;
  }

  function readPieces(board) {
    const out = [];
    for (const el of board.querySelectorAll(".piece")) {
      let c = null, t = null;
      for (const cls of el.classList) {
        const m = /^([wb])([pnbrqk])$/.exec(cls);
        if (m) { c = m[1]; t = m[2]; }
      }
      const sq = squareOf(el);
      if (c && sq) out.push({ c, t, file: sq.file, rank: sq.rank });
    }
    return out;
  }

  function readHighlights(board) {
    const out = [];
    for (const el of board.querySelectorAll(".highlight")) {
      const sq = squareOf(el);
      if (sq) out.push(sq);
    }
    return out;
  }

  // ---------- Arrow ----------
  const SVG_NS = "http://www.w3.org/2000/svg";

  function ensureOverlay(board) {
    let svg = board.querySelector(":scope > svg.chess-trainer-arrow");
    if (!svg) {
      svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "chess-trainer-arrow");
      svg.setAttribute("viewBox", "0 0 800 800");
      svg.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:50;";
      board.appendChild(svg);
    }
    return svg;
  }

  function center(file, rank, flipped) {
    const x = flipped ? 8 - file + 0.5 : file - 0.5;
    const y = flipped ? rank - 0.5 : 8 - rank + 0.5;
    return { x: x * 100, y: y * 100 };
  }

  function svgEl(svg, name, attrs) {
    const e = document.createElementNS(SVG_NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    svg.appendChild(e);
    return e;
  }

  function drawArrow(board, flipped, uci) {
    const svg = ensureOverlay(board);
    svg.replaceChildren();
    if (!uci) return;
    const a = center(uci.charCodeAt(0) - 96, +uci[1], flipped);
    const b = center(uci.charCodeAt(2) - 96, +uci[3], flipped);
    const color = "rgba(46, 204, 113, 0.85)";
    svgEl(svg, "circle", { cx: a.x, cy: a.y, r: 46, fill: "none", stroke: color, "stroke-width": 8 });
    svgEl(svg, "circle", { cx: b.x, cy: b.y, r: 46, fill: "none", stroke: color, "stroke-width": 8 });
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, head = 34;
    const ex = b.x - ux * 40, ey = b.y - uy * 40;
    svgEl(svg, "line", {
      x1: a.x + ux * 40, y1: a.y + uy * 40, x2: ex - ux * head * 0.6, y2: ey - uy * head * 0.6,
      stroke: color, "stroke-width": 16, "stroke-linecap": "round",
    });
    const px = -uy, py = ux;
    svgEl(svg, "polygon", {
      points: [
        [ex, ey],
        [ex - ux * head + px * head * 0.7, ey - uy * head + py * head * 0.7],
        [ex - ux * head - px * head * 0.7, ey - uy * head - py * head * 0.7],
      ].map((p) => p.join(",")).join(" "),
      fill: color,
    });
  }

  function clearOverlay() {
    document.querySelectorAll("svg.chess-trainer-arrow").forEach((s) => s.replaceChildren());
  }

  // ---------- High-res piece icons (inline SVG, original silhouettes) ----------
  // ViewBox 0 0 60 60, fill driven by CSS "color" via currentColor.
  const PIECE_SHAPES = {
    p: '<circle cx="30" cy="18" r="6"/><path d="M22 26 L38 26 L40 36 L20 36 Z"/><path d="M16 36 L44 36 L46 44 L14 44 Z"/>',
    r: '<path d="M14 14 L20 14 L20 20 L26 20 L26 14 L34 14 L34 20 L40 20 L40 14 L46 14 L46 22 L42 26 L42 40 L46 44 L46 46 L14 46 L14 44 L18 40 L18 26 L14 22 Z"/>',
    n: '<path d="M24 10 L18 18 L13 22 L15 28 L21 26 L19 32 L23 30 L21 38 L18 44 L18 48 L46 48 L46 42 L43 34 L41 26 L37 20 L31 14 L27 10 Z"/><circle cx="36" cy="22" r="1.6" fill="#1a0f05"/>',
    b: '<circle cx="30" cy="10" r="3"/><path d="M30 13 C21 20 19 28 22 36 L38 36 C41 28 39 20 30 13 Z"/><path d="M28 20 L32 28" stroke-width="1.8" fill="none"/><path d="M18 36 L42 36 L44 42 L16 42 Z"/><path d="M14 42 L46 42 L46 46 L14 46 Z"/>',
    q: '<circle cx="12" cy="12" r="2"/><circle cx="22" cy="10" r="2"/><circle cx="30" cy="8" r="2"/><circle cx="38" cy="10" r="2"/><circle cx="48" cy="12" r="2"/><path d="M12 14 L18 24 L22 12 L26 24 L30 10 L34 24 L38 12 L42 24 L48 14 L46 28 L14 28 Z"/><path d="M16 28 L44 28 L42 38 L18 38 Z"/><path d="M16 38 L44 38 L46 44 L14 44 Z"/><path d="M12 44 L48 44 L48 48 L12 48 Z"/>',
    k: '<path d="M27 4 L33 4 L33 10 L38 10 L38 16 L33 16 L33 22 L27 22 L27 16 L22 16 L22 10 L27 10 Z"/><path d="M18 24 C18 20 22 18 30 18 C38 18 42 20 42 24 L42 30 L18 30 Z"/><path d="M16 30 L44 30 L42 40 L18 40 Z"/><path d="M16 40 L44 40 L46 46 L14 46 Z"/>',
  };

  function pieceSvg(pc) {
    if (!pc) return "";
    const type = pc.toLowerCase();
    const shapes = PIECE_SHAPES[type];
    if (!shapes) return "";
    const isWhite = pc === pc.toUpperCase();
    const fill = isWhite ? "#f8f0dc" : "#2a1c10";
    const stroke = isWhite ? "#1a0f05" : "#e8c977";
    return (
      '<svg class="pc-svg" viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">' +
        '<g fill="' + fill + '" stroke="' + stroke + '" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round">' +
          shapes +
        '</g>' +
      '</svg>'
    );
  }

  // ---------- Panel ----------
  const CSS = `
  #ct-panel{position:fixed;z-index:2147483646;box-sizing:border-box;min-width:320px;
    background:linear-gradient(180deg,#3a2817 0%,#2a1c10 100%);color:#f3e6c8;
    border:2px solid #c9a45c;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,230,170,.08);
    font:14px/1.35 Georgia,"Times New Roman",serif;user-select:none}
  #ct-panel *{box-sizing:border-box}
  #ct-panel .ct-head{display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:move;
    border-bottom:1px solid rgba(201,164,92,.45);
    background:repeating-linear-gradient(90deg,rgba(201,164,92,.10) 0 14px,transparent 14px 28px)}
  #ct-panel .ct-logo{width:26px;height:26px;display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.5))}
  #ct-panel .ct-title{font-weight:700;letter-spacing:.06em;font-variant:small-caps;font-size:15px;color:#e8c977}
  #ct-panel .ct-turn{margin-left:auto;font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid #c9a45c;white-space:nowrap}
  #ct-panel .ct-turn.me{background:#e8c977;color:#2a1c10;font-weight:700}
  #ct-panel .ct-btn{background:none;border:1px solid rgba(201,164,92,.6);color:#e8c977;border-radius:5px;
    width:24px;height:22px;cursor:pointer;font:14px Georgia,serif;line-height:1;padding:0}
  #ct-panel .ct-btn:hover{background:rgba(201,164,92,.18)}
  #ct-panel .ct-btn.on{background:#e8c977;color:#2a1c10}
  #ct-panel .ct-body{padding:9px 10px 10px;display:grid;gap:9px}
  #ct-panel.collapsed .ct-body{display:none}
  #ct-panel .ct-bar{position:relative;height:16px;border-radius:4px;overflow:hidden;background:#1b120a;border:1px solid #c9a45c}
  #ct-panel .ct-bar i{position:absolute;left:0;top:0;bottom:0;background:#f4ead2;transition:width .35s ease}
  #ct-panel .ct-bar b{position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:#c9a45c}
  #ct-panel .ct-bar span{position:absolute;right:6px;top:0;font:700 11px/16px Georgia,serif;color:#c9a45c}
  #ct-panel .ct-tiles{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:6px}
  #ct-panel .ct-tile{background:rgba(0,0,0,.25);border:1px solid rgba(201,164,92,.35);border-radius:6px;padding:5px 8px;min-width:0}
  #ct-panel .ct-lbl{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#bfa77a}
  #ct-panel .ct-val{font-size:18px;font-weight:700;color:#fff6e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:6px}
  #ct-panel .ct-val.ev{transition:color .3s}
  #ct-panel .pc-svg{width:30px;height:30px;flex-shrink:0;filter:drop-shadow(0 1px 1px rgba(0,0,0,.5))}
  #ct-panel .ct-mate{display:none;text-align:center;font-weight:700;font-variant:small-caps;letter-spacing:.05em;
    padding:5px 8px;border-radius:6px;font-size:15px}
  #ct-panel .ct-mate.win{display:block;background:#2e7d4f;color:#fff;border:1px solid #6fd39a}
  #ct-panel .ct-mate.loss{display:block;background:#7d2e2e;color:#fff;border:1px solid #e08a8a}
  #ct-panel.off .ct-body{opacity:.4}
  #ct-panel .ct-settings{padding:9px 10px 11px;border-bottom:1px solid rgba(201,164,92,.45);background:rgba(0,0,0,.28);display:grid;gap:7px}
  #ct-panel .ct-settings[hidden]{display:none}
  #ct-panel .ct-seg{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}
  #ct-panel .ct-seg.m3{grid-template-columns:repeat(3,1fr)}
  #ct-panel .ct-seg button{background:rgba(0,0,0,.3);border:1px solid rgba(201,164,92,.45);color:#f3e6c8;border-radius:6px;
    padding:5px 2px;cursor:pointer;font:600 12px Georgia,serif;white-space:nowrap}
  #ct-panel .ct-seg button span{display:block;font-size:19px;line-height:1.1}
  #ct-panel .ct-seg button:hover{background:rgba(201,164,92,.18)}
  #ct-panel .ct-seg button.sel{background:#e8c977;color:#2a1c10;border-color:#e8c977}
  #ct-panel .ct-row{display:flex;align-items:center;gap:10px}
  #ct-panel .ct-row b{font-weight:700;color:#fff6e0;min-width:42px;text-align:right}
  #ct-panel input[type=range]{flex:1;accent-color:#c9a45c}
  #ct-toast{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;
    padding:8px 14px;border-radius:6px;background:linear-gradient(135deg,#3a2817,#2a1c10);color:#e8c977;
    font:700 12px/1.3 Georgia,serif;letter-spacing:.4px;border:1px solid #c9a45c;
    box-shadow:0 6px 16px rgba(0,0,0,.45);pointer-events:none;opacity:0;transition:opacity 180ms ease}
  `;

  let panel = null;
  let ui = {};
  let dragged = null;

  try {
    const saved = JSON.parse(localStorage.getItem("chessTrainerPanel") || "null");
    if (saved && typeof saved.x === "number") dragged = saved;
  } catch (e) {}

  function logoHref() {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
        return chrome.runtime.getURL("icons/logo96.png");
      }
    } catch (_) {}
    return "";
  }

  function setValueWithPiece(el, pieceChar, text) {
    el.replaceChildren();
    if (pieceChar) {
      const tpl = document.createElement("template");
      tpl.innerHTML = pieceSvg(pieceChar);
      const node = tpl.content.firstElementChild;
      if (node) el.appendChild(node);
    }
    const label = document.createElement("span");
    label.textContent = text;
    el.appendChild(label);
  }

  function buildPanel() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.documentElement.appendChild(style);

    panel = document.createElement("div");
    panel.id = "ct-panel";
    panel.innerHTML = `
      <div class="ct-head">
        <img class="ct-logo" alt="" src="${logoHref()}"><span class="ct-title">Chess Trainer</span>
        <span class="ct-turn">…</span>
        <button class="ct-btn" data-act="stream" title="Stream mode (Alt+S) – separate window, hidden from window-capture">◉</button>
        <button class="ct-btn" data-act="gear" title="Settings">⚙</button>
        <button class="ct-btn" data-act="power" title="On/off (Alt+X)">⏻</button>
        <button class="ct-btn" data-act="fold" title="Collapse">–</button>
      </div>
      <div class="ct-settings" hidden>
        <div class="ct-lbl">Mode (Alt+M)</div>
        <div class="ct-seg m3">
          ${Object.entries(MODES).map(([k, v]) => `<button data-mode="${k}"><span>${v.icon}</span>${v.label}</button>`).join("")}
        </div>
        <div class="ct-lbl">Play style</div>
        <div class="ct-seg">
          ${Object.entries(STYLES).map(([k, v]) => `<button data-style="${k}"><span>${v.icon}</span>${v.label}</button>`).join("")}
        </div>
        <div class="ct-lbl">Think time</div>
        <div class="ct-row"><input type="range" min="0.3" max="3" step="0.1" data-k="think"><b data-k="thinkOut"></b></div>
      </div>
      <div class="ct-body">
        <div class="ct-bar" title="Evaluation bar (light = White)"><i></i><b></b><span></span></div>
        <div class="ct-mate"></div>
        <div class="ct-tiles">
          <div class="ct-tile"><div class="ct-lbl" data-k="moveLbl">Best move</div><div class="ct-val" data-k="move">–</div></div>
          <div class="ct-tile"><div class="ct-lbl">Evaluation</div><div class="ct-val ev" data-k="eval">–</div></div>
          <div class="ct-tile"><div class="ct-lbl">Material</div><div class="ct-val" data-k="mat">–</div></div>
        </div>
      </div>`;
    document.documentElement.appendChild(panel);

    ui = {
      turn: panel.querySelector(".ct-turn"),
      barFill: panel.querySelector(".ct-bar i"),
      barText: panel.querySelector(".ct-bar span"),
      mate: panel.querySelector(".ct-mate"),
      streamBtn: panel.querySelector('[data-act="stream"]'),
    };
    panel.querySelectorAll("[data-k]").forEach((el) => (ui[el.dataset.k] = el));

    panel.querySelector('[data-act="power"]').addEventListener("click", toggleEnabled);
    panel.querySelector('[data-act="stream"]').addEventListener("click", () => toggleStream());
    const gear = panel.querySelector('[data-act="gear"]');
    const box = panel.querySelector(".ct-settings");
    gear.addEventListener("click", () => {
      box.hidden = !box.hidden;
      gear.classList.toggle("on", !box.hidden);
    });
    const syncSettingsUi = () => {
      box.querySelectorAll("[data-style]").forEach((b) => b.classList.toggle("sel", b.dataset.style === settings.style));
      box.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("sel", b.dataset.mode === settings.mode));
      ui.think.value = settings.think;
      ui.thinkOut.textContent = settings.think.toFixed(1) + " s";
    };
    box.querySelectorAll("[data-style]").forEach((b) =>
      b.addEventListener("click", () => {
        settings.style = b.dataset.style;
        saveSettings();
        syncSettingsUi();
        reanalyze();
      })
    );
    box.querySelectorAll("[data-mode]").forEach((b) =>
      b.addEventListener("click", () => {
        settings.mode = b.dataset.mode;
        saveSettings();
        syncSettingsUi();
      })
    );
    ui.think.addEventListener("input", () => {
      settings.think = +(+ui.think.value).toFixed(1);
      ui.thinkOut.textContent = settings.think.toFixed(1) + " s";
    });
    ui.think.addEventListener("change", () => { saveSettings(); reanalyze(); });
    syncSettingsUi();
    panel.querySelector('[data-act="fold"]').addEventListener("click", (e) => {
      panel.classList.toggle("collapsed");
      e.currentTarget.textContent = panel.classList.contains("collapsed") ? "+" : "–";
    });

    const head = panel.querySelector(".ct-head");
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect();
      const offX = e.clientX - r.left, offY = e.clientY - r.top;
      const move = (ev) => {
        dragged = { x: Math.max(0, ev.clientX - offX), y: Math.max(0, ev.clientY - offY) };
        panel.style.left = dragged.x + "px";
        panel.style.top = dragged.y + "px";
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        try { localStorage.setItem("chessTrainerPanel", JSON.stringify(dragged)); } catch (err) {}
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    head.addEventListener("dblclick", () => {
      dragged = null;
      try { localStorage.removeItem("chessTrainerPanel"); } catch (err) {}
    });
  }

  function placePanel(board) {
    if (!panel) buildPanel();
    panel.style.display = "block";
    const r = board.getBoundingClientRect();
    panel.style.width = Math.max(320, Math.min(r.width, 560)) + "px";
    if (dragged) {
      panel.style.left = dragged.x + "px";
      panel.style.top = dragged.y + "px";
      return;
    }
    const h = panel.offsetHeight;
    let top = r.top - h - 8;
    if (top < 6) top = 6;
    panel.style.left = Math.max(6, r.left) + "px";
    panel.style.top = top + "px";
  }

  function hidePanel() {
    if (panel) panel.style.display = "none";
  }

  // ---------- Toast ----------
  let toastEl = null;
  function showToast(text, ms = 1200) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.id = "ct-toast";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = "1";
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => { toastEl.style.opacity = "0"; }, ms);
  }

  // ---------- Score shaping ----------
  function fromMyView(score, turn, me) {
    if (!score) return null;
    const sign = turn === me ? 1 : -1;
    if (score.mate !== undefined) return { mate: score.mate * sign };
    return { cp: score.cp * sign };
  }

  const SCALE = [
    { max: -300, word: "Terrible",  color: "#a3201a" },
    { max: -120, word: "Bad",       color: "#d1452b" },
    { max: -40,  word: "Dubious",   color: "#e58a2e" },
    { max: 40,   word: "Equal",     color: "#dcc54d" },
    { max: 120,  word: "Good",      color: "#a8d24b" },
    { max: 300,  word: "Great",     color: "#86dc55" },
    { max: Infinity, word: "Excellent", color: "#9cf06e" },
  ];
  function evalWord(my) {
    if (my.mate !== undefined) return my.mate > 0 ? { word: "Winning", color: "#c4ff9a" } : { word: "Lost", color: "#7a0f0f" };
    return SCALE.find((s) => my.cp < s.max) || SCALE[SCALE.length - 1];
  }

  function whiteShare(score, turn) {
    if (!score) return 0.5;
    const s = turn === "w" ? 1 : -1;
    if (score.mate !== undefined) return score.mate * s > 0 ? 1 : 0;
    return 1 / (1 + Math.exp(-(score.cp * s) / 250));
  }

  const val = (sc) => (sc.mate !== undefined ? (sc.mate > 0 ? 100000 - sc.mate : -100000 - sc.mate) : sc.cp);

  function chooseLine(grid, res, isMyTurn) {
    const lines = res.lines && res.lines.length ? res.lines : [{ move: res.bestmove, score: res.score, pv: res.pv }];
    const st = STYLES[settings.style];
    const best = lines[0];
    if (!isMyTurn || st.prefer === "best" || lines.length < 2) return best;
    if (best.score.mate !== undefined && best.score.mate > 0) return best;
    const bestVal = val(best.score);
    const ok = lines.filter((l) => l.score && bestVal - val(l.score) <= st.tol && val(l.score) > -90000);
    if (!ok.length) return best;
    const G = ChessFen;
    let pick = best, pickScore = -Infinity;
    for (const l of ok) {
      const agg = G.aggression(grid, l.move);
      const sc = (st.prefer === "quiet" ? -agg : agg) * 100 - (bestVal - val(l.score)) * 0.5;
      if (sc > pickScore) { pickScore = sc; pick = l; }
    }
    return pick;
  }

  function setEval(text, color) {
    ui.eval.replaceChildren();
    ui.eval.style.color = color || "";
    const span = document.createElement("span");
    span.textContent = text;
    ui.eval.appendChild(span);
  }

  // Keep the latest payload so the PiP window can repaint on open.
  let lastPayload = null;

  function renderPanel(board, info) {
    if (state.stream) {
      hidePanel();
      lastPayload = buildPipPayload(info);
      renderPip(lastPayload);
      return;
    }
    placePanel(board);
    const G = ChessFen;
    const { grid, turn, me, res, thinking } = info;

    ui.turn.textContent = turn === me ? "Your move" : "Opponent to move";
    ui.turn.classList.toggle("me", turn === me);
    panel.classList.toggle("off", !state.enabled);
    if (ui.streamBtn) ui.streamBtn.classList.toggle("on", state.stream);

    const matW = G.material(grid);
    const matMe = me === "w" ? matW : -matW;
    ui.mat.replaceChildren();
    const matSpan = document.createElement("span");
    matSpan.textContent = matMe === 0 ? "Even" : (matMe > 0 ? "+" : "−") + Math.abs(matMe);
    ui.mat.appendChild(matSpan);

    if (!state.enabled) {
      setValueWithPiece(ui.move, null, "Off");
      setEval("–");
      ui.mate.className = "ct-mate";
      return;
    }
    if (!res || thinking) {
      setValueWithPiece(ui.move, null, "…");
      if (!res) setEval("…");
      return;
    }
    if (!res.bestmove) {
      setValueWithPiece(ui.move, null, "–");
      setEval("Game over");
      ui.mate.className = "ct-mate";
      return;
    }

    const line = chooseLine(grid, res, turn === me);
    info.line = line;
    ui.moveLbl.textContent = turn !== me ? "Opponent expects" : settings.style === "balanced" ? "Best move" : STYLES[settings.style].label + " move";
    setValueWithPiece(ui.move, G.pieceAt(grid, line.move), G.toSan(grid, line.move));

    const my = fromMyView(line.score, turn, me);
    if (my) {
      const w = evalWord(my);
      setEval(w.word, w.color);
      if (my.mate !== undefined) {
        const n = Math.abs(my.mate);
        const mv = n === 1 ? "move" : "moves";
        ui.mate.className = "ct-mate " + (my.mate > 0 ? "win" : "loss");
        ui.mate.textContent = my.mate > 0 ? `♚ Mate in ${n} ${mv}` : `⚠ Opponent mates you in ${n} ${mv}`;
      } else {
        ui.mate.className = "ct-mate";
      }
    }
    ui.barFill.style.width = (whiteShare(line.score, turn) * 100).toFixed(1) + "%";
  }

  function buildPipPayload(info) {
    const G = ChessFen;
    const { grid, turn, me, res, thinking } = info;
    const matW = G.material(grid);
    const matMe = me === "w" ? matW : -matW;
    const matStr = matMe === 0 ? "Even" : (matMe > 0 ? "+" : "−") + Math.abs(matMe);
    const payload = {
      turn: turn === me ? "Your move" : "Opponent to move",
      isMyTurn: turn === me,
      enabled: state.enabled,
      moveLbl: "Best move",
      moveText: "–",
      pieceChar: null,
      evalText: "–",
      evalColor: "",
      mateText: "",
      mateCls: "",
      matStr,
      whitePct: 50,
    };
    if (!state.enabled) {
      payload.moveText = "Off";
      return payload;
    }
    if (!res || thinking) {
      payload.moveText = "…";
      if (!res) payload.evalText = "…";
      return payload;
    }
    if (!res.bestmove) {
      payload.evalText = "Game over";
      return payload;
    }
    const line = chooseLine(grid, res, turn === me);
    payload.moveLbl = turn !== me ? "Opponent expects" : settings.style === "balanced" ? "Best move" : STYLES[settings.style].label + " move";
    payload.moveText = G.toSan(grid, line.move);
    payload.pieceChar = G.pieceAt(grid, line.move);
    const my = fromMyView(line.score, turn, me);
    if (my) {
      const w = evalWord(my);
      payload.evalText = w.word;
      payload.evalColor = w.color;
      if (my.mate !== undefined) {
        const n = Math.abs(my.mate);
        const mv = n === 1 ? "move" : "moves";
        payload.mateCls = my.mate > 0 ? "win" : "loss";
        payload.mateText = my.mate > 0 ? `♚ Mate in ${n} ${mv}` : `⚠ Opponent mates you in ${n} ${mv}`;
      }
    }
    payload.whitePct = +(whiteShare(line.score, turn) * 100).toFixed(1);
    payload.moveUci = line.move;
    return payload;
  }

  // ---------- Stream mode: separate OS window ----------
  // PiP (Chromium) or classic popup (others). Both yield their own HWND and are
  // therefore invisible to Window Capture tied to the chess.com browser window.
  let pipWindow = null;
  let pipEls = null;

  function pipSupported() {
    return typeof window !== "undefined" && "documentPictureInPicture" in window;
  }

  async function openPipWindow() {
    if (pipWindow && !pipWindow.closed) return true;
    try {
      if (pipSupported()) {
        pipWindow = await window.documentPictureInPicture.requestWindow({
          width: 360,
          height: 240,
          disallowReturnToOpener: true,
        });
      } else {
        pipWindow = window.open(
          "about:blank",
          "chessTrainerStream",
          "popup=yes,width=360,height=240,menubar=no,toolbar=no,location=no,status=no"
        );
        if (!pipWindow) {
          showToast("Popup blocked – allow popups for chess.com", 2200);
          return false;
        }
      }
    } catch (e) {
      console.warn("[Chess Trainer] Stream window failed to open:", e);
      pipWindow = null;
      return false;
    }

    const doc = pipWindow.document;
    doc.title = "Chess Trainer – Stream";
    doc.head.replaceChildren();
    doc.body.replaceChildren();

    const style = doc.createElement("style");
    style.textContent = `
      :root { color-scheme: dark; }
      html, body { margin:0; padding:0; height:100%; width:100%;
        background:linear-gradient(180deg,#3a2817 0%,#2a1c10 100%);
        color:#f3e6c8;
        font: 14px/1.3 Georgia,"Times New Roman",serif;
        overflow:hidden;
      }
      .wrap { display:flex; flex-direction:column; gap:8px; padding:10px 12px; height:100%; box-sizing:border-box; }
      .head { display:flex; align-items:center; gap:8px;
        padding-bottom:6px; border-bottom:1px solid rgba(201,164,92,.45);}
      .title { font-weight:700; letter-spacing:.06em; font-variant:small-caps; font-size:15px; color:#e8c977 }
      .turn { margin-left:auto; font-size:12px; padding:2px 9px; border-radius:999px; border:1px solid #c9a45c; }
      .turn.me { background:#e8c977; color:#2a1c10; font-weight:700 }
      .bar { position:relative; height:14px; border-radius:4px; overflow:hidden; background:#1b120a; border:1px solid #c9a45c }
      .bar i { position:absolute; left:0; top:0; bottom:0; background:#f4ead2; transition:width .35s ease }
      .bar b { position:absolute; left:50%; top:-2px; bottom:-2px; width:1px; background:#c9a45c }
      .mate { display:none; text-align:center; font-weight:700; font-variant:small-caps; letter-spacing:.05em;
        padding:4px 8px; border-radius:6px; font-size:14px }
      .mate.win { display:block; background:#2e7d4f; color:#fff; border:1px solid #6fd39a }
      .mate.loss { display:block; background:#7d2e2e; color:#fff; border:1px solid #e08a8a }
      .tiles { display:grid; grid-template-columns:1.2fr 1fr 1fr; gap:6px }
      .tile { background:rgba(0,0,0,.25); border:1px solid rgba(201,164,92,.35); border-radius:6px; padding:5px 8px; min-width:0 }
      .lbl { font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:#bfa77a }
      .val { font-size:18px; font-weight:700; color:#fff6e0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        display:flex; align-items:center; gap:6px }
      .pc-svg { width:30px; height:30px; flex-shrink:0; filter:drop-shadow(0 1px 1px rgba(0,0,0,.5)) }
      .ev { transition:color .3s }
      .hint { font-size:10px; color:#8b6f47; text-align:center; margin-top:auto }
    `;
    doc.head.appendChild(style);

    const wrap = doc.createElement("div"); wrap.className = "wrap";
    wrap.innerHTML = `
      <div class="head">
        <span class="title">Chess Trainer</span>
        <span class="turn" data-k="turn">…</span>
      </div>
      <div class="bar"><i data-k="bar"></i><b></b></div>
      <div class="mate" data-k="mate"></div>
      <div class="tiles">
        <div class="tile"><div class="lbl" data-k="moveLbl">Best move</div><div class="val" data-k="move">–</div></div>
        <div class="tile"><div class="lbl">Evaluation</div><div class="val ev" data-k="eval">–</div></div>
        <div class="tile"><div class="lbl">Material</div><div class="val" data-k="mat">–</div></div>
      </div>
      <div class="hint">Separate window • Press Alt+S again to close</div>
    `;
    doc.body.appendChild(wrap);

    pipEls = { doc };
    wrap.querySelectorAll("[data-k]").forEach((el) => (pipEls[el.dataset.k] = el));

    const closeHandler = () => {
      pipWindow = null;
      pipEls = null;
      if (state.stream) {
        state.stream = false;
        persistStream();
        if (ui.streamBtn) ui.streamBtn.classList.remove("on");
        showToast("Stream mode off", 900);
      }
    };
    pipWindow.addEventListener("pagehide", closeHandler);
    pipWindow.addEventListener("beforeunload", closeHandler);

    if (lastPayload) renderPip(lastPayload);
    return true;
  }

  function closePipWindow() {
    if (pipWindow && !pipWindow.closed) {
      try { pipWindow.close(); } catch (_) {}
    }
    pipWindow = null;
    pipEls = null;
  }

  function setPipMove(el, pieceChar, text) {
    el.replaceChildren();
    if (pieceChar) {
      const tpl = pipEls.doc.createElement("template");
      tpl.innerHTML = pieceSvg(pieceChar);
      const node = tpl.content.firstElementChild;
      if (node) el.appendChild(node);
    }
    const span = pipEls.doc.createElement("span");
    span.textContent = text;
    el.appendChild(span);
  }

  function renderPip(p) {
    if (!pipEls) return;
    pipEls.turn.textContent = p.turn;
    pipEls.turn.classList.toggle("me", !!p.isMyTurn);
    pipEls.moveLbl.textContent = p.moveLbl;
    setPipMove(pipEls.move, p.pieceChar, p.moveText);
    pipEls.eval.replaceChildren();
    pipEls.eval.style.color = p.evalColor || "";
    const evSpan = pipEls.doc.createElement("span");
    evSpan.textContent = p.evalText;
    pipEls.eval.appendChild(evSpan);
    pipEls.mat.replaceChildren();
    const matSpan = pipEls.doc.createElement("span");
    matSpan.textContent = p.matStr;
    pipEls.mat.appendChild(matSpan);
    pipEls.bar.style.width = (p.whitePct || 50) + "%";
    pipEls.mate.className = "mate" + (p.mateCls ? " " + p.mateCls : "");
    pipEls.mate.textContent = p.mateText || "";
  }

  // ---------- Engine ----------
  function sendMsg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
          else resolve(res);
        });
      } catch (e) {
        resolve({ error: String(e) });
      }
    });
  }

  async function analyze(fen) {
    const msg = {
      type: "analyze",
      fen,
      movetime: Math.round(settings.think * 1000),
      multipv: STYLES[settings.style].multipv,
    };
    let res = await sendMsg(msg);
    if (res && res.error) {
      await sendMsg({ type: "ensure-offscreen" });
      await new Promise((r) => setTimeout(r, 400));
      res = await sendMsg(msg);
    }
    return res;
  }

  // ---------- Main loop ----------
  const onValidPage = () => MODES[settings.mode].match();

  function resetGame() {
    state.castling = { ...ALL_RIGHTS };
    state.turn = "w";
    state.ep = "-";
    state.prevGrid = null;
    state.requestedFen = null;
    state.result = null;
  }

  function tick() {
    if (!onValidPage()) {
      clearOverlay();
      hidePanel();
      return;
    }
    const board = findBoard();
    if (!board) {
      if (!state.warnedNoBoard) {
        console.log("[Chess Trainer] Board not found (wc-chess-board).");
        state.warnedNoBoard = true;
      }
      hidePanel();
      return;
    }
    state.warnedNoBoard = false;

    const pieces = readPieces(board);
    if (pieces.length < 2) return;

    const G = ChessFen;
    const grid = G.gridFromPieces(pieces);
    const placement = G.placement(grid);
    const flipped = board.classList.contains("flipped");
    const me = flipped ? "b" : "w";

    if (placement !== state.placement) {
      state.placement = placement;
      if (placement === G.START_PLACEMENT) {
        resetGame();
      } else {
        const mv = G.detectMove(state.prevGrid, grid);
        const mover = mv.mover || G.moverFromHighlights(grid, readHighlights(board));
        state.turn = mover ? G.other(mover) : "w";
        state.ep = mv.ep;
      }
      state.castling = G.updateCastling(state.castling, grid);
      state.prevGrid = grid;
      state.result = null;
    }
    state.grid = grid;

    const fen = G.buildFen(grid, state.turn, state.castling, state.ep);
    const res = state.result && state.result.fen === fen ? state.result : null;

    if (!state.enabled) {
      clearOverlay();
      renderPanel(board, { grid, turn: state.turn, me, res: null, thinking: false });
      return;
    }

    if (state.stream) clearOverlay();

    const info = { grid, turn: state.turn, me, res, thinking: !res };
    renderPanel(board, info);

    if (!state.stream) {
      if (res && res.bestmove && state.turn === me && info.line) drawArrow(board, flipped, info.line.move);
      else clearOverlay();
    }

    if (res || state.requestedFen === fen) return;
    state.requestedFen = fen;

    analyze(fen).then((r) => {
      if (state.requestedFen !== fen) return;
      if (!r || r.superseded) return;
      if (!r.ok) {
        console.warn("[Chess Trainer] Engine error:", r.error);
        setTimeout(() => { if (state.requestedFen === fen) state.requestedFen = null; }, 2000);
        return;
      }
      state.result = r;
    });
  }

  function reanalyze() {
    state.requestedFen = null;
    state.result = null;
  }

  function toggleEnabled() {
    state.enabled = !state.enabled;
    state.requestedFen = null;
    state.result = null;
    if (!state.enabled) clearOverlay();
    showToast(state.enabled ? "Trainer on" : "Trainer off", 900);
  }

  async function toggleStream() {
    if (state.stream) {
      state.stream = false;
      persistStream();
      closePipWindow();
      if (ui.streamBtn) ui.streamBtn.classList.remove("on");
      showToast("Stream mode off", 900);
      return;
    }
    const ok = await openPipWindow();
    if (!ok) return;
    state.stream = true;
    persistStream();
    clearOverlay();
    hidePanel();
    if (ui.streamBtn) ui.streamBtn.classList.add("on");
    if (lastPayload) renderPip(lastPayload);
    showToast("Stream mode on – share ONLY the chess.com window", 1800);
  }

  function cycleMode() {
    const keys = Object.keys(MODES);
    const i = keys.indexOf(settings.mode);
    settings.mode = keys[(i + 1) % keys.length];
    saveSettings();
    const panelBox = panel && panel.querySelector(".ct-settings");
    if (panelBox) {
      panelBox.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("sel", b.dataset.mode === settings.mode));
    }
    showToast("Mode: " + MODES[settings.mode].label, 1000);
  }

  document.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    if (e.altKey === CFG.hotkey.alt && k === CFG.hotkey.key) {
      toggleEnabled();
      return;
    }
    if (e.altKey === CFG.streamHotkey.alt && k === CFG.streamHotkey.key) {
      toggleStream();
      return;
    }
    if (e.altKey === CFG.modeHotkey.alt && k === CFG.modeHotkey.key) {
      cycleMode();
      return;
    }
  });

  setInterval(tick, CFG.pollMs);
  console.log("[Chess Trainer] loaded. Alt+X = on/off, Alt+S = stream mode, Alt+M = cycle mode. Mode:", settings.mode);

  setTimeout(() => {
    if (state.pendingStream && !state.stream) {
      showToast("Press Alt+S to re-enable stream mode", 2200);
    }
  }, 1500);
})();
