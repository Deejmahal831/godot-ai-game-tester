import fs from "node:fs";
import path from "node:path";
import { GodotSession } from "./session.js";

/**
 * Declarative test-suite runner for Godot games.
 *
 * A suite is JSON:
 * {
 *   "name": "My game",
 *   "project": "C:/path/to/project",     // dir with project.godot
 *   "scene": "res://main.tscn",          // optional default scene for all tests
 *   "isolation": "reload" | "relaunch",  // how state resets between tests (default reload)
 *   "tests": [
 *     {
 *       "name": "player can score",
 *       "scene": "res://main.tscn",      // optional per-test override
 *       "steps": [
 *         { "do": "click_node", "node": "ScoreButton" },
 *         { "expect": "node('.').score", "eq": 1, "as": "score is 1" },
 *         { "do": "input_action", "action": "ui_right", "mode": "hold", "duration": 0.5 },
 *         { "expect": "node('Player').position.x", "gt": 400 },
 *         { "no_errors": true }
 *       ]
 *     }
 *   ]
 * }
 *
 * Step kinds (one key decides the kind):
 *   { "do": <cmd>, ...args }   drive the game (friendly names, see DO_MAP; plus "click_node")
 *   { "expect": <gdscript expr>, <op>: <value>, "as": <label> }   assert
 *        ops: eq, ne, gt, gte, lt, lte, near (+ tol), contains; none => truthy
 *   { "signal": {"path","signal","timeout"} }   assert a signal fires (for self-firing events)
 *   { "no_errors": true, "pattern"?: <regex> }  assert no SCRIPT ERROR in this test's window
 *   { "screenshot": "label" }   save an artifact PNG
 *   { "comment": "..." }        no-op note
 */

// Friendly step command -> bridge command.
const DO_MAP = {
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

function compare(step, value) {
  const j = (v) => JSON.stringify(v);
  if ("eq" in step) return { ok: j(value) === j(step.eq), op: `== ${j(step.eq)}` };
  if ("ne" in step) return { ok: j(value) !== j(step.ne), op: `!= ${j(step.ne)}` };
  if ("gt" in step) return { ok: value > step.gt, op: `> ${step.gt}` };
  if ("gte" in step) return { ok: value >= step.gte, op: `>= ${step.gte}` };
  if ("lt" in step) return { ok: value < step.lt, op: `< ${step.lt}` };
  if ("lte" in step) return { ok: value <= step.lte, op: `<= ${step.lte}` };
  if ("near" in step) return { ok: Math.abs(Number(value) - step.near) <= (step.tol ?? 0.001), op: `~= ${step.near} (±${step.tol ?? 0.001})` };
  if ("contains" in step)
    return {
      ok: (Array.isArray(value) && value.some((v) => j(v) === j(step.contains))) || String(value).includes(step.contains),
      op: `contains ${j(step.contains)}`,
    };
  // Default: truthy.
  return { ok: !!value && value !== 0 && !(Array.isArray(value) && value.length === 0), op: "is truthy" };
}

async function clickNode(session, node, button) {
  const info = await session.send("get_node", { path: node });
  const p = info.click_position || (info.screen_position ? info.screen_position : null);
  if (!p) throw new Error(`Node '${node}' has no clickable position (not a Control/Node2D on screen)`);
  await session.send("mouse_button", { x: p[0], y: p[1], button: button ?? 1 });
  return p;
}

/**
 * Run a suite. Caller supplies a GodotSession (fresh, not yet launched).
 * onEvent(evt) receives progress events for live reporting.
 */
export async function runSuite(suite, { session, godotPath, artifactsDir, onEvent = () => {} } = {}) {
  if (!suite || !Array.isArray(suite.tests)) throw new Error("Suite must have a 'tests' array");
  if (!suite.project) throw new Error("Suite must set 'project' (path to the Godot project dir)");
  const started = Date.now();
  const outDir = artifactsDir || path.join(process.cwd(), "test-artifacts");
  const results = [];
  const state = { launched: false, scene: null };

  const stampArtifact = (label) => {
    fs.mkdirSync(outDir, { recursive: true });
    return path.join(outDir, `${label.replace(/[^a-z0-9_-]+/gi, "_")}.png`);
  };

  const prepareScene = async (test) => {
    const want = test.scene || suite.scene || null;
    if (!state.launched) {
      const r = await session.launch({ projectPath: suite.project, scene: want, godotPath });
      state.launched = true;
      state.scene = r.info?.current_scene || want;
      await session.send("wait", { frames: 5 });
    } else if (suite.isolation === "relaunch") {
      await session.stop();
      const r = await session.launch({ projectPath: suite.project, scene: want, godotPath });
      state.scene = r.info?.current_scene || want;
      await session.send("wait", { frames: 5 });
    } else if (want && want !== state.scene) {
      await session.send("change_scene", { scene: want });
      state.scene = want;
      await session.send("wait", { frames: 5 });
    } else {
      await session.send("reload_scene", {});
      await session.send("wait", { frames: 5 });
    }
  };

  for (const test of suite.tests) {
    const tRes = { name: test.name || "(unnamed)", ok: true, assertions: [], artifacts: [], error: null };
    onEvent({ type: "test_start", name: tRes.name });
    try {
      await prepareScene(test);
      const logMark = session.logs.length;

      for (let i = 0; i < (test.steps || []).length; i++) {
        const step = test.steps[i];

        if ("comment" in step) {
          onEvent({ type: "comment", text: step.comment });
          continue;
        }

        if ("do" in step) {
          const { do: cmd, ...args } = step;
          if (cmd === "click_node") {
            await clickNode(session, args.node, args.button);
          } else if (cmd === "save_state") {
            await session.saveState(args.name, { includeAutoloads: args.include_autoloads, savePath: args.save_path });
          } else if (cmd === "load_state") {
            await session.loadState({ name: args.name, path: args.path, reload: args.reload });
          } else if (DO_MAP[cmd]) {
            const extra = 15000 + ((args.duration ?? 0) + (args.seconds ?? 0)) * 1000;
            await session.send(DO_MAP[cmd], args, extra);
          } else {
            throw new Error(`Unknown 'do' command: ${cmd}`);
          }
          continue;
        }

        if ("expect" in step) {
          const val = (await session.send("eval", { expression: step.expect }, 10000)).value;
          const { ok, op } = compare(step, val);
          const desc = step.as || `${step.expect} ${op}`;
          tRes.assertions.push({ ok, desc, got: val });
          if (!ok) {
            tRes.ok = false;
            onEvent({ type: "assert_fail", test: tRes.name, desc, got: val });
            const art = stampArtifact(`FAIL-${tRes.name}-${i}`);
            try {
              const s = await session.send("screenshot", { max_dim: 800 }, 20000);
              fs.writeFileSync(art, Buffer.from(s.png_base64, "base64"));
              tRes.artifacts.push(art);
            } catch {}
          } else {
            onEvent({ type: "assert_pass", test: tRes.name, desc });
          }
          continue;
        }

        if ("signal" in step) {
          const s = step.signal;
          const r = await session.send("wait_signal", { path: s.path, signal: s.signal, timeout: s.timeout ?? 5 }, ((s.timeout ?? 5) + 5) * 1000);
          const ok = r.fired === true;
          const desc = step.as || `signal ${s.signal} on ${s.path}`;
          tRes.assertions.push({ ok, desc, got: r });
          if (!ok) { tRes.ok = false; onEvent({ type: "assert_fail", test: tRes.name, desc, got: r }); }
          continue;
        }

        if ("no_errors" in step) {
          const re = step.pattern ? new RegExp(step.pattern, "i") : /SCRIPT ERROR/i;
          const errs = session.logs.slice(logMark).filter((l) => re.test(l.line)).map((l) => l.line);
          const ok = errs.length === 0;
          const desc = step.as || `no errors matching ${re}`;
          tRes.assertions.push({ ok, desc, got: errs.slice(0, 3) });
          if (!ok) { tRes.ok = false; onEvent({ type: "assert_fail", test: tRes.name, desc, got: errs.slice(0, 3) }); }
          continue;
        }

        if ("screenshot" in step) {
          const art = stampArtifact(`${tRes.name}-${step.screenshot}`);
          const s = await session.send("screenshot", { max_dim: 800 }, 20000);
          fs.writeFileSync(art, Buffer.from(s.png_base64, "base64"));
          tRes.artifacts.push(art);
          continue;
        }

        throw new Error(`Unrecognized step at index ${i}: ${JSON.stringify(step)}`);
      }
    } catch (e) {
      tRes.ok = false;
      tRes.error = e.message;
      onEvent({ type: "test_error", name: tRes.name, error: e.message });
      // Best-effort failure screenshot.
      try {
        const art = stampArtifact(`ERROR-${tRes.name}`);
        const s = await session.send("screenshot", { max_dim: 800 }, 20000);
        fs.writeFileSync(art, Buffer.from(s.png_base64, "base64"));
        tRes.artifacts.push(art);
      } catch {}
    }
    results.push(tRes);
    onEvent({ type: "test_end", name: tRes.name, ok: tRes.ok });
  }

  await session.stop().catch(() => {});

  const passed = results.filter((t) => t.ok).length;
  const failed = results.length - passed;
  return {
    name: suite.name || "suite",
    project: suite.project,
    passed,
    failed,
    total: results.length,
    duration_seconds: +((Date.now() - started) / 1000).toFixed(1),
    artifacts_dir: outDir,
    tests: results,
  };
}

/** Convenience for the CLI / MCP tool: load a suite file and run it. */
export async function runSuiteFile(suitePath, opts = {}) {
  const abs = path.resolve(suitePath);
  const suite = JSON.parse(fs.readFileSync(abs, "utf8"));
  // Resolve a relative project path against the suite file's location.
  if (suite.project && !path.isAbsolute(suite.project)) {
    suite.project = path.resolve(path.dirname(abs), suite.project);
  }
  const session = opts.session || new GodotSession();
  return runSuite(suite, { ...opts, session });
}

/** Render a suite result as JUnit XML for CI systems. */
export function toJUnitXml(result) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const cases = result.tests
    .map((t) => {
      const body = t.ok
        ? ""
        : `<failure message="${esc(t.error || t.assertions.filter((a) => !a.ok).map((a) => a.desc).join("; "))}">` +
          esc(t.assertions.filter((a) => !a.ok).map((a) => `${a.desc} (got ${JSON.stringify(a.got)})`).join("\n")) +
          `</failure>`;
      return `    <testcase name="${esc(t.name)}" classname="${esc(result.name)}">${body}</testcase>`;
    })
    .join("\n");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuite name="${esc(result.name)}" tests="${result.total}" failures="${result.failed}" time="${result.duration_seconds}">\n` +
    `${cases}\n</testsuite>\n`
  );
}
