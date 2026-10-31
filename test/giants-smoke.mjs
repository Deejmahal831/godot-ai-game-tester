// Smoke test against a real 3D project (giants-demo): launch, look around,
// press movement keys, screenshot, clean stop.
import fs from "node:fs";
import path from "node:path";
import { GodotSession } from "../mcp-server/src/session.js";

const PROJECT = "C:\\dev\\giants-demo";
const OUT_DIR = process.argv[2] || ".";
const session = new GodotSession();

try {
  console.log("launching giants-demo...");
  const launch = await session.launch({ projectPath: PROJECT, windowX: 50, windowY: 50 });
  console.log("info:", JSON.stringify(launch.info));

  await session.send("wait", { seconds: 2 }, 20000); // let the world settle

  const actions = await session.send("list_actions");
  console.log("actions:", actions.actions.map((a) => a.action).join(", "));

  const shot1 = await session.send("screenshot", { max_dim: 1280 }, 30000);
  fs.writeFileSync(path.join(OUT_DIR, "giants-1.png"), Buffer.from(shot1.png_base64, "base64"));
  console.log(`screenshot 1: ${shot1.width}x${shot1.height}`);

  const tree = await session.send("get_scene_tree", { max_depth: 2 });
  console.log("scene root:", tree.name, "-", (tree.children ?? []).map((c) => `${c.name}(${c.class})`).join(", "));

  console.log("moving forward for 1.5s + camera look...");
  await session.send("action", { action: "move_forward", mode: "press" });
  await session.send("mouse_move", { relative_x: 300, relative_y: 0 });
  await session.send("wait", { seconds: 1.5 }, 20000);
  await session.send("action", { action: "move_forward", mode: "release" });
  await session.send("action", { action: "jump", mode: "tap" }, 20000);
  await session.send("wait", { seconds: 0.8 }, 20000);

  const shot2 = await session.send("screenshot", { max_dim: 1280 }, 30000);
  fs.writeFileSync(path.join(OUT_DIR, "giants-2.png"), Buffer.from(shot2.png_base64, "base64"));
  console.log(`screenshot 2: ${shot2.width}x${shot2.height}`);

  const perf = await session.send("perf");
  console.log("perf:", JSON.stringify(perf));

  console.log("errors so far:", JSON.stringify(session.getLogs({ errorsOnly: true, tail: 10 })));
} catch (e) {
  console.error("SMOKE FAILED:", e.message);
} finally {
  const stopped = await session.stop().catch((e) => ({ error: e.message }));
  console.log("stopped:", JSON.stringify(stopped));
  const pg = fs.readFileSync(path.join(PROJECT, "project.godot"), "utf8");
  console.log("project.godot clean:", !pg.includes("AiGameTester"));
  console.log("addon removed:", !fs.existsSync(path.join(PROJECT, "addons", "ai_game_tester")));
  console.log("backup removed:", !fs.existsSync(path.join(PROJECT, "project.godot.ai-tester-backup")));
}
