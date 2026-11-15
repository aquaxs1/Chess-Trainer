// Chess Trainer – content script for chess.com
// Loop: read board -> build FEN -> ask Stockfish -> paint arrow + HUD.
// Runs on every chess.com board: bots, live, online, analysis.

(() => {
  if (window.__chessTrainerLoaded) return;
  window.__chessTrainerLoaded = true;

  const CFG = {
    movetimeMs: 800,
    pollMs: 250,
    hotkey: { alt: true, key: "x" },        // on/off
    streamHotkey: { alt: true, key: "s" },  // stream-safe mode (PiP window)
    storageKey: "ct.stream",
  };

  const ALL_RIGHTS = { K: true, Q: true, k: true, q: true };
  const state = {
    enabled: true,
    stream: false,          // true = render in PiP window, hide main-page UI
    pendingStream: false,   // persisted preference waiting for a user gesture
    placement: null,
    prevGrid: null,
    turn: "w",
    ep: "-",
    castling: { ...ALL_RIGHTS },
    requestedFen: null,
    best: null, // { fen, from, to }
    lastScore: null,
    lastDepth: 0,
    warnedNoBoard: false,
  };

  // Persisted stream-mode preference (survives reload). PiP itself still needs
  // a user gesture to open; we flag "pending" and open on the first Alt+S press.
  try {
    if (chrome && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get([CFG.storageKey], (res) => {
        if (res && res[CFG.storageKey] === true) state.pendingStream = true;
      });
    }
  } catch (_) {}

  function persistStream() {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ [CFG.storageKey]: !!state.stream });
      }
    } catch (_) {}
  }

  // ---------- Read board ----------
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
      let c = null;
      let t = null;
      for (const cls of el.classList) {
        const m = /^([wb])([pnbrqk])$/.exec(cls);
        if (m) {
          c = m[1];
          t = m[2];
        }
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

  // ---------- Overlay ----------
  const SVG_NS = "http://www.w3.org/2000/svg";
  const DEFS_ID = "ct-defs";

  let overlaySvg = null;

  function ensureOverlay(board) {
    let svg = overlaySvg;
    if (!svg || !svg.isConnected) {
      svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "chess-trainer");
      svg.setAttribute("viewBox", "0 0 800 800");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.style.cssText =
        "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;overflow:visible;";

      // One-time defs: wood-tone gradient + soft shadow (built via DOM, no innerHTML)
      const defs = document.createElementNS(SVG_NS, "defs");
      defs.setAttribute("id", DEFS_ID);
      const grad = document.createElementNS(SVG_NS, "linearGradient");
      grad.setAttribute("id", "ct-grad");
      grad.setAttribute("x1", "0%"); grad.setAttribute("y1", "0%");
      grad.setAttribute("x2", "100%"); grad.setAttribute("y2", "0%");
      const stops = [
        ["0%", "#8b5a2b", "0.95"],   // oak
        ["100%", "#5a3317", "0.95"], // walnut
      ];
      for (const [o, c, op] of stops) {
        const s = document.createElementNS(SVG_NS, "stop");
        s.setAttribute("offset", o);
        s.setAttribute("stop-color", c);
        s.setAttribute("stop-opacity", op);
        grad.appendChild(s);
      }
      defs.appendChild(grad);

      const filter = document.createElementNS(SVG_NS, "filter");
      filter.setAttribute("id", "ct-glow");
      filter.setAttribute("x", "-50%"); filter.setAttribute("y", "-50%");
      filter.setAttribute("width", "200%"); filter.setAttribute("height", "200%");
      const blur = document.createElementNS(SVG_NS, "feGaussianBlur");
      blur.setAttribute("stdDeviation", "3");
      blur.setAttribute("result", "blur");
      const merge = document.createElementNS(SVG_NS, "feMerge");
      const mBlur = document.createElementNS(SVG_NS, "feMergeNode");
      mBlur.setAttribute("in", "blur");
      const mSrc = document.createElementNS(SVG_NS, "feMergeNode");
      mSrc.setAttribute("in", "SourceGraphic");
      merge.append(mBlur, mSrc);
      filter.append(blur, merge);
      defs.appendChild(filter);

      svg.appendChild(defs);
      document.documentElement.appendChild(svg);
      overlaySvg = svg;
    }
    return svg;
  }

  function positionOverlay(board) {
    if (!overlaySvg) return;
    const r = board.getBoundingClientRect();
    if (!r.width) return;
    overlaySvg.style.left = r.left + "px";
    overlaySvg.style.top = r.top + "px";
    overlaySvg.style.width = r.width + "px";
    overlaySvg.style.height = r.height + "px";
  }

  function center(file, rank, flipped) {
    const x = flipped ? 8 - file + 0.5 : file - 0.5;
    const y = flipped ? rank - 0.5 : 8 - rank + 0.5;
    return { x: x * 100, y: y * 100 };
  }

  function drawArrow(board, flipped, best) {
    const svg = ensureOverlay(board);
    positionOverlay(board);
    // Keep defs, wipe the rest
    [...svg.children].forEach((c) => {
      if (c.id !== DEFS_ID) svg.removeChild(c);
    });
    if (!best) return;

    const a = center(best.from.file, best.from.rank, flipped);
    const b = center(best.to.file, best.to.rank, flipped);

    // Origin square — soft dashed cream ring
    const originRing = document.createElementNS(SVG_NS, "circle");
    originRing.setAttribute("cx", a.x);
    originRing.setAttribute("cy", a.y);
    originRing.setAttribute("r", 44);
    originRing.setAttribute("fill", "none");
    originRing.setAttribute("stroke", "#f0d9b5");
    originRing.setAttribute("stroke-width", 4);
    originRing.setAttribute("stroke-dasharray", "6 8");
    originRing.setAttribute("stroke-opacity", "0.9");
    svg.appendChild(originRing);

    // Target square — pulsing burnt-sienna ring
    const targetRing = document.createElementNS(SVG_NS, "circle");
    targetRing.setAttribute("cx", b.x);
    targetRing.setAttribute("cy", b.y);
    targetRing.setAttribute("r", 46);
    targetRing.setAttribute("fill", "none");
    targetRing.setAttribute("stroke", "#8b5a2b");
    targetRing.setAttribute("stroke-width", 6);
    targetRing.setAttribute("stroke-opacity", "0.95");
    const pulse = document.createElementNS(SVG_NS, "animate");
    pulse.setAttribute("attributeName", "r");
    pulse.setAttribute("values", "44;50;44");
    pulse.setAttribute("dur", "1.6s");
    pulse.setAttribute("repeatCount", "indefinite");
    targetRing.appendChild(pulse);
    svg.appendChild(targetRing);

    // Arrow body — gradient, rounded, with glow
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const head = 38;
    const inset = 44;
    const startX = a.x + ux * inset;
    const startY = a.y + uy * inset;
    const endX = b.x - ux * inset;
    const endY = b.y - uy * inset;

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", startX);
    line.setAttribute("y1", startY);
    line.setAttribute("x2", endX - ux * head * 0.55);
    line.setAttribute("y2", endY - uy * head * 0.55);
    line.setAttribute("stroke", "url(#ct-grad)");
    line.setAttribute("stroke-width", 18);
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-opacity", "0.92");
    svg.appendChild(line);

    const poly = document.createElementNS(SVG_NS, "polygon");
    const px = -uy;
    const py = ux;
    const pts = [
      [endX, endY],
      [endX - ux * head + px * head * 0.75, endY - uy * head + py * head * 0.75],
      [endX - ux * head - px * head * 0.75, endY - uy * head - py * head * 0.75],
    ];
    poly.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
    poly.setAttribute("fill", "#5a3317");
    poly.setAttribute("fill-opacity", "0.95");
    svg.appendChild(poly);
  }

  function clearOverlay() {
    if (!overlaySvg) return;
    [...overlaySvg.children].forEach((c) => {
      if (c.id !== DEFS_ID) overlaySvg.removeChild(c);
    });
  }

  // ---------- HUD ----------
  let hud = null;
  let hudEls = null;

  function ensureStyle() {
    if (document.getElementById("ct-style")) return;
    const style = document.createElement("style");
    style.id = "ct-style";
    style.textContent = `
      @keyframes ct-fadein { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
      @keyframes ct-spin { to { transform:rotate(360deg) } }
      .ct-hud {
        position:fixed; left:0; top:0; z-index:2147483647;
        display:flex; align-items:center; gap:10px;
        padding:10px 16px 12px; border-radius:6px;
        background: linear-gradient(135deg, #f0d9b5 0%, #e3c69a 100%);
        color:#3b2415;
        font: 600 13px/1.3 "Georgia", "Palatino Linotype", "Book Antiqua", serif;
        letter-spacing:0.2px;
        border:1px solid #6b4423;
        box-shadow:
          0 6px 16px rgba(60, 35, 15, 0.35),
          inset 0 1px 0 rgba(255,245,220,0.6),
          inset 0 -1px 0 rgba(90,51,23,0.15);
        pointer-events:none;
        animation: ct-fadein 220ms ease-out;
        max-width: 520px;
        transition: opacity 180ms ease;
      }
      .ct-hud__dot {
        width:10px; height:10px; border-radius:50%;
        background: radial-gradient(circle at 30% 30%, #a67b4d, #5a3317);
        box-shadow: 0 0 0 1px rgba(60,35,15,0.4), inset 0 1px 1px rgba(255,235,200,0.4);
        flex-shrink:0;
      }
      .ct-hud__dot--wait {
        background: conic-gradient(from 0deg, #8b5a2b, transparent 70%);
        animation: ct-spin 0.9s linear infinite;
        box-shadow: 0 0 0 1px rgba(60,35,15,0.4);
      }
      .ct-hud__dot--idle {
        background: #c9a876;
        box-shadow: 0 0 0 1px rgba(60,35,15,0.35);
      }
      .ct-hud__dot--err {
        background: radial-gradient(circle at 30% 30%, #d97b5a, #8b2a1a);
        box-shadow: 0 0 0 1px rgba(60,35,15,0.4);
      }
      .ct-hud__main {
        display:flex; flex-direction:column; gap:3px; min-width:0;
        padding-bottom:1px;
      }
      .ct-hud__title {
        font-size:10px; font-weight:700; text-transform:uppercase;
        letter-spacing:1.4px; color:#6b4423;
        font-family: "Georgia", "Palatino Linotype", serif;
        line-height:1.1;
      }
      .ct-hud__move {
        font: 700 15px/1.4 "Georgia", "Palatino Linotype", serif;
        color:#2d1a0e;
        padding-bottom:1px;
      }
      .ct-hud__move .ct-arrow { color:#8b5a2b; margin:0 6px; font-weight:400; }
      .ct-hud__mate {
        display:none;
        margin-top:4px;
        padding:4px 8px; border-radius:4px;
        font: 700 11px/1.2 "Georgia", "Palatino Linotype", serif;
        letter-spacing:0.6px; text-transform:uppercase;
        background: linear-gradient(90deg, #f0c878 0%, #d9a85a 100%);
        border:1px solid #8b5a1a;
        color:#3d2817;
        box-shadow: inset 0 1px 0 rgba(255,250,235,0.7);
      }
      .ct-hud__mate--show { display:inline-block; }
      .ct-hud__meta {
        display:flex; gap:6px; margin-left:auto; flex-shrink:0;
      }
      .ct-hud__chip {
        padding:3px 8px; border-radius:4px;
        font: 700 11px/1 "Georgia", "Palatino Linotype", serif;
        background: #f5e6c8;
        border:1px solid #8b6f47;
        color:#5a3317;
        white-space:nowrap;
        box-shadow: inset 0 1px 0 rgba(255,250,235,0.7);
      }
      .ct-hud__chip--score-pos { background:#e8dab0; border-color:#6b4423; color:#3d2817; }
      .ct-hud__chip--score-neg { background:#e8c8b0; border-color:#8b4423; color:#5a2317; }
      .ct-hud__chip--mate     { background:#f0c878; border-color:#8b5a1a; color:#3d2817; }
      .ct-hud--off {
        background: linear-gradient(135deg, #d4c4a8 0%, #c9b896 100%);
        border-color: #8b6f47;
        opacity:0.85;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function buildHud() {
    ensureStyle();
    const el = document.createElement("div");
    el.className = "ct-hud";

    const dot = document.createElement("span");
    dot.className = "ct-hud__dot ct-hud__dot--idle";

    const main = document.createElement("div");
    main.className = "ct-hud__main";
    const title = document.createElement("span");
    title.className = "ct-hud__title";
    title.textContent = "Chess Trainer";
    const move = document.createElement("span");
    move.className = "ct-hud__move";
    move.textContent = "Waiting for board…";
    const mate = document.createElement("span");
    mate.className = "ct-hud__mate";
    main.append(title, move, mate);

    const meta = document.createElement("div");
    meta.className = "ct-hud__meta";

    el.append(dot, main, meta);
    document.documentElement.appendChild(el);
    hud = el;
    hudEls = { root: el, dot, title, move, mate, meta };
  }

  function positionHud(board) {
    if (!hud) return;
    const r = board.getBoundingClientRect();
    if (!r.width) return;
    const hw = hud.offsetWidth || 0;
    const hh = hud.offsetHeight || 0;
    // Centered horizontally over the board; floats just above the top edge,
    // but if there's no room, drop inside the board over rank 8.
    const cx = r.left + r.width / 2;
    const above = r.top - hh - 10;
    const inside = r.top + 8;
    const top = above >= 8 ? above : inside;
    hud.style.left = Math.round(cx - hw / 2) + "px";
    hud.style.top = Math.round(top) + "px";
    hud.style.transform = "none";
  }

  function setHudState({ status = "idle", title = "Chess Trainer", move = "", moveParts = null, chips = [], mateIn = null, hidden = false } = {}) {
    lastHudState = { status, title, move, moveParts, chips, mateIn };
    // In stream mode, the page never shows the HUD — PiP is the only surface.
    if (state.stream) {
      if (hud) hud.style.display = "none";
      renderPipHud(lastHudState);
      return;
    }
    if (!hud) buildHud();
    hud.style.display = hidden ? "none" : "flex";
    hud.classList.toggle("ct-hud--off", status === "off");
    hudEls.dot.className = "ct-hud__dot";
    if (status === "wait") hudEls.dot.classList.add("ct-hud__dot--wait");
    else if (status === "idle" || status === "off") hudEls.dot.classList.add("ct-hud__dot--idle");
    else if (status === "err") hudEls.dot.classList.add("ct-hud__dot--err");
    hudEls.title.textContent = title;
    hudEls.move.replaceChildren();
    if (moveParts) {
      const from = document.createElement("span");
      from.textContent = moveParts.from;
      const arrow = document.createElement("span");
      arrow.className = "ct-arrow";
      arrow.textContent = "→";
      const to = document.createElement("span");
      to.textContent = moveParts.to;
      hudEls.move.append(from, arrow, to);
    } else {
      hudEls.move.textContent = move || " ";
    }
    if (mateIn && Number.isFinite(mateIn.n) && mateIn.n !== 0) {
      const n = Math.abs(mateIn.n);
      const forYou = mateIn.n > 0;
      hudEls.mate.textContent = forYou
        ? `${n} ${n === 1 ? "move" : "moves"} to checkmate`
        : `Checkmate against you in ${n}`;
      hudEls.mate.classList.add("ct-hud__mate--show");
    } else {
      hudEls.mate.textContent = "";
      hudEls.mate.classList.remove("ct-hud__mate--show");
    }
    hudEls.meta.replaceChildren();
    for (const chip of chips) {
      const c = document.createElement("span");
      c.className = "ct-hud__chip" + (chip.cls ? " " + chip.cls : "");
      c.textContent = chip.text;
      hudEls.meta.appendChild(c);
    }
  }

  function hideHud() {
    if (hud) hud.style.display = "none";
  }

  // ---------- Picture-in-Picture (stream-safe) ----------
  let pipWindow = null;
  let pipEls = null;
  let lastHudState = null; // remember the last payload so we can re-render into PiP

  function pipSupported() {
    return typeof window !== "undefined" && "documentPictureInPicture" in window;
  }

  async function openPipHud() {
    if (!pipSupported()) return false;
    if (pipWindow) return true;
    try {
      pipWindow = await window.documentPictureInPicture.requestWindow({
        width: 320,
        height: 120,
        disallowReturnToOpener: true,
      });
    } catch (e) {
      console.warn("[Chess Trainer] PiP open failed:", e);
      pipWindow = null;
      return false;
    }

    const doc = pipWindow.document;
    doc.title = "Chess Trainer";

    const style = doc.createElement("style");
    style.textContent = `
      :root { color-scheme: light; }
      html, body {
        margin:0; padding:0; height:100%; width:100%;
        background: linear-gradient(135deg, #f0d9b5 0%, #e3c69a 100%);
        color:#3b2415;
        font: 600 14px/1.3 "Georgia","Palatino Linotype","Book Antiqua",serif;
        overflow:hidden;
      }
      @keyframes ct-spin { to { transform:rotate(360deg) } }
      .wrap {
        display:flex; align-items:center; gap:12px;
        padding:14px 18px; height:100%; box-sizing:border-box;
        border-top:1px solid rgba(255,245,220,0.6);
        border-bottom:2px solid #6b4423;
      }
      .dot { width:12px; height:12px; border-radius:50%;
        background: radial-gradient(circle at 30% 30%, #a67b4d, #5a3317);
        box-shadow: 0 0 0 1px rgba(60,35,15,0.4), inset 0 1px 1px rgba(255,235,200,0.4);
        flex-shrink:0;
      }
      .dot.wait { background: conic-gradient(from 0deg, #8b5a2b, transparent 70%); animation: ct-spin 0.9s linear infinite; }
      .dot.idle { background:#c9a876; }
      .dot.err  { background: radial-gradient(circle at 30% 30%, #d97b5a, #8b2a1a); }
      .main { display:flex; flex-direction:column; gap:3px; min-width:0; flex:1; }
      .title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:#6b4423; }
      .move { font: 700 20px/1.3 "Georgia","Palatino Linotype",serif; color:#2d1a0e; }
      .move .ar { color:#8b5a2b; margin:0 8px; font-weight:400; }
      .mate { display:none; margin-top:4px;
        padding:4px 8px; border-radius:4px;
        font: 700 11px/1.2 "Georgia","Palatino Linotype",serif;
        letter-spacing:0.6px; text-transform:uppercase;
        background: linear-gradient(90deg, #f0c878 0%, #d9a85a 100%);
        border:1px solid #8b5a1a; color:#3d2817;
        box-shadow: inset 0 1px 0 rgba(255,250,235,0.7);
      }
      .mate.show { display:inline-block; }
      .chips { display:flex; flex-direction:column; gap:4px; align-items:flex-end; }
      .chip {
        padding:3px 8px; border-radius:4px;
        font: 700 11px/1 "Georgia","Palatino Linotype",serif;
        background:#f5e6c8; border:1px solid #8b6f47; color:#5a3317;
        white-space:nowrap;
        box-shadow: inset 0 1px 0 rgba(255,250,235,0.7);
      }
      .chip.pos { background:#e8dab0; border-color:#6b4423; color:#3d2817; }
      .chip.neg { background:#e8c8b0; border-color:#8b4423; color:#5a2317; }
      .chip.mt  { background:#f0c878; border-color:#8b5a1a; color:#3d2817; }
    `;
    doc.head.appendChild(style);

    const wrap = doc.createElement("div"); wrap.className = "wrap";
    const dot = doc.createElement("span"); dot.className = "dot idle";
    const main = doc.createElement("div"); main.className = "main";
    const title = doc.createElement("div"); title.className = "title"; title.textContent = "Chess Trainer";
    const move = doc.createElement("div"); move.className = "move"; move.textContent = "Waiting for board…";
    const mate = doc.createElement("div"); mate.className = "mate";
    main.append(title, move, mate);
    const chips = doc.createElement("div"); chips.className = "chips";
    wrap.append(dot, main, chips);
    doc.body.append(wrap);

    pipEls = { doc, dot, title, move, mate, chips };

    pipWindow.addEventListener("pagehide", () => {
      pipWindow = null;
      pipEls = null;
      // User closed the PiP window — exit stream mode so the main HUD comes back.
      if (state.stream) {
        state.stream = false;
        persistStream();
      }
    });

    if (lastHudState) renderPipHud(lastHudState);
    return true;
  }

  function closePipHud() {
    if (pipWindow) {
      try { pipWindow.close(); } catch (_) {}
    }
    pipWindow = null;
    pipEls = null;
  }

  function renderPipHud(payload) {
    if (!pipEls) return;
    const { status = "idle", title = "Chess Trainer", move = "", moveParts = null, chips = [], mateIn = null } = payload;
    pipEls.dot.className = "dot " + (status === "wait" ? "wait" : status === "err" ? "err" : status === "ok" ? "" : "idle");
    pipEls.title.textContent = title;
    pipEls.move.replaceChildren();
    if (moveParts) {
      const f = pipEls.doc.createElement("span"); f.textContent = moveParts.from;
      const a = pipEls.doc.createElement("span"); a.className = "ar"; a.textContent = "→";
      const t = pipEls.doc.createElement("span"); t.textContent = moveParts.to;
      pipEls.move.append(f, a, t);
    } else {
      pipEls.move.textContent = move || " ";
    }
    if (mateIn && Number.isFinite(mateIn.n) && mateIn.n !== 0) {
      const n = Math.abs(mateIn.n);
      pipEls.mate.textContent = mateIn.n > 0
        ? `${n} ${n === 1 ? "move" : "moves"} to checkmate`
        : `Checkmate against you in ${n}`;
      pipEls.mate.classList.add("show");
    } else {
      pipEls.mate.textContent = "";
      pipEls.mate.classList.remove("show");
    }
    pipEls.chips.replaceChildren();
    for (const c of chips) {
      const el = pipEls.doc.createElement("span");
      let cls = "chip";
      if (c.cls === "ct-hud__chip--score-pos") cls += " pos";
      else if (c.cls === "ct-hud__chip--score-neg") cls += " neg";
      else if (c.cls === "ct-hud__chip--mate") cls += " mt";
      el.className = cls;
      el.textContent = c.text;
      pipEls.chips.appendChild(el);
    }
  }

  function fmtScoreChip(s) {
    if (!s) return null;
    if (s.mate !== undefined) {
      return { text: "#" + Math.abs(s.mate) + (s.mate > 0 ? " ✓" : " ✗"), cls: "ct-hud__chip--mate" };
    }
    const v = (s.cp / 100).toFixed(2);
    const text = (s.cp > 0 ? "+" : "") + v;
    const cls = s.cp >= 0 ? "ct-hud__chip--score-pos" : "ct-hud__chip--score-neg";
    return { text, cls };
  }

  function renderBestHud(moveUci, score, depth) {
    const from = moveUci.slice(0, 2);
    const to = moveUci.slice(2, 4);
    const chips = [];
    const sc = fmtScoreChip(score);
    if (sc) chips.push(sc);
    if (depth) chips.push({ text: "d" + depth });
    const mateIn = score && score.mate !== undefined ? { n: score.mate } : null;
    setHudState({ status: "ok", title: "Best Move", moveParts: { from, to }, chips, mateIn });
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
    let res = await sendMsg({ type: "analyze", fen, movetime: CFG.movetimeMs });
    if (res && res.error) {
      await sendMsg({ type: "ensure-offscreen" });
      await new Promise((r) => setTimeout(r, 400));
      res = await sendMsg({ type: "analyze", fen, movetime: CFG.movetimeMs });
    }
    return res;
  }

  // ---------- Main loop ----------
  function resetGame() {
    state.castling = { ...ALL_RIGHTS };
    state.turn = "w";
    state.ep = "-";
    state.prevGrid = null;
    state.requestedFen = null;
    state.best = null;
  }

  function tick() {
    if (!state.enabled) {
      clearOverlay();
      return;
    }
    // In stream mode: never paint on the page (no arrow, no HUD). PiP window is
    // the only visible surface, so it's invisible to window/application capture.
    if (state.stream) {
      clearOverlay();
      hideHud();
    }
    const board = findBoard();
    if (!board) {
      if (!state.warnedNoBoard) {
        console.log("[Chess Trainer] No board found (wc-chess-board).");
        state.warnedNoBoard = true;
      }
      setHudState({ status: "idle", title: "Chess Trainer", move: "Waiting for board…" });
      return;
    }
    state.warnedNoBoard = false;
    if (!state.stream) {
      positionHud(board);
      positionOverlay(board);
    }

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
      state.best = null;
    }

    const fen = G.buildFen(grid, state.turn, state.castling, state.ep);

    if (state.turn !== me) {
      clearOverlay();
      setHudState({ status: "idle", title: "Chess Trainer", move: "Opponent to move…" });
      return;
    }

    if (state.best && state.best.fen === fen) {
      if (!state.stream) drawArrow(board, flipped, state.best);
      return;
    }

    clearOverlay();
    if (state.requestedFen === fen) return;
    state.requestedFen = fen;
    setHudState({ status: "wait", title: "Stockfish", move: "Thinking…" });

    analyze(fen).then((res) => {
      if (state.requestedFen !== fen) return;
      if (!res || res.superseded) return;
      if (!res.ok || !res.bestmove) {
        const msg = res && res.error ? "Engine error: " + res.error : "No move found (game over?)";
        setHudState({ status: "err", title: "Chess Trainer", move: msg });
        setTimeout(() => {
          if (state.requestedFen === fen) state.requestedFen = null;
        }, 2000);
        return;
      }
      const mv = res.bestmove;
      state.best = {
        fen,
        from: { file: mv.charCodeAt(0) - 96, rank: +mv[1] },
        to: { file: mv.charCodeAt(2) - 96, rank: +mv[3] },
      };
      state.lastScore = res.score;
      state.lastDepth = res.depth;
      renderBestHud(mv, res.score, res.depth);
    });
  }

  // Brief toast used when leaving stealth mode (so the user confirms it's off),
  // and when entering stealth (so they get visual confirmation BEFORE the UI vanishes).
  let toastEl = null;
  function showToast(text, ms = 1200) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.style.cssText =
        "position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483647;" +
        "padding:8px 14px;border-radius:6px;" +
        "background:linear-gradient(135deg,#f0d9b5,#e3c69a);color:#3b2415;" +
        'font:700 12px/1.3 "Georgia","Palatino Linotype",serif;letter-spacing:0.4px;' +
        "border:1px solid #6b4423;" +
        "box-shadow:0 6px 16px rgba(60,35,15,0.35),inset 0 1px 0 rgba(255,245,220,0.6);" +
        "pointer-events:none;opacity:0;transition:opacity 180ms ease;";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.style.opacity = "1";
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => {
      toastEl.style.opacity = "0";
    }, ms);
  }

  document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.altKey === CFG.hotkey.alt && k === CFG.hotkey.key) {
      state.enabled = !state.enabled;
      if (!state.enabled) {
        clearOverlay();
        setHudState({ status: "off", title: "Chess Trainer", move: "Off (Alt+X to enable)" });
        setTimeout(() => {
          if (!state.enabled) hideHud();
        }, 1500);
      } else {
        state.requestedFen = null;
        state.best = null;
        setHudState({ status: "idle", title: "Chess Trainer", move: "On" });
      }
      return;
    }
    if (e.altKey === CFG.streamHotkey.alt && k === CFG.streamHotkey.key) {
      if (state.stream) {
        // Turning stream mode OFF
        state.stream = false;
        persistStream();
        closePipHud();
        showToast("Chess Trainer: stream mode OFF", 1100);
      } else {
        // Turning stream mode ON — needs to happen inside this keydown's user gesture
        if (!pipSupported()) {
          showToast("Stream mode needs Chrome 116+ (PiP API)", 1600);
          return;
        }
        openPipHud().then((ok) => {
          if (!ok) {
            showToast("Could not open PiP window", 1600);
            return;
          }
          state.stream = true;
          persistStream();
          clearOverlay();
          hideHud();
          // Re-push the last known move to PiP so the user sees it instantly.
          if (lastHudState) renderPipHud(lastHudState);
          showToast("Chess Trainer: stream mode ON", 900);
        });
      }
      return;
    }
  });

  setInterval(tick, CFG.pollMs);
  console.log("[Chess Trainer] loaded. Alt+X = on/off, Alt+S = stream-safe PiP mode.");

  // If the user had stream mode enabled last session, hint them to press Alt+S
  // (PiP API requires a fresh user gesture after a page load).
  setTimeout(() => {
    if (state.pendingStream && !state.stream) {
      showToast("Press Alt+S to re-enable stream mode", 2200);
    }
  }, 1500);
})();
