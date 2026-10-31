// Tests save_state / load_state on giants-demo: bookmark the player's state,
// mutate it (move + damage), restore, and confirm it reverted. Also verifies
// file persistence and that the AI-facing payloads stay tiny.
// Run: node test/savestate-test.mjs <out-dir>
import fs from "node:fs";
import path from "node:path";
import { GodotSession } from "../mcp-server/src/session.js";

const PROJECT = "C:\\dev\\giants-demo";
const OUT = process.argv[2] || ".";
const PLY = "/root/World/Player";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}  ${d}`); } };
const session = new GodotSession();
const evalx = async (e) => (await session.send("eval", { expression: e }, 10000)).value;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

try {
  await session.launch({ projectPath: PROJECT, windowX: 60, windowY: 60 });
  await session.send("wait", { seconds: 1.2 }, 20000);

  const pos0 = await evalx(`[node("${PLY}").global_position.x, node("${PLY}").global_position.z]`);
  const hp0 = await evalx(`node("${PLY}").health`);
  console.log("  start:", JSON.stringify({ pos0, hp0 }));

  console.log("== save_state ==");
  const saved = await session.saveState("bookmark", {});
  console.log("  saved summary:", JSON.stringify(saved));
  check("snapshot captured many nodes", saved.node_count > 20, JSON.stringify(saved));
  check("AI-facing summary is tiny", JSON.stringify(saved).length < 200, `${JSON.stringify(saved).length} chars`);

  console.log("== mutate: move forward + take damage ==");
  await session.send("action", { action: "move_forward", mode: "press" });
  await session.send("wait", { seconds: 1.5 }, 20000);
  await session.send("action", { action: "move_forward", mode: "release" });
  await session.send("set_property", { path: PLY, property: "health", value: 20 });
  await session.send("wait", { frames: 5 });
  const posMoved = await evalx(`[node("${PLY}").global_position.x, node("${PLY}").global_position.z]`);
  const hpMoved = await evalx(`node("${PLY}").health`);
  const movedDist = Math.hypot(posMoved[0] - pos0[0], posMoved[1] - pos0[1]);
  check("player actually moved", movedDist > 5, `moved ${movedDist.toFixed(2)}`);
  check("health actually changed", hpMoved < hp0 - 50, `hp=${hpMoved} (regen may nudge it up from 20)`);

  console.log("== load_state (in place) ==");
  const loaded = await session.loadState({ name: "bookmark" });
  console.log("  restore:", JSON.stringify(loaded));
  await session.send("wait", { frames: 5 });
  const posBack = await evalx(`[node("${PLY}").global_position.x, node("${PLY}").global_position.z]`);
  const hpBack = await evalx(`node("${PLY}").health`);
  const backDist = Math.hypot(posBack[0] - pos0[0], posBack[1] - pos0[1]);
  check("applied many properties", loaded.applied > 20, JSON.stringify(loaded));
  check("position restored", backDist < 1.0, `off by ${backDist.toFixed(2)} (was ${movedDist.toFixed(2)} away)`);
  check("health restored", near(hpBack, hp0, 0.5), `hp ${hpBack} vs ${hp0}`);

  console.log("== file persistence ==");
  const file = path.join(OUT, "state-bookmark.json");
  await session.saveState("tofile", { savePath: file });
  check("state file written", fs.existsSync(file) && fs.statSync(file).size > 500);
  // Mutate then restore from the file (fresh Map key path).
  await session.send("set_property", { path: PLY, property: "health", value: 5 });
  const loadedFile = await session.loadState({ path: file });
  const hpFromFile = await evalx(`node("${PLY}").health`);
  check("restored from file", near(hpFromFile, hp0, 0.5), `hp ${hpFromFile} vs ${hp0}, loaded=${JSON.stringify(loadedFile)}`);

  console.log("== list_states ==");
  const list = session.listStates();
  check("list shows saved states", list.some((s) => s.name === "bookmark"), JSON.stringify(list));

  console.log("== include_autoloads option ==");
  const withAuto = await session.saveState("withauto", { includeAutoloads: true });
  const without = await session.saveState("noauto", { includeAutoloads: false });
  check("autoloads add nodes to snapshot", withAuto.node_count >= without.node_count, JSON.stringify({ withAuto: withAuto.node_count, without: without.node_count }));
} catch (e) {
  fail++;
  console.error("ABORTED:", e.message, e.stack);
} finally {
  await session.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
