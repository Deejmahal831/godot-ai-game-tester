# Godot AI Game Tester

An MCP server that lets **any AI agent** (Claude Code, Codex, Cursor, Windsurf, ...) launch your
Godot project in a **real window — not headless** — and actually test it: see the game through
screenshots, play it with injected input, inspect the live scene tree, watch signals fire, read
errors from the console, and clean up after itself.

Works with **Godot 4.x** projects. No changes to your project are required — a small test bridge
is injected at launch and fully removed when the game stops.

## How it works

```
AI agent (Claude / Codex / ...)
        │  MCP (stdio)
        ▼
mcp-server (Node)  ──spawns──►  Godot (windowed, real rendering)
        │                            │
        └────── TCP (localhost) ─────┘
                 JSON commands into a temporarily-injected autoload
```

On `launch_game` the server copies `addon/ai_game_tester/ai_test_server.gd` into the project,
adds it as an autoload in `project.godot` (after backing it up), starts Godot, and **restores
`project.godot` the moment the game has booted**. On `stop_game` (or crash) the addon files are
deleted too — your project is left byte-for-byte identical.

## Setup

Requirements: Node.js 18+, a Godot 4.x executable.

```
cd mcp-server
npm install
```

Tell the server where Godot lives with the `GODOT_PATH` environment variable (or pass
`godot_path` to `launch_game`, or let it auto-detect common locations). On Windows, prefer the
`_console.exe` build — its stdout/stderr capture is the most reliable, which is what powers
error reporting.

### Claude Code

```
claude mcp add godot-game-tester --env GODOT_PATH="C:\dev\Godot_v4.7-stable_win64_console.exe" -- node C:\dev\GodotAIGameTester\mcp-server\src\index.js
```

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.godot-game-tester]
command = "node"
args = ["C:\\dev\\GodotAIGameTester\\mcp-server\\src\\index.js"]
env = { GODOT_PATH = "C:\\dev\\Godot_v4.7-stable_win64_console.exe" }
```

### Cursor / Windsurf / other MCP clients

Any client that supports stdio MCP servers works. JSON config shape:

```json
{
  "mcpServers": {
    "godot-game-tester": {
      "command": "node",
      "args": ["C:\\dev\\GodotAIGameTester\\mcp-server\\src\\index.js"],
      "env": { "GODOT_PATH": "C:\\dev\\Godot_v4.7-stable_win64_console.exe" }
    }
  }
}
```

## Tools

**Lifecycle**
| Tool | What it does |
|---|---|
| `launch_game` | Launch a project windowed; optionally a specific scene (`scene: "res://levels/level2.tscn"`) |
| `stop_game` | Quit the game and remove all injected files |
| `game_status` | Process state, PID, bridge connection, recent output |
| `list_scenes` | All `.tscn` files in a project + the main scene (works without launching) |
| `get_logs` | Game console output; `errors_only: true` filters to errors/warnings/stack traces |

**Recording** (animated GIF, sourced from the game viewport — no OS screen-grab)
| Tool | What it does |
|---|---|
| `start_recording` | Begin capturing frames in the background (`fps`, `max_dim`, `max_frames`, `max_seconds`) while you keep issuing other commands |
| `stop_recording` | Encode the buffered frames to an animated GIF on disk, and return a **contact sheet** (grid of sampled frames) inline so the AI can review the motion across time |
| `recording_status` | Whether a recording is running, frames buffered, elapsed time |

`launch_game { auto_record: true }` records the whole session automatically; the GIF is finalized and its path returned by `stop_game` (with a contact sheet inline).

**Save states** (bookmark a spot and jump back without replaying)
| Tool | What it does |
|---|---|
| `save_state` | Snapshot the live scene tree's script variables + transforms under a name (stored server-side, so it barely costs tokens). `include_autoloads: true` also captures singletons like `GameState`; `save_path` writes it to a file |
| `load_state` | Restore a saved state by `name` (or from a `path`). `reload: true` reloads the scene first for a clean base; otherwise applies in place |
| `list_states` | List states saved this session |

Great for testing a hard spot repeatedly: `save_state` at the checkpoint, test, `load_state` to retry. Restores state on nodes that still exist — it does not recreate runtime-spawned nodes (reload for a clean base, or snapshot/restore in place for state-driven games).

**Observing**
| Tool | What it does |
|---|---|
| `screenshot` | Real rendered frame, returned as an image the AI can see (`max_dim` to downscale) |
| `get_scene_tree` | Live node tree with classes, scripts, positions, UI rects, text |
| `get_node` | One node in detail: transform, visibility, text, script variables, `click_position` |
| `get_performance` | FPS, frame times, memory, node/orphan counts (leak detection), draw calls |
| `list_input_actions` | The game's InputMap actions and their bindings |

**Playing**
| Tool | What it does |
|---|---|
| `input_action` | Trigger InputMap actions — `tap` / `press` / `release` / `hold` with duration and analog strength |
| `input_key` | Raw keyboard keys (`"W"`, `"Space"`, `"Escape"`, ...) |
| `gamepad_button` | Virtual controller buttons by name (`a`/`b`/`x`/`y`, `lb`/`rb`, `dpad_up`, `start`, ...) — for controller-only games |
| `gamepad_axis` | One analog axis: sticks (`left_x`…`right_y`) −1..1, triggers (`lt`/`rt`) 0..1; `duration` to flick-and-release |
| `gamepad_stick` | Move a whole thumbstick (`left`/`right`) with x/y at once |
| `input_text` | Type a string into the focused control |
| `mouse_click` | Click at viewport coordinates (matches screenshot pixels; UI centers come from `get_node.click_position`) |
| `mouse_move` | Absolute move, or relative motion for captured-mouse 3D camera look |
| `look_at` | Point the camera at a node or world position in one call (3D). Returns whether the target is on screen + its pixel position. Simulated mouse-look by default; exact instant `set` mode when given a camera pivot |

**Manipulating**
| Tool | What it does |
|---|---|
| `change_scene` / `reload_scene` | Jump to any scene, or reset the current one |
| `set_pause` / `set_time_scale` | Freeze the game, or fast-forward tests up to 20x |
| `set_property` / `call_method` | Poke any node — use `{"$expr": "Vector2(1,2)"}` for Godot types |
| `eval` | Run a GDScript expression in-game: `node("Player").health`, `scene().get_child_count()`, ... |
| `batch` | Run several commands in one round trip and get their results in order — much faster than many small calls (each round trip is ~half a game frame). Ideal for reading lots of state or setting up a scenario at once |

**Waiting & events**
| Tool | What it does |
|---|---|
| `wait` | Let the game run N seconds / N frames |
| `wait_signal` | Block until a node emits a signal (returns its args) — verify events actually fire |
| `record_signals` / `get_signal_log` | Record signal emissions with timestamps for later assertions |

## A typical AI test session

```
launch_game { project_path: "C:\\dev\\mygame" }
screenshot                              → see the title screen
get_scene_tree                          → find the Play button
get_node { path: "UI/PlayButton" }      → click_position: [640, 420]
mouse_click { x: 640, y: 420 }
wait { seconds: 1 } + screenshot        → confirm gameplay started
list_input_actions                      → discover "jump", "move_left", ...
input_action { action: "move_right", mode: "hold", duration: 1 }
get_node { path: "Player" }             → did the position change?
wait_signal { path: ".", signal: "coin_collected", timeout: 5 }
get_logs { errors_only: true }          → any script errors during all that?
stop_game
```

## Declarative test suites (regression testing / CI)

Instead of hand-writing a script per check, describe tests as JSON — launch a scene, run steps, assert on live game state. Run them via the `run_test_suite` MCP tool, or from the command line for CI.

```json
{
  "name": "My game",
  "project": "..",                    // path to the dir with project.godot (relative to this file)
  "scene": "res://main.tscn",         // default scene for all tests
  "isolation": "reload",              // "reload" (fast) or "relaunch" (full isolation) between tests
  "tests": [
    {
      "name": "score button works",
      "steps": [
        { "do": "click_node", "node": "ScoreButton" },
        { "expect": "node('.').score", "eq": 1, "as": "one click -> score 1" },
        { "do": "input_action", "action": "ui_right", "mode": "hold", "duration": 0.5 },
        { "expect": "node('Player').position.x", "gt": 420 },
        { "no_errors": true }
      ]
    }
  ]
}
```

**Step kinds** (one key selects the kind):
- `{ "do": <cmd>, ... }` — drive the game. `cmd` is any friendly command (`input_action`, `input_key`, `input_text`, `mouse_click`, `mouse_move`, `look_at`, `gamepad_button`/`_axis`/`_stick`, `set_property`, `call_method`, `change_scene`, `wait`) plus `click_node` (clicks a node by its center).
- `{ "expect": "<gdscript expr>", <op>: <value>, "as": "label" }` — assert. Ops: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `near` (+ `tol`), `contains`; omit for a truthy check. The expression runs in-game with the `node()` / `scene()` / `tree()` helpers.
- `{ "signal": { "path": ".", "signal": "died", "timeout": 5 } }` — assert a signal fires (for events the game raises on its own).
- `{ "no_errors": true }` — assert no `SCRIPT ERROR` appeared during this test (optional `pattern`).
- `{ "screenshot": "label" }` — save an artifact PNG.

**Run it from the CLI** (exits non-zero on failure; writes reports for CI):
```
node mcp-server/src/run-tests.js demo-project/tests/demo.suite.json \
     --junit results.xml --json results.json
```
Each test runs from a clean scene, failures auto-capture a screenshot, and the process exits `1` if anything failed — drop it straight into a CI step. A ready example lives in [demo-project/tests/demo.suite.json](demo-project/tests/demo.suite.json).

## Performance

Every command is one round trip whose latency is ~half a game frame. Practical tips (all measured):
- **Read in bulk.** `batch` (or one `eval` returning an array) collapses N reads into one round trip — ~6× faster than N separate calls. Reach for state (`eval`/`get_node`) over screenshots when you don't literally need to see pixels.
- **Screenshots are the heavy op** (GPU readback + encode). Use `format: "jpg"` (~5.5× smaller payload than PNG) and a modest `max_dim`.
- **Don't relaunch.** Reuse one session with `change_scene` / `reload_scene` / `load_state`; `launch_game` costs ~1.5s.
- **Heavy games:** the bridge services the socket on the physics loop (60 Hz), so command latency stays low even when the game renders at a low fps. `launch_game`'s internals accept an fps cap (`--ai-fps-cap`) for deterministic/low-CPU test runs.

## Notes & limits

- **Coordinates**: `mouse_click` uses viewport coordinates, which match screenshot pixels 1:1 at
  full size. If the project uses viewport stretch scaling, click positions from `get_node` are
  still correct (both live in the same coordinate space).
- **One game at a time** per server instance.
- The bridge listens on `127.0.0.1` only (random port 9100–9899), so nothing is exposed to the network.
- `eval` takes expressions, not statements — no `await`, no assignment. Use `set_property` /
  `call_method` for mutations.
- C# projects work too: the injected bridge is GDScript, which coexists with C# game code.
- The game window must stay open (don't close it manually mid-test; if you do, `game_status`
  reports the exit and cleanup still runs).

## Testing this repo

```
node test/e2e-test.mjs      # full pipeline against demo-project (opens a window)
node test/record-test.mjs   # GIF + contact-sheet recording (manual and auto)
node test/lookat-test.mjs   # look_at camera aiming against giants-demo
node test/gamepad-test.mjs  # virtual gamepad drives giants-demo (move/camera/jump)
node test/savestate-test.mjs # save_state / load_state bookmark + restore
node mcp-server/src/run-tests.js demo-project/tests/demo.suite.json   # declarative suite
node test/mcp-smoke.mjs     # MCP protocol handshake + tool listing
```

`demo-project/` is a tiny game (movable square, score button, error button, text field) used by
the e2e test — and a handy playground for trying the tools.
