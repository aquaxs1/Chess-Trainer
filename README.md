# Chess Trainer

A Chrome extension that paints the best move on any chess.com board — bots, humans, live, analysis — as a glowing arrow, with a side panel showing evaluation, material, suggested move and a mate counter. Local Stockfish 19 (WASM) runs the engine.

**[⬇ Download the latest release](https://github.com/aquaxs1/Chess-trainer/releases/latest/download/chess-trainer.zip)** — this link always resolves to the newest build.

Landing page: https://aquaxs1.github.io/Chess-trainer/

## Install

1. Download the zip from the link above and extract it to a folder you will keep.
2. Open `chrome://extensions`.
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select this folder.
5. Open a game on chess.com — refresh the tab if it was already open.

Minimum Chrome / Edge version: 116 (PiP API for stream mode).

## Hotkeys

| Key | Action |
|---|---|
| `Alt + X` | Toggle trainer on/off |
| `Alt + S` | Toggle stream mode (UI moves to a separate OS window) |
| `Alt + M` | Cycle mode: All / Bots / Humans |

## Settings panel

Click the gear icon in the panel header to open:

- **Mode** — where the trainer runs. `All` (default, every chess.com page with a board), `Bots` (only `/play/computer`), `Humans` (online, live, daily, analysis — everything except bots).
- **Play style** — Solid, Balanced, Aggressive, All-in. Controls how many centipawns the engine is allowed to sacrifice for more aggressive candidate moves.
- **Think time** — 0.3 s to 3.0 s per move.

Drag the panel header to move it. Double-click the header to snap it back above the board.

## Stream mode

`Alt + S` opens the trainer in a separate OS-level window (Chromium's `documentPictureInPicture` API). The on-page arrow and panel disappear; all info — best move, evaluation bar, material, mate counter — moves into the separate window.

Because that window is a distinct HWND and not part of the chess.com tab, window-capture tools don't see it:

| Capture mode | Sees the stream window? |
|---|---|
| OBS "Window Capture" of the chess.com window | **No** |
| OBS "Game Capture" | **No** |
| Discord "Share a window" / "Share an application" | **No** |
| Zoom / Teams "Share application" | **No** |
| YouTube Studio window capture | **No** |
| OBS "Display Capture" / full-screen screenshot | **Yes** |

Rule: share the chess.com **window**, not your whole monitor. If you must share your entire display, move the stream window outside the capture region, or use `Alt + X` to turn the trainer off.

## Visuals

- Parchment panel on a walnut-and-oak gradient, serif typography, brass accents.
- Best-move piece rendered as crisp inline SVG — vector icons that stay sharp at any zoom level.
- Green glowing arrow on the board with matching origin and target rings.
- Evaluation bar from Black (dark) to White (light), with a word rating ("Equal", "Good", "Great", …) and a mate counter when one exists.

## File layout

```
manifest.json          MV3 manifest, chess.com host match, storage permission
background.js          Service worker, keeps the offscreen Stockfish doc alive
offscreen.html         Shell that hosts the engine worker
offscreen.js           Stockfish controller — accepts {type: "analyze"} messages
content.js             Everything user-facing: board reader, overlay, panel, PiP
fen.js                 Pure logic: grid -> FEN, SAN, aggression heuristic, phase
engine/                Stockfish 19 lite single-thread WASM build
icons/                 Extension icons + logo
```

## Note

Using an engine against real opponents violates chess.com's rules and will get the account banned. Use at your own risk.
