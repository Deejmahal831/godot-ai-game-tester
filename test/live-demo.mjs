// Live demo: an "AI test session" against giants-demo. Saves screenshots and a
// JSON report of every step. Run: node test/live-demo.mjs <output-dir>
import fs from "node:fs";
import path from "node:path";
import { GodotSession } from "../mcp-server/src/session.js";

const PROJECT = "C:\\dev\\giants-demo";
const OUT = process.argv[2] || ".";
const session = new GodotSession();
const report = { steps: [] };
const step = (name, data) => {
  report.steps.push({ name, ...data });
  console.log(`* ${name}: ${JSON.stringify(data)}`);
};
const shot = async (label) => {
  const s = await session.send("screenshot", { max_dim: 1000 }, 30000);
  const file = path.join(OUT, `demo-${label}.png`);
  fs.writeFileSync(file, Buffer.from(s.png_base64, "base64"));
  step(`screenshot:${label}`, { file, size: `${s.width}x${s.height}` });
};

try {
  const launch = await session.launch({ projectPath: PROJECT, windowX: 60, windowY: 60 });
  step("launch", { scene: launch.info.current_scene, godot: launch.info.godot_version, pid: launch.pid });

  await session.send("wait", { seconds: 1.5 }, 20000);
  await shot("1-spawn");

  // Discover the world.
  const tree = await session.send("get_scene_tree", { max_depth: 1 });
  step("scene_tree", { nodes: (tree.children ?? []).map((c) => `${c.name}(${c.class})`) });

  const player = await session.send("get_node", { path: "Player" });
  const monster = await session.send("get_node", { path: "Monster" });
  step("initial_state", {
    player_pos: player.position,
    player_vars: player.script_vars ? Object.keys(player.script_vars) : [],
    monster_vars: monster.script_vars ?? {},
  });
  const monsterHealthBefore = monster.script_vars?.health ?? monster.script_vars?.hp ?? null;

  // Walk toward the monster.
  await session.send("action", { action: "move_forward", mode: "press" });
  await session.send("action", { action: "run", mode: "press" });
  await session.send("wait", { seconds: 2.0 }, 20000);
  await session.send("action", { action: "run", mode: "release" });
  await session.send("action", { action: "move_forward", mode: "release" });
  const playerAfterMove = await session.send("get_node", { path: "Player" });
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  step("moved", {
    from: player.position,
    to: playerAfterMove.position,
    distance: dist(player.position, playerAfterMove.position).toFixed(2),
  });
  await shot("2-approach");

  // Attack the monster several times.
  for (let i = 0; i < 4; i++) {
    await session.send("action", { action: "attack", mode: "tap" }, 20000);
    await session.send("wait", { seconds: 0.7 }, 20000);
  }
  await shot("3-attack");

  const monsterAfter = await session.send("get_node", { path: "Monster" });
  const monsterHealthAfter = monsterAfter.script_vars?.health ?? monsterAfter.script_vars?.hp ?? null;
  step("combat_result", {
    monster_health_before: monsterHealthBefore,
    monster_health_after: monsterHealthAfter,
    damage_dealt:
      monsterHealthBefore != null && monsterHealthAfter != null
        ? monsterHealthBefore - monsterHealthAfter
        : "unknown (no health var found)",
  });

  // Jump, verify airborne via Y position.
  const yBefore = playerAfterMove.position[1];
  await session.send("action", { action: "jump", mode: "tap" }, 20000);
  await session.send("wait", { seconds: 0.3 }, 20000);
  const playerAir = await session.send("get_node", { path: "Player" });
  step("jump", { y_before: yBefore.toFixed(2), y_mid_jump: playerAir.position[1].toFixed(2) });

  const perf = await session.send("perf");
  step("performance", { fps: perf.fps, draw_calls: perf.draw_calls, nodes: perf.node_count, orphan_nodes: perf.orphan_node_count, memory_mb: perf.static_memory_mb.toFixed(1) });

  const errors = session.getLogs({ errorsOnly: true, tail: 200 }).filter((l) => !l.includes("Cone twist"));
  step("errors", { count: errors.length, sample: errors.slice(0, 3) });
} catch (e) {
  step("ABORTED", { error: e.message });
} finally {
  const stopped = await session.stop().catch(() => null);
  step("stopped_and_cleaned", {
    stopped: stopped?.stopped ?? false,
    project_clean: !fs.readFileSync(path.join(PROJECT, "project.godot"), "utf8").includes("AiGameTester"),
    addon_removed: !fs.existsSync(path.join(PROJECT, "addons", "ai_game_tester")),
  });
}
fs.writeFileSync(path.join(OUT, "demo-report.json"), JSON.stringify(report, null, 2));
console.log("report written");
