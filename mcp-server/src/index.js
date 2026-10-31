#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { GodotSession, listScenes } from "./session.js";
import { runSuite, runSuiteFile } from "./runner.js";

const session = new GodotSession();

const server = new McpServer({
  name: "godot-ai-game-tester",
  version: "0.1.0",
});

const text = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

/** Wrap a handler so thrown errors become readable MCP tool errors. */
const tool = (name, description, schema, handler) => {
  server.registerTool(name, { description, inputSchema: schema }, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  });
};

// Friendly tool name -> bridge command, for the `batch` tool.
const BATCH_CMD_MAP = {
  ping: "ping",
  eval: "eval",
  get_node: "get_node",
  get_scene_tree: "get_scene_tree",
  get_performance: "perf",
  list_input_actions: "list_actions",
  screenshot: "screenshot",
  input_action: "action",
  input_key: "key",
  input_text: "type_text",
  mouse_click: "mouse_button",
  mouse_move: "mouse_move",
  look_at: "look_at",
  gamepad_button: "joy_button",
  gamepad_axis: "joy_axis",
  gamepad_stick: "joy_stick",
  change_scene: "change_scene",
  reload_scene: "reload_scene",
  set_pause: "pause",
  set_time_scale: "time_scale",
  set_property: "set_property",
  call_method: "call_method",
  wait: "wait",
};

// ------------------------------------------------------------ lifecycle ---

tool(
  "launch_game",
  "Launch a Godot project in a real window (NOT headless) with the AI test bridge injected. " +
    "Optionally launch a specific scene instead of the main scene. The project's files are " +
    "temporarily patched and fully restored, so the project is left untouched.",
  {
    project_path: z.string().describe("Absolute path to the Godot project directory (contains project.godot)"),
    scene: z.string().optional().describe("Optional scene to run instead of the main scene, e.g. res://levels/level2.tscn"),
    godot_path: z.string().optional().describe("Path to the Godot executable (defaults to GODOT_PATH env var or auto-detection)"),
    window_x: z.number().optional().describe("Window X position on screen"),
    window_y: z.number().optional().describe("Window Y position on screen"),
    extra_args: z.array(z.string()).optional().describe("Extra Godot command-line arguments"),
    auto_record: z.boolean().optional().describe("Start recording a GIF at launch; it is finalized and saved automatically on stop_game"),
    background: z.boolean().optional().describe("Keep the game window from stealing focus (default true; GODOT_TESTER_FOREGROUND=1 flips the default). Input still works. Pass false to click into and play the window by hand."),
  },
  async (a) => {
    const result = await session.launch({
      background: a.background,
      projectPath: a.project_path,
      scene: a.scene,
      godotPath: a.godot_path,
      windowX: a.window_x,
      windowY: a.window_y,
      extraArgs: a.extra_args ?? [],
      autoRecord: a.auto_record ?? false,
    });
    return text({
      launched: true,
      pid: result.pid,
      bridge_port: result.port,
      godot: result.godot,
      game: result.info,
      hint: "Use screenshot to see the game, get_scene_tree to inspect it, and input_action/input_key/mouse_click to play it.",
    });
  }
);

tool("stop_game", "Stop the currently running game and clean up all injected files. If auto_record was on, the GIF is finalized and its path is returned.", {}, async () => {
  const hadFrames = session.recorder.frames.length > 0;
  const result = await session.stop();
  const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
  // Surface a contact sheet for an auto-recorded clip so motion is reviewable.
  if (result.recording && !result.recording.error && hadFrames) {
    try {
      const sheet = session.recorder.buildContactSheet({ count: 9 });
      content.unshift({ type: "image", data: sheet.png.toString("base64"), mimeType: "image/png" });
    } catch {
      /* best-effort */
    }
  }
  return { content };
});

tool(
  "game_status",
  "Get the status of the game process: running/exited, PID, bridge connection, and recent console output.",
  {},
  async () => text(session.status())
);

tool(
  "get_logs",
  "Get the game's console output (print statements, engine errors, script errors, stack traces).",
  {
    tail: z.number().optional().describe("Number of recent lines to return (default 100)"),
    errors_only: z.boolean().optional().describe("Only return lines that look like errors/warnings"),
  },
  async (a) => {
    const lines = session.getLogs({ tail: a.tail ?? 100, errorsOnly: a.errors_only ?? false });
    return text(lines.length ? lines.join("\n") : "(no matching log output)");
  }
);

// ------------------------------------------------------------ recording ---

tool(
  "start_recording",
  "Start capturing frames from the running game into a buffer, to be encoded as an animated GIF with stop_recording. " +
    "Frames come from the game viewport over the bridge (clean, no OS screen-grab). Capturing runs in the background " +
    "while you keep issuing other commands (input, inspection, etc.).",
  {
    fps: z.number().optional().describe("Target capture frames per second, 1-30 (default 10)"),
    max_dim: z.number().optional().describe("Longest side of each frame in pixels (default 480; smaller = smaller GIF)"),
    max_frames: z.number().optional().describe("Stop capturing after this many frames (default 600)"),
    max_seconds: z.number().optional().describe("Stop capturing after this many seconds (default 120)"),
  },
  async (a) => text(session.recorder.start({ fps: a.fps, max_dim: a.max_dim, max_frames: a.max_frames, max_seconds: a.max_seconds }))
);

tool(
  "stop_recording",
  "Stop capturing and encode the buffered frames into an animated GIF saved to disk. Also returns a contact sheet " +
    "(a grid of sampled frames) as an inline image so you can review the motion/animation across time at a glance.",
  {
    save_path: z.string().optional().describe("Where to save the .gif (default: a timestamped file in the temp dir)"),
    fps: z.number().optional().describe("Playback fps for the GIF (defaults to the capture fps; real frame timing is used when available)"),
    contact_sheet: z.boolean().optional().describe("Return an inline grid of sampled frames for review (default true)"),
    contact_tiles: z.number().optional().describe("How many frames to sample into the contact sheet (default 9)"),
  },
  async (a) => {
    session.recorder.stopCapture();
    const gif = await session.recorder.encodeGif(a.save_path, { fps: a.fps });
    const content = [];
    if (a.contact_sheet !== false) {
      try {
        const sheet = session.recorder.buildContactSheet({ count: a.contact_tiles ?? 9 });
        content.push({ type: "image", data: sheet.png.toString("base64"), mimeType: "image/png" });
        content.push({ type: "text", text: `Contact sheet: ${sheet.tiles} frames sampled across the clip (${sheet.width}x${sheet.height}).` });
      } catch {
        /* contact sheet is best-effort */
      }
    }
    content.push({
      type: "text",
      text: `GIF saved: ${gif.path}\n${gif.frames} frames, ${gif.width}x${gif.height}, ${gif.duration_seconds}s, ${(gif.bytes / 1024).toFixed(0)} KB`,
    });
    return { content };
  }
);

tool(
  "recording_status",
  "Report whether a recording is in progress, how many frames are buffered, and elapsed time.",
  {},
  async () => text(session.recorder.status)
);

// ---------------------------------------------------------- save states ----

tool(
  "save_state",
  "Bookmark the current game state under a name so you can jump back to it later without replaying. " +
    "Captures the live scene tree's script variables + transforms (stored server-side, so it costs you almost " +
    "no tokens). Optionally also write it to a file to reuse across sessions or in test suites. " +
    "For simulation/RPG state held in autoloads, pass include_autoloads: true.",
  {
    name: z.string().describe("A name to store this state under, e.g. 'boss_start'"),
    include_autoloads: z.boolean().optional().describe("Also capture autoload singletons like GameState (default false)"),
    save_path: z.string().optional().describe("Also write the snapshot to this .json file"),
  },
  async (a) => text(await session.saveState(a.name, { includeAutoloads: a.include_autoloads, savePath: a.save_path }))
);

tool(
  "load_state",
  "Restore a previously saved state (by `name`, or from a `path` to a saved .json). Re-applies the captured " +
    "values to matching nodes. Pass reload: true to reload the scene first for a clean base (clears runtime-spawned " +
    "nodes like enemies/projectiles); otherwise state is applied in place. Returns how many properties were applied.",
  {
    name: z.string().optional().describe("Name used with save_state"),
    path: z.string().optional().describe("Path to a saved snapshot .json (alternative to name)"),
    reload: z.boolean().optional().describe("Reload the scene before applying (default false)"),
  },
  async (a) => text(await session.loadState({ name: a.name, path: a.path, reload: a.reload }))
);

tool(
  "list_states",
  "List the state snapshots saved this session (name, scene, node count).",
  {},
  async () => text(session.listStates())
);

tool(
  "run_test_suite",
  "Run a declarative test suite (launch scene -> do steps -> assert). Give a `path` to a .json suite file, " +
    "or an inline `suite` object. Each test's steps are `do` actions (input_action/mouse_click/click_node/" +
    "gamepad_*/look_at/set_property/wait/...) and asserts (`expect` a GDScript expression with eq/gt/lt/near/" +
    "contains, `no_errors`, or `signal`). Runs in its own game instance, auto-screenshots failures, and returns " +
    "a compact pass/fail summary with only the failing assertions detailed. Ideal for regression testing in CI.",
  {
    path: z.string().optional().describe("Path to a .json suite file"),
    suite: z.any().optional().describe("Inline suite object (alternative to path)"),
    artifacts_dir: z.string().optional().describe("Where to save screenshots (default: ./test-artifacts)"),
    godot_path: z.string().optional().describe("Godot executable (defaults to GODOT_PATH / auto-detect)"),
  },
  async (a) => {
    if (!a.path && !a.suite) throw new Error("Provide either 'path' or 'suite'");
    const runOpts = { session: new GodotSession(), godotPath: a.godot_path, artifactsDir: a.artifacts_dir };
    const result = a.path ? await runSuiteFile(a.path, runOpts) : await runSuite(a.suite, runOpts);
    // Compact summary: don't echo every passing assertion.
    const summary = {
      suite: result.name,
      passed: result.passed,
      failed: result.failed,
      total: result.total,
      duration_seconds: result.duration_seconds,
      artifacts_dir: result.artifacts_dir,
      results: result.tests.map((t) => ({
        test: t.name,
        ok: t.ok,
        ...(t.ok
          ? {}
          : {
              error: t.error || undefined,
              failed_assertions: t.assertions.filter((x) => !x.ok).map((x) => ({ desc: x.desc, got: x.got })),
              artifacts: t.artifacts,
            }),
      })),
    };
    return text(summary);
  }
);

tool(
  "list_scenes",
  "List all .tscn scene files in a Godot project, plus which one is the main scene. Works without the game running.",
  {
    project_path: z.string().describe("Absolute path to the Godot project directory"),
  },
  async (a) => text(listScenes(a.project_path))
);

// ------------------------------------------------------------ observing ---

tool(
  "screenshot",
  "Capture a screenshot of the running game window (returned as an image you can see). " +
    "Coordinates in the image map 1:1 to mouse_click coordinates unless max_dim scaling is applied.",
  {
    max_dim: z.number().optional().describe("Downscale so the longest side is at most this many pixels (saves tokens & time; omit for full size)"),
    format: z.enum(["png", "jpg"]).optional().describe("jpg is much faster to capture and smaller to transfer (default png)"),
    quality: z.number().optional().describe("JPEG quality 0.1-1.0 (default 0.75)"),
    save_path: z.string().optional().describe("Optionally also save the image to this file path"),
  },
  async (a) => {
    const r = await session.send("screenshot", { max_dim: a.max_dim ?? 0, format: a.format ?? "png", quality: a.quality ?? 0.75 }, 20000);
    if (a.save_path) {
      fs.mkdirSync(path.dirname(path.resolve(a.save_path)), { recursive: true });
      fs.writeFileSync(a.save_path, Buffer.from(r.png_base64, "base64"));
    }
    return {
      content: [
        { type: "image", data: r.png_base64, mimeType: r.mime || "image/png" },
        { type: "text", text: `Screenshot ${r.width}x${r.height} (${r.format || "png"})${a.save_path ? `, saved to ${a.save_path}` : ""}` },
      ],
    };
  }
);

tool(
  "get_scene_tree",
  "Dump the live scene tree as JSON: node names, classes, scripts, positions, visibility, UI rects, and text. " +
    "Use path '/root' to include autoloads; default is the current scene.",
  {
    path: z.string().optional().describe("Node path to start from (default: current scene; '/root' for everything)"),
    max_depth: z.number().optional().describe("Maximum tree depth (default 10)"),
  },
  async (a) => text(await session.send("get_scene_tree", { path: a.path ?? "", max_depth: a.max_depth ?? 10 }))
);

tool(
  "get_node",
  "Inspect a single node: class, script, transform, visibility, text, script variables — or specific properties. " +
    "For Controls this includes click_position (screen coords for mouse_click).",
  {
    path: z.string().describe("Node path, absolute ('/root/Main/Player') or relative to the current scene ('Player')"),
    properties: z.array(z.string()).optional().describe("Specific property names to fetch instead of the default summary"),
  },
  async (a) => text(await session.send("get_node", { path: a.path, properties: a.properties }))
);

tool(
  "get_performance",
  "Get live performance stats: FPS, frame times, memory, node/object counts (orphan nodes = leaks), draw calls.",
  {},
  async () => text(await session.send("perf"))
);

tool(
  "list_input_actions",
  "List the game's InputMap actions and which keys/buttons trigger them. Use these names with input_action.",
  {},
  async () => text(await session.send("list_actions"))
);

// ------------------------------------------------------------- playing ----

tool(
  "input_action",
  "Trigger a game input action (from list_input_actions). Modes: tap (press+release), press, release, " +
    "hold (press for `duration` seconds then release). Use press/release pairs for continuous movement.",
  {
    action: z.string().describe("Input action name, e.g. 'jump' or 'move_forward'"),
    mode: z.enum(["tap", "press", "release", "hold"]).optional().describe("Default: tap"),
    duration: z.number().optional().describe("Seconds to hold for tap/hold modes (default 0.1)"),
    strength: z.number().optional().describe("Analog strength 0-1 (default 1)"),
  },
  async (a) => {
    const timeout = 15000 + (a.duration ?? 0) * 1000;
    return text(await session.send("action", a, timeout));
  }
);

tool(
  "input_key",
  "Send a keyboard key to the game. Key names like 'W', 'Space', 'Escape', 'Enter', 'Shift', 'F1'.",
  {
    key: z.string().describe("Key name (Godot key string, e.g. 'W', 'Space', 'Escape')"),
    mode: z.enum(["tap", "press", "release", "hold"]).optional().describe("Default: tap"),
    duration: z.number().optional().describe("Seconds to hold (default 0.1)"),
  },
  async (a) => {
    const timeout = 15000 + (a.duration ?? 0) * 1000;
    return text(await session.send("key", a, timeout));
  }
);

tool(
  "input_text",
  "Type a text string into the currently focused control (e.g. a LineEdit). Click it first with mouse_click.",
  {
    text: z.string().describe("Text to type"),
  },
  async (a) => text(await session.send("type_text", { text: a.text }))
);

tool(
  "mouse_click",
  "Click the mouse at viewport coordinates (same coordinate space as screenshots at full size). " +
    "Buttons: 1=left, 2=right, 3=middle. get_node's click_position gives you the center of any UI control.",
  {
    x: z.number().describe("X coordinate in the game viewport"),
    y: z.number().describe("Y coordinate in the game viewport"),
    button: z.number().optional().describe("Mouse button (1=left, 2=right, 3=middle; default 1)"),
    mode: z.enum(["click", "down", "up"]).optional().describe("Default: click (press+release)"),
    double: z.boolean().optional().describe("Double click"),
  },
  async (a) => text(await session.send("mouse_button", a))
);

tool(
  "mouse_move",
  "Move the mouse. Give x/y for absolute viewport position, or relative_x/relative_y for relative motion " +
    "(use relative for captured-mouse camera look in 3D games).",
  {
    x: z.number().optional(),
    y: z.number().optional(),
    relative_x: z.number().optional(),
    relative_y: z.number().optional(),
  },
  async (a) => text(await session.send("mouse_move", a))
);

tool(
  "look_at",
  "Point the camera at a target in ONE call (3D games). Give a node `path` or world `x`/`y`/`z`. " +
    "All the aiming happens inside the game and it returns a small result telling you whether the target " +
    "is now on screen and its pixel position — so you don't burn turns doing screenshot+aim math. " +
    "Use before a screenshot to frame something, or before firing a projectile. " +
    "By default it simulates mouse-look (works on any mouse-look game); pass camera_node (a pivot path) for an exact instant set.",
  {
    path: z.string().optional().describe("Node to look at, e.g. res-style node path '/root/World/Monster/WeakCore'"),
    x: z.number().optional().describe("World X (use x/y/z instead of path to look at a point)"),
    y: z.number().optional().describe("World Y"),
    z: z.number().optional().describe("World Z"),
    pitch_offset: z.number().optional().describe("Radians to aim above (+) or below (-) the target, e.g. to lob a projectile"),
    mode: z.enum(["auto", "set", "input"]).optional().describe("auto (default): set if camera_node given else input; set: instant/exact; input: simulated mouse-look"),
    camera_node: z.string().optional().describe("Path to the camera pivot node for exact 'set' mode (e.g. '/root/World/Player/CameraPivot')"),
  },
  async (a) => text(await session.send("look_at", a, 15000))
);

tool(
  "gamepad_button",
  "Press a virtual controller button (for controller-only or controller-aware games). " +
    "Names: a, b, x, y (or cross/circle/square/triangle), lb, rb, lt-as-button, start, back/select, " +
    "guide, ls/rs (stick clicks), dpad_up/down/left/right, misc1. Modes: tap, press, release, hold.",
  {
    button: z.union([z.string(), z.number()]).describe("Button name (e.g. 'a', 'rb', 'dpad_up') or raw JoyButton index"),
    mode: z.enum(["tap", "press", "release", "hold"]).optional().describe("Default: tap"),
    duration: z.number().optional().describe("Seconds to hold for tap/hold (default 0.1)"),
    pressure: z.number().optional().describe("Analog press 0-1 (default 1)"),
    device: z.number().optional().describe("Virtual controller device id (default 0)"),
  },
  async (a) => {
    const timeout = 15000 + (a.duration ?? 0) * 1000;
    return text(await session.send("joy_button", a, timeout));
  }
);

tool(
  "gamepad_axis",
  "Set one analog controller axis. Sticks (left_x/left_y/right_x/right_y) take -1..1; " +
    "triggers (lt/rt) take 0..1. The axis holds its value until changed (like a held stick); " +
    "pass 'duration' to flick it and auto-return to 0, or set value 0 to release.",
  {
    axis: z.union([z.string(), z.number()]).describe("Axis name (left_x, left_y, right_x, right_y, lt, rt) or raw JoyAxis index"),
    value: z.number().describe("Axis value: sticks -1..1, triggers 0..1"),
    duration: z.number().optional().describe("If set, hold for this many seconds then return to 0"),
    device: z.number().optional().describe("Virtual controller device id (default 0)"),
  },
  async (a) => {
    const timeout = 15000 + (a.duration ?? 0) * 1000;
    return text(await session.send("joy_axis", a, timeout));
  }
);

tool(
  "gamepad_stick",
  "Move a whole thumbstick at once (x and y). stick: 'left' or 'right'. " +
    "e.g. left stick y=-1 is 'push forward'. Set x=0,y=0 to release; pass 'duration' to auto-return to center.",
  {
    stick: z.enum(["left", "right"]).describe("Which stick"),
    x: z.number().optional().describe("Horizontal -1 (left) .. 1 (right), default 0"),
    y: z.number().optional().describe("Vertical -1 (up) .. 1 (down), default 0"),
    duration: z.number().optional().describe("If set, hold for this many seconds then return to center"),
    device: z.number().optional().describe("Virtual controller device id (default 0)"),
  },
  async (a) => {
    const timeout = 15000 + (a.duration ?? 0) * 1000;
    return text(await session.send("joy_stick", a, timeout));
  }
);

// ---------------------------------------------------------- manipulating ---

tool(
  "change_scene",
  "Switch the running game to a different scene (see list_scenes).",
  {
    scene: z.string().describe("Scene path, e.g. res://levels/level2.tscn"),
  },
  async (a) => text(await session.send("change_scene", a))
);

tool("reload_scene", "Reload the current scene (quick reset to test again from a clean state).", {}, async () =>
  text(await session.send("reload_scene"))
);

tool(
  "set_pause",
  "Pause or unpause the game tree. The bridge keeps working while paused (screenshots, inspection, etc.).",
  {
    paused: z.boolean().describe("true to pause, false to resume"),
  },
  async (a) => text(await session.send("pause", a))
);

tool(
  "set_time_scale",
  "Set Engine.time_scale. >1 fast-forwards the game (great for speeding up tests), <1 is slow motion.",
  {
    scale: z.number().describe("Time scale (0.01–20, 1 = normal)"),
  },
  async (a) => text(await session.send("time_scale", a))
);

tool(
  "set_property",
  "Set a property on any node. Plain JSON values work directly; for Godot types pass " +
    '{"$expr": "Vector2(100, 200)"} as the value.',
  {
    path: z.string().describe("Node path"),
    property: z.string().describe("Property name, e.g. 'position' or 'health'"),
    value: z.any().describe('New value; use {"$expr": "..."} for Godot types like Vector2/Color'),
  },
  async (a) => text(await session.send("set_property", a))
);

tool(
  "call_method",
  "Call a method on any node and get the return value. Args are JSON values; " +
    'use {"$expr": "Vector3(0,1,0)"} for Godot types.',
  {
    path: z.string().describe("Node path"),
    method: z.string().describe("Method name"),
    args: z.array(z.any()).optional().describe("Method arguments"),
  },
  async (a) => text(await session.send("call_method", a))
);

tool(
  "eval",
  "Evaluate a GDScript expression inside the game and return the result. Helpers: node(path), scene(), tree(). " +
    'Example: node("Player").global_position.distance_to(node("Enemy").global_position). ' +
    "Expressions only (no statements/await), but you can call any method, e.g. node(\"Player\").take_damage(10).",
  {
    expression: z.string().describe("GDScript expression"),
  },
  async (a) => text(await session.send("eval", a))
);

tool(
  "batch",
  "Run several commands in ONE round trip and get their results back in order. Each round trip has fixed " +
    "latency (~half a game frame), so batching many small ops — reads especially — is far faster than calling " +
    "them one at a time (measured ~6x for 6 reads). Each item is { tool, args }, where tool is a command name " +
    "like eval, get_node, set_property, call_method, input_action, mouse_click, look_at, gamepad_*, wait, screenshot. " +
    "Great for 'read a bunch of state at once' or 'set up a scenario in one shot'.",
  {
    commands: z
      .array(z.object({ tool: z.string(), args: z.any().optional() }))
      .describe("Ordered commands, e.g. [{tool:'eval',args:{expression:'...'}}, {tool:'set_property',args:{...}}]"),
  },
  async (a) => {
    const mapped = a.commands.map((c) => {
      const cmd = BATCH_CMD_MAP[c.tool];
      if (!cmd) throw new Error(`Unknown tool in batch: '${c.tool}'`);
      return { cmd, args: c.args ?? {} };
    });
    const r = await session.send("batch", { commands: mapped }, 30000);
    return text(r.results);
  }
);

// ------------------------------------------------------------- waiting ----

tool(
  "wait",
  "Let the game run for N seconds or N frames before your next command (e.g. wait for an animation or physics to settle).",
  {
    seconds: z.number().optional().describe("Seconds to wait (max 60)"),
    frames: z.number().optional().describe("Frames to wait (max 3600)"),
  },
  async (a) => {
    const timeout = 15000 + ((a.seconds ?? 0) + (a.frames ?? 0) / 30) * 1000;
    return text(await session.send("wait", a, timeout));
  }
);

tool(
  "wait_signal",
  "Wait for a node to emit a signal (or time out). Returns the signal arguments. " +
    "Great for verifying game events: 'did score_changed fire after I clicked?'",
  {
    path: z.string().describe("Node path"),
    signal: z.string().describe("Signal name"),
    timeout: z.number().optional().describe("Timeout in seconds (default 10)"),
  },
  async (a) => text(await session.send("wait_signal", a, ((a.timeout ?? 10) + 5) * 1000))
);

tool(
  "record_signals",
  "Start recording emissions of specific signals on a node (with timestamps and args). Read them later with get_signal_log.",
  {
    path: z.string().describe("Node path"),
    signals: z.array(z.string()).describe("Signal names to record"),
  },
  async (a) => text(await session.send("record_signals", a))
);

tool(
  "get_signal_log",
  "Get all recorded signal emissions since record_signals was called.",
  {
    clear: z.boolean().optional().describe("Clear the log after reading"),
  },
  async (a) => text(await session.send("get_signal_log", a))
);

// ------------------------------------------------------------------ run ---

process.on("SIGINT", async () => {
  await session.stop().catch(() => {});
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await session.stop().catch(() => {});
  process.exit(0);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[godot-ai-game-tester] MCP server ready on stdio");
