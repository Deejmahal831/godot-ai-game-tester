// End-to-end test: launches the demo project windowed via the real session
// pipeline (addon injection, project.godot patch/restore, TCP bridge) and
// exercises every bridge command. Run: node test/e2e-test.mjs [screenshot-dir]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GodotSession, listScenes } from "../mcp-server/src/session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(__dirname, "..", "demo-project");
const OUT_DIR = process.argv[2] || __dirname;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
};

const session = new GodotSession();

try {
  console.log("== list_scenes (no game running) ==");
  const scenes = listScenes(DEMO);
  check("main scene detected", scenes.main_scene === "res://main.tscn", JSON.stringify(scenes));
  check("scene list contains main.tscn", scenes.scenes.includes("res://main.tscn"));

  console.log("== launch ==");
  const launch = await session.launch({ projectPath: DEMO, windowX: 50, windowY: 50 });
  console.log("  launched:", JSON.stringify(launch.info));
  check("bridge connected", session.bridge.connected);
  check("project.godot restored after boot", !fs.readFileSync(path.join(DEMO, "project.godot"), "utf8").includes("AiGameTester"));
  check("game info has scene", launch.info.current_scene === "res://main.tscn", JSON.stringify(launch.info));

  console.log("== screenshot ==");
  const shot = await session.send("screenshot", {}, 20000);
  check("screenshot has data", shot.png_base64.length > 1000, `len=${shot.png_base64.length}`);
  check("screenshot size", shot.width === 800 && shot.height === 600, `${shot.width}x${shot.height}`);
  fs.writeFileSync(path.join(OUT_DIR, "shot1-initial.png"), Buffer.from(shot.png_base64, "base64"));

  console.log("== scene tree ==");
  const tree = await session.send("get_scene_tree", {});
  const childNames = (tree.children ?? []).map((c) => c.name);
  check("tree has Player", childNames.includes("Player"), JSON.stringify(childNames));
  check("tree has ScoreButton", childNames.includes("ScoreButton"));

  console.log("== get_node ==");
  const player0 = await session.send("get_node", { path: "Player" });
  check("player position", Array.isArray(player0.position), JSON.stringify(player0));
  const px0 = player0.position[0];

  console.log("== input_action (move right via ui_right hold) ==");
  await session.send("action", { action: "ui_right", mode: "hold", duration: 0.5 }, 20000);
  await session.send("wait", { frames: 5 });
  const player1 = await session.send("get_node", { path: "Player" });
  check("player moved right", player1.position[0] > px0 + 50, `x: ${px0} -> ${player1.position[0]}`);

  console.log("== input_key (arrow key Left press/release) ==");
  await session.send("key", { key: "Left", mode: "press" });
  await session.send("wait", { seconds: 0.4 }, 20000);
  await session.send("key", { key: "Left", mode: "release" });
  await session.send("wait", { frames: 5 });
  const player2 = await session.send("get_node", { path: "Player" });
  check("player moved back left", player2.position[0] < player1.position[0] - 30, `x: ${player1.position[0]} -> ${player2.position[0]}`);

  console.log("== mouse_click on ScoreButton + wait_signal ==");
  const btn = await session.send("get_node", { path: "ScoreButton" });
  check("button click_position", Array.isArray(btn.click_position), JSON.stringify(btn));
  const sigPromise = session.send("wait_signal", { path: ".", signal: "score_changed", timeout: 5 }, 10000);
  await new Promise((r) => setTimeout(r, 100));
  await session.send("mouse_button", { x: btn.click_position[0], y: btn.click_position[1] });
  const sig = await sigPromise;
  check("score_changed fired", sig.fired === true && sig.args?.[0] === 1, JSON.stringify(sig));
  const label = await session.send("get_node", { path: "ScoreLabel", properties: ["text"] });
  check("score label updated", label.properties.text === "Score: 1", JSON.stringify(label.properties));

  console.log("== record_signals + more clicks ==");
  await session.send("record_signals", { path: ".", signals: ["score_changed"] });
  await session.send("mouse_button", { x: btn.click_position[0], y: btn.click_position[1] });
  await session.send("mouse_button", { x: btn.click_position[0], y: btn.click_position[1] });
  await session.send("wait", { frames: 5 });
  const sigLog = await session.send("get_signal_log", {});
  check("signal log has 2 events", sigLog.events.length === 2, JSON.stringify(sigLog));

  console.log("== input_text into LineEdit ==");
  const edit = await session.send("get_node", { path: "NameEdit" });
  await session.send("mouse_button", { x: edit.click_position[0], y: edit.click_position[1] });
  await session.send("wait", { frames: 3 });
  await session.send("type_text", { text: "Claude" });
  await session.send("wait", { frames: 3 });
  const editAfter = await session.send("get_node", { path: "NameEdit", properties: ["text"] });
  check("text typed into LineEdit", editAfter.properties.text === "Claude", JSON.stringify(editAfter.properties));

  console.log("== error capture ==");
  const errBtn = await session.send("get_node", { path: "ErrorButton" });
  await session.send("mouse_button", { x: errBtn.click_position[0], y: errBtn.click_position[1] });
  await session.send("wait", { seconds: 0.3 }, 20000);
  const errLogs = session.getLogs({ errorsOnly: true, tail: 20 });
  check("push_error captured in logs", errLogs.some((l) => l.includes("Demo error")), JSON.stringify(errLogs));

  console.log("== set_property with $expr ==");
  const setP = await session.send("set_property", { path: "Player", property: "position", value: { $expr: "Vector2(100, 100)" } });
  check("set position via expr", JSON.stringify(setP.value).includes("100"), JSON.stringify(setP));

  console.log("== call_method ==");
  const call = await session.send("call_method", { path: ".", method: "_on_score_button" });
  check("call_method ok", call !== undefined);
  const label2 = await session.send("get_node", { path: "ScoreLabel", properties: ["text"] });
  check("score now 4", label2.properties.text === "Score: 4", JSON.stringify(label2.properties));

  console.log("== eval ==");
  const ev = await session.send("eval", { expression: 'node("Player").position.x + 5' });
  check("eval works", ev.value === 105, JSON.stringify(ev));

  console.log("== perf ==");
  const perf = await session.send("perf");
  check("perf has fps", typeof perf.fps === "number" && perf.fps > 0, JSON.stringify(perf));

  console.log("== pause / time_scale ==");
  const p = await session.send("pause", { paused: true });
  check("paused", p.paused === true);
  const shotPaused = await session.send("screenshot", { max_dim: 400 }, 20000);
  check("screenshot works while paused + max_dim", shotPaused.width <= 400, `${shotPaused.width}x${shotPaused.height}`);
  await session.send("pause", { paused: false });
  const ts = await session.send("time_scale", { scale: 3 });
  check("time_scale set", ts.time_scale === 3);
  await session.send("time_scale", { scale: 1 });

  console.log("== reload_scene resets state ==");
  await session.send("reload_scene", {}, 20000);
  await session.send("wait", { frames: 5 });
  const label3 = await session.send("get_node", { path: "ScoreLabel", properties: ["text"] });
  check("score reset after reload", label3.properties.text === "Score: 0", JSON.stringify(label3.properties));

  console.log("== change_scene to same scene (only one in demo) ==");
  const cs = await session.send("change_scene", { scene: "res://main.tscn" }, 20000);
  check("change_scene ok", cs.current_scene === "res://main.tscn", JSON.stringify(cs));

  console.log("== final screenshot ==");
  const shot2 = await session.send("screenshot", {}, 20000);
  fs.writeFileSync(path.join(OUT_DIR, "shot2-final.png"), Buffer.from(shot2.png_base64, "base64"));

  console.log("== stop + cleanup ==");
  const stopped = await session.stop();
  check("stopped", stopped.stopped === true, JSON.stringify(stopped));
  check("addon removed", !fs.existsSync(path.join(DEMO, "addons", "ai_game_tester")));
  check("no backup left", !fs.existsSync(path.join(DEMO, "project.godot.ai-tester-backup")));
  check("project.godot clean", !fs.readFileSync(path.join(DEMO, "project.godot"), "utf8").includes("AiGameTester"));
} catch (e) {
  failed++;
  console.error("TEST ABORTED:", e.message);
  await session.stop().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
