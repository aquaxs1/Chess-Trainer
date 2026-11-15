// Offscreen document: hosts Stockfish (WASM, single-thread, lite) in a worker
// and answers {type:"analyze", fen, movetime} with the best move.

const worker = new Worker("engine/stockfish-19-lite-single.js");

let ready = false;
let searching = false;
let current = null; // running job
let pending = null; // next job

function send(cmd) {
  worker.postMessage(cmd);
}

function parseInfo(line, job) {
  // z.B. "info depth 14 ... multipv 2 score cp 22 ... pv b1c3 b8c6"
  const d = line.match(/\bdepth (\d+)/);
  const k = line.match(/\bmultipv (\d+)/);
  const cp = line.match(/\bscore cp (-?\d+)/);
  const mate = line.match(/\bscore mate (-?\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  if (!d || !pv || (!cp && !mate)) return;
  const idx = k ? +k[1] - 1 : 0;
  const entry = {
    move: pv[1].split(" ")[0],
    score: cp ? { cp: +cp[1] } : { mate: +mate[1] },
    pv: pv[1].split(" ").slice(0, 6),
    depth: +d[1],
  };
  job.lines = job.lines || [];
  job.lines[idx] = entry;
  if (idx === 0) {
    job.depth = entry.depth;
    job.score = entry.score;
    job.pv = entry.pv;
  }
}

function startNext() {
  if (!ready || searching || !pending) return;
  current = pending;
  pending = null;
  searching = true;
  send("setoption name MultiPV value " + (current.multipv || 1));
  send("position fen " + current.fen);
  send("go movetime " + current.movetime);
}

worker.onmessage = (e) => {
  const line = typeof e.data === "string" ? e.data : e.data && e.data.data ? e.data.data : "";
  if (!line) return;

  if (line === "uciok") {
    send("setoption name Skill Level value 20");
    send("isready");
  } else if (line === "readyok") {
    if (!ready) {
      ready = true;
      startNext();
    }
  } else if (line.startsWith("info ") && current && searching) {
    parseInfo(line, current);
  } else if (line.startsWith("bestmove")) {
    const move = line.split(" ")[1];
    searching = false;
    const job = current;
    current = null;
    if (job && !job.stale) {
      job.respond({
        ok: true,
        fen: job.fen,
        bestmove: move && move !== "(none)" ? move : null,
        score: job.score || null,
        depth: job.depth || 0,
        pv: job.pv || [],
        lines: (job.lines || []).filter(Boolean),
      });
    }
    startNext();
  }
};

worker.onerror = (err) => console.error("[Chess Trainer] Engine error", err.message || err);

send("uci");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "analyze") return false;

  // Discard stale requests
  if (pending) pending.respond({ ok: false, superseded: true });
  if (current && !current.stale) {
    current.stale = true;
    current.respond({ ok: false, superseded: true });
    send("stop");
  }

  pending = { fen: msg.fen, movetime: msg.movetime || 800, multipv: msg.multipv || 1, respond: sendResponse };
  startNext();
  return true; // async
});
