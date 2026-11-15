# Chess Trainer (Chrome Extension)

Draws the best move on any Chess.com board — bots, live, online, analysis — as a glowing gradient arrow.
Flow: read board → build FEN → Stockfish 19 (local WASM) → paint arrow + HUD → repeat.

## Install
1. Unzip (keep the `ext` folder).
2. Chrome: `chrome://extensions` → top-right toggle "Developer mode" → "Load unpacked" → select the folder.
3. Start a game on chess.com (refresh the page if it was already open).

## Usage
- The arrow appears as soon as it's your turn. The HUD above the board shows the move, score, search depth and a mate counter when one exists.
- **Alt+X** — toggle the extension on/off.
- **Alt+S** — **stream-safe mode**: opens a small chromeless window (Chrome's Picture-in-Picture API) that shows the move, score, mate counter and status. The main page shows nothing — no arrow, no HUD — so capture tools that record your Chrome window / chess.com tab can't see any hint. Press Alt+S again (or close the PiP window) to turn it off. Setting persists across reloads (you have to press Alt+S once after a page load because Chrome requires a user gesture to open a PiP window).
- Strength / speed: `content.js` → `CFG.movetimeMs` (default 800 ms).

## Stream mode — how the invisibility actually works
Stream mode renders the overlay into a **separate OS-level window** (Chrome's `documentPictureInPicture` API). That window is a real browser window, not part of the chess.com page, so:

| Capture mode | Sees the PiP overlay? |
|---|---|
| OBS "Window Capture" of the Chrome window | **No** |
| OBS "Game Capture" | **No** |
| Discord "Share a window" / "Share an application" | **No** |
| Zoom "Share application" / Teams "Share a window" | **No** |
| YouTube Studio "Window capture" | **No** |
| OBS / Discord "Monitor Capture" / "Share entire screen" | **Yes** |

**The rule:** share the chess.com **window**, not your whole monitor. Then the overlay is on your screen but invisible to the stream. If you must share your entire display, position the PiP window outside the capture region, or just use Alt+X to toggle the extension off.

Requires Chrome 116+ (the Document Picture-in-Picture API).

## Visuals
- Classic wood palette — beige + brown to match the standard chess board.
- Gradient arrow (oak → walnut), dashed cream origin ring, pulsing walnut target ring.
- Parchment HUD with serif typography, a brass status dot (idle / thinking / ready / error) and beige chips for score and depth.

## Note
Using an engine against real opponents violates Chess.com rules and will get you banned.
Use at your own risk.
