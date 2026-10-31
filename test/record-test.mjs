// Records real gameplay in the demo project into an animated GIF + contact
// sheet, exercising both manual start/stop and the auto-record path.
// Run: node test/record-test.mjs <out-dir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GodotSession } from "../mcp-server/src/session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = path.resolve(__dirname, "..", "demo-project");
const OUT = process.argv[2] || __dirname;

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}  ${d}`); } };

const session = new GodotSession();
try {
  console.log("== manual recording ==");
  await session.launch({ projectPath: DEMO, windowX: 50, windowY: 50 });
  session.recorder.start({ fps: 12, max_dim: 400 });
  check("recording active", session.recorder.status.recording);

  // Drive the player around so there's visible motion to capture.
  for (const [action, dur] of [["ui_right", 0.6], ["ui_down", 0.6], ["ui_left", 0.6], ["ui_up", 0.6]]) {
    await session.send("action", { action, mode: "hold", duration: dur }, 20000);
  }
  // Click the score button a couple times (UI motion).
  const btn = await session.send("get_node", { path: "ScoreButton" });
  await session.send("mouse_button", { x: btn.click_position[0], y: btn.click_position[1] });
  await session.send("wait", { seconds: 0.4 }, 20000);
  await session.send("mouse_button", { x: btn.click_position[0], y: btn.click_position[1] });
  await session.send("wait", { seconds: 0.4 }, 20000);

  const st = session.recorder.status;
  console.log("  captured:", JSON.stringify(st));
  check("frames captured", st.frames > 10, JSON.stringify(st));

  session.recorder.stopCapture();
  const gif = await session.recorder.encodeGif(path.join(OUT, "rec-manual.gif"), {});
  console.log("  gif:", JSON.stringify(gif));
  check("gif file exists", fs.existsSync(gif.path));
  check("gif has multiple frames", gif.frames > 10, `${gif.frames}`);
  check("gif is a real GIF (header)", fs.readFileSync(gif.path).slice(0, 6).toString("ascii").startsWith("GIF89a"));
  check("gif nontrivial size", gif.bytes > 2000, `${gif.bytes}`);

  const sheet = session.recorder.buildContactSheet({ count: 9 });
  fs.writeFileSync(path.join(OUT, "rec-contact.png"), sheet.png);
  check("contact sheet PNG written", sheet.png.length > 2000 && sheet.tiles > 1, JSON.stringify({ tiles: sheet.tiles }));

  await session.stop();

  console.log("== auto recording ==");
  const launch = await session.launch({ projectPath: DEMO, windowX: 50, windowY: 50, autoRecord: { fps: 10, max_dim: 360 } });
  check("auto recording started on launch", launch.auto_recording === true, JSON.stringify(launch.auto_recording));
  for (const [action, dur] of [["ui_right", 0.8], ["ui_up", 0.8]]) {
    await session.send("action", { action, mode: "hold", duration: dur }, 20000);
  }
  const stopped = await session.stop();
  console.log("  stop.recording:", JSON.stringify(stopped.recording));
  check("auto gif produced on stop", stopped.recording && !stopped.recording.error && fs.existsSync(stopped.recording.path), JSON.stringify(stopped.recording));
  if (stopped.recording?.path) fs.copyFileSync(stopped.recording.path, path.join(OUT, "rec-auto.gif"));

  check("demo project clean", !fs.readFileSync(path.join(DEMO, "project.godot"), "utf8").includes("AiGameTester"));
  check("addon removed", !fs.existsSync(path.join(DEMO, "addons", "ai_game_tester")));
} catch (e) {
  fail++;
  console.error("ABORTED:", e.message, e.stack);
  await session.stop().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
