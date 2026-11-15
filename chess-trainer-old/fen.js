// Pure logic: chess.com pieces -> FEN. No DOM access, so it's testable in Node.
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

  // Vergleicht zwei Stellungen und findet heraus, wer gezogen hat (und ob ein Doppelschritt war).
  // Gibt { mover: "w"|"b"|null, ep: "e3"|"-" } zurück.
  function detectMove(prev, cur) {
    if (!prev) return { mover: null, ep: "-" };
    const filled = []; // Felder, auf denen jetzt eine ANDERE Figur steht als vorher
    const emptied = []; // Felder, die vorher besetzt waren und jetzt leer sind
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

    // En passant-Feld: Bauer ging zwei Felder vor
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

  // Fallback: letzte Zug-Markierung (hellgelbe Felder). Das besetzte Feld ist das Zielfeld.
  // squares: [{file, rank}]
  function moverFromHighlights(grid, squares) {
    const colors = new Set();
    for (const s of squares) {
      const sq = grid[s.rank - 1] && grid[s.rank - 1][s.file - 1];
      if (sq) colors.add(colorOf(sq));
    }
    return colors.size === 1 ? [...colors][0] : null;
  }

  // Rochaderechte können nur verloren gehen, nie zurückkommen.
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

  const api = {
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
