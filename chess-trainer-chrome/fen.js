// Pure logic: chess.com DOM pieces -> FEN. No DOM access so it is Node-testable.
// grid[rank-1][file-1] = "P" | "p" | ... | null   (uppercase = white)

(function (root) {
  const START_PLACEMENT = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

  // pieces: [{ c: "w"|"b", t: "p"|"n"|"b"|"r"|"q"|"k", file: 1-8, rank: 1-8 }]
  function gridFromPieces(pieces) {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (const p of pieces) {
      if (p.file < 1 || p.file > 8 || p.rank < 1 || p.rank > 8) continue;
      grid[p.rank - 1][p.file - 1] = p.c === "w" ? p.t.toUpperCase() : p.t.toLowerCase();
    }
    return grid;
  }

  function placement(grid) {
    const rows = [];
    for (let r = 7; r >= 0; r--) {
      let row = "";
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const sq = grid[r][f];
        if (!sq) {
          empty++;
        } else {
          if (empty) row += empty;
          empty = 0;
          row += sq;
        }
      }
      if (empty) row += empty;
      rows.push(row);
    }
    return rows.join("/");
  }

  const isWhite = (sq) => sq && sq === sq.toUpperCase();
  const colorOf = (sq) => (sq ? (isWhite(sq) ? "w" : "b") : null);
  const other = (c) => (c === "w" ? "b" : "w");

  // Diff two positions to decide who just moved (and whether it was a double pawn step).
  // Returns { mover: "w"|"b"|null, ep: "e3"|"-" }.
  function detectMove(prev, cur) {
    if (!prev) return { mover: null, ep: "-" };
    const filled = []; // squares that now hold a different piece
    const emptied = []; // squares that used to hold something and are now empty
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (prev[r][f] === cur[r][f]) continue;
        if (cur[r][f]) filled.push({ r, f, sq: cur[r][f] });
        else emptied.push({ r, f, sq: prev[r][f] });
      }
    }
    if (!filled.length || filled.length > 2 || emptied.length > 3) return { mover: null, ep: "-" };
    const colors = new Set(filled.map((x) => colorOf(x.sq)));
    if (colors.size !== 1) return { mover: null, ep: "-" };
    const mover = [...colors][0];

    // En passant target square: a pawn moved two steps forward.
    let ep = "-";
    if (filled.length === 1 && emptied.length >= 1) {
      const to = filled[0];
      const pawn = mover === "w" ? "P" : "p";
      if (to.sq === pawn) {
        const fromRank = mover === "w" ? 1 : 6;
        const toRank = mover === "w" ? 3 : 4;
        const from = emptied.find((e) => e.f === to.f && e.r === fromRank && e.sq === pawn);
        if (from && to.r === toRank) {
          ep = "abcdefgh"[to.f] + (mover === "w" ? 3 : 6);
        }
      }
    }
    return { mover, ep };
  }

  // Fallback: last-move highlight squares (pale yellow). The occupied one is the target.
  // squares: [{file, rank}]
  function moverFromHighlights(grid, squares) {
    const colors = new Set();
    for (const s of squares) {
      const sq = grid[s.rank - 1] && grid[s.rank - 1][s.file - 1];
      if (sq) colors.add(colorOf(sq));
    }
    return colors.size === 1 ? [...colors][0] : null;
  }

  // Castling rights can only be lost, never regained.
  function updateCastling(rights, grid) {
    return {
      K: rights.K && grid[0][4] === "K" && grid[0][7] === "R",
      Q: rights.Q && grid[0][4] === "K" && grid[0][0] === "R",
      k: rights.k && grid[7][4] === "k" && grid[7][7] === "r",
      q: rights.q && grid[7][4] === "k" && grid[7][0] === "r",
    };
  }

  function castlingString(r) {
    const s = (r.K ? "K" : "") + (r.Q ? "Q" : "") + (r.k ? "k" : "") + (r.q ? "q" : "");
    return s || "-";
  }

  function buildFen(grid, turn, rights, ep) {
    return [placement(grid), turn, castlingString(rights), ep || "-", "0", "1"].join(" ");
  }


  // ---------- Notation & position info ----------
  const SAN_LETTER = { k: "K", q: "Q", r: "R", b: "B", n: "N", p: "" };
  const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const idx = (s) => ({ f: s.charCodeAt(0) - 97, r: +s[1] - 1 });
  const clone = (g) => g.map((row) => row.slice());

  function applyUci(grid, uci) {
    const g = clone(grid);
    const a = idx(uci.slice(0, 2)), b = idx(uci.slice(2, 4));
    const pc = g[a.r][a.f];
    if (!pc) return g;
    const t = pc.toLowerCase();
    if (t === "p" && a.f !== b.f && !g[b.r][b.f]) g[a.r][b.f] = null; // en passant
    if (t === "k" && Math.abs(b.f - a.f) === 2) {
      if (b.f === 6) { g[a.r][5] = g[a.r][7]; g[a.r][7] = null; }
      else { g[a.r][3] = g[a.r][0]; g[a.r][0] = null; }
    }
    g[b.r][b.f] = uci[4] ? (isWhite(pc) ? uci[4].toUpperCase() : uci[4]) : pc;
    g[a.r][a.f] = null;
    return g;
  }

  function toSan(grid, uci) {
    const a = idx(uci.slice(0, 2)), b = idx(uci.slice(2, 4));
    const pc = grid[a.r] && grid[a.r][a.f];
    if (!pc) return uci;
    const t = pc.toLowerCase();
    if (t === "k" && Math.abs(b.f - a.f) === 2) return b.f === 6 ? "O-O" : "O-O-O";
    const capture = !!grid[b.r][b.f] || (t === "p" && a.f !== b.f);
    let s = t === "p" ? (capture ? uci[0] : "") : SAN_LETTER[t];
    if (capture) s += "x";
    s += uci.slice(2, 4);
    if (uci[4]) s += "=" + SAN_LETTER[uci[4]];
    return s;
  }

  // Returns the piece character at the "from" square of a UCI move, e.g. "N" or "p".
  function pieceAt(grid, uci) {
    const a = idx(uci.slice(0, 2));
    return (grid[a.r] && grid[a.r][a.f]) || null;
  }

  // Variation as "1. Nf3 Nc6 2. Bb5" (or "1… Nc6 2. Bb5" when Black starts).
  function pvLine(grid, pv, turn, max) {
    let g = grid, side = turn, n = 1, out = [];
    pv.slice(0, max || 8).forEach((m, i) => {
      const san = toSan(g, m);
      if (side === "w") out.push(n + ". " + san);
      else out.push(i === 0 ? n + "… " + san : san);
      if (side === "b") n++;
      g = applyUci(g, m);
      side = other(side);
    });
    return out.join(" ");
  }

  // Material from White's perspective (positive = White is up).
  function material(grid) {
    let w = 0, b = 0;
    for (const row of grid) for (const sq of row) {
      if (!sq) continue;
      if (isWhite(sq)) w += VAL[sq.toLowerCase()]; else b += VAL[sq];
    }
    return w - b;
  }

  function phase(grid) {
    let heavy = 0, queens = 0;
    for (const row of grid) for (const sq of row) {
      if (!sq) continue;
      const t = sq.toLowerCase();
      if (t !== "p" && t !== "k") heavy += VAL[t];
      if (t === "q") queens++;
    }
    if (heavy >= 56) return "Opening";
    if (heavy <= 26 || (queens === 0 && heavy <= 34)) return "Endgame";
    return "Middlegame";
  }


  // Does color "by" attack square (r,f)?
  function attacks(grid, r, f, by) {
    const own = (sq) => sq && colorOf(sq) === by;
    const at = (rr, ff) => (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 ? grid[rr][ff] : undefined);
    const dir = by === "w" ? -1 : 1; // Pawn of "by" sits one rank behind.
    for (const df of [-1, 1]) {
      const sq = at(r + dir, f + df);
      if (own(sq) && sq.toLowerCase() === "p") return true;
    }
    for (const [dr, df] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]) {
      const sq = at(r + dr, f + df);
      if (own(sq) && sq.toLowerCase() === "n") return true;
    }
    for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
      if (!dr && !df) continue;
      const sq = at(r + dr, f + df);
      if (own(sq) && sq.toLowerCase() === "k") return true;
      const diag = dr && df;
      let rr = r + dr, ff = f + df;
      while (at(rr, ff) !== undefined) {
        const s2 = grid[rr][ff];
        if (s2) {
          const t2 = s2.toLowerCase();
          if (own(s2) && (t2 === "q" || (diag ? t2 === "b" : t2 === "r"))) return true;
          break;
        }
        rr += dr; ff += df;
      }
    }
    return false;
  }

  function kingSquare(grid, c) {
    const k = c === "w" ? "K" : "k";
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) if (grid[r][f] === k) return { r, f };
    return null;
  }

  function givesCheck(grid, uci) {
    const a = idx(uci.slice(0, 2));
    const pc = grid[a.r][a.f];
    if (!pc) return false;
    const me = colorOf(pc);
    const g = applyUci(grid, uci);
    const k = kingSquare(g, other(me));
    return !!k && attacks(g, k.r, k.f, me);
  }

  // How "aggressive" is a move? (Captures, checks, pressure on the king, advance.)
  function aggression(grid, uci) {
    const a = idx(uci.slice(0, 2)), b = idx(uci.slice(2, 4));
    const pc = grid[a.r][a.f];
    if (!pc) return 0;
    const me = colorOf(pc), t = pc.toLowerCase();
    let s = 0;
    const victim = grid[b.r][b.f];
    if (victim) s += VAL[victim.toLowerCase()] * 0.8;
    else if (t === "p" && a.f !== b.f) s += 0.8; // en passant
    if (givesCheck(grid, uci)) s += 2;
    const ek = kingSquare(grid, other(me));
    if (ek) {
      const before = Math.max(Math.abs(a.r - ek.r), Math.abs(a.f - ek.f));
      const after = Math.max(Math.abs(b.r - ek.r), Math.abs(b.f - ek.f));
      if (t !== "k") s += Math.max(0, before - after) * 0.35 + (after <= 2 ? 0.6 : 0);
    }
    const forward = me === "w" ? b.r - a.r : a.r - b.r;
    if (forward > 0 && t !== "k") s += forward * 0.15;
    const enemyHalf = me === "w" ? b.r >= 4 : b.r <= 3;
    if (enemyHalf && t !== "k") s += 0.4;
    if (t === "k" && Math.abs(b.f - a.f) !== 2) s -= 0.5; // king moves are usually passive
    if (uci[4]) s += 3;
    return s;
  }

  const api = {
    givesCheck,
    aggression,
    applyUci,
    toSan,
    pieceAt,
    pvLine,
    material,
    phase,
    START_PLACEMENT,
    gridFromPieces,
    placement,
    detectMove,
    moverFromHighlights,
    updateCastling,
    castlingString,
    buildFen,
    other,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ChessFen = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
