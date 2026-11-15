// Offscreen document: hosts Stockfish (WASM, single-thread, lite) in a worker
// and answers {type:"analyze", fen, movetime} with the best move.

const worker = new Worker("engine/stockfish-19-lite-single.js");

let ready = false;
let searching = false;
let current = null; // laufender Job
let pending = null; // nächster Job

function send(cmd) {
  worker.postMessage(cmd);
}

function parseInfo(line, job) {
  // z.B. "info depth 14 ... score cp 22 ... pv b1c3 b8c6"
  const d = line.match(/\bdepth (\d+)/);
  const cp = line.match(/\bscore cp (-?\d+)/);
  const mate = line.match(/\bscore mate (-?\d+)/);
  const pv = line.match(/\bpv (.+)$/);
  if (!d) return;
  job.depth = +d[1];
  if (cp) job.score = { cp: +cp[1] };
  else if (mate) job.score = { mate: +mate[1] };
  if (pv) job.pv = pv[1].split(" ").slice(0, 6);
}

function startNext() {
  if (!ready || searching || !pending) return;
  current = pending;
  pending = null;
  searching = true;
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
      });
    }
    startNext();
  }
};

worker.onerror = (err) => console.error("[Schach-Trainer] Engine-Fehler", err.message || err);

send("uci");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "analyze") return false;

  // Alte Anfragen verwerfen
  if (pending) pending.respond({ ok: false, superseded: true });
  if (current && !current.stale) {
    current.stale = true;
    current.respond({ ok: false, superseded: true });
    send("stop");
  }

  pending = { fen: msg.fen, movetime: msg.movetime || 800, respond: sendResponse };
  startNext();
  return true; // async
});
