// Tests look_at against giants-demo: aims the camera at the monster's weak
// points from a resting orientation, in both "input" (simulated mouse-look)
// and "set" (exact pivot) modes, and verifies the target lands near screen
// center via the returned projection + a screenshot.
// Run: node test/lookat-test.mjs <out-dir>
import fs from "node:fs";
import path from "node:path";
import { GodotSession } from "../mcp-server/src/session.js";

const PROJECT = "C:\\dev\\giants-demo";
const OUT = process.argv[2] || ".";
const PIVOT = "/root/World/Player/CameraPivot";
const CORE = "/root/World/Monster/WeakCore";
const SHIN = "/root/World/Monster/HipPivotL/WeakShinL";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}  ${d}`); } };
const session = new GodotSession();
const shot = async (l) => { const s = await session.send("screenshot", { max_dim: 800 }, 25000); fs.writeFileSync(path.join(OUT, `la-${l}.png`), Buffer.from(s.png_base64, "base64")); };
const centerDist = (screen, w, h) => Math.hypot(screen[0] - w / 2, screen[1] - h / 2);

try {
  await session.launch({ projectPath: PROJECT, windowX: 60, windowY: 60 });
  await session.send("wait", { seconds: 1.2 }, 20000);

  // Spin the camera far away from the monster so aiming has real work to do.
  await session.send("mouse_move", { relative_x: 900, relary: 0, relative_y: -120 }, 10000);
  await session.send("wait", { frames: 3 });
  await shot("0-before");
  const vp = await session.send("eval", { expression: "[get_viewport().get_visible_rect().size.x, get_viewport().get_visible_rect().size.y]" });
  const [W, H] = vp.value;
  console.log("viewport", W, H);

  console.log("== input mode (simulated mouse-look) -> core ==");
  const r1 = await session.send("look_at", { path: CORE, mode: "input" }, 15000);
  console.log("  result:", JSON.stringify(r1));
  await shot("1-input-core");
  check("input: target reported on screen", r1.on_screen === true, JSON.stringify(r1));
  check("input: target near center", centerDist(r1.screen, W, H) < W * 0.18, `dist=${centerDist(r1.screen, W, H).toFixed(0)} of W=${W}`);

  console.log("== set mode (exact pivot) -> shin ==");
  const r2 = await session.send("look_at", { path: SHIN, mode: "set", camera_node: PIVOT }, 15000);
  console.log("  result:", JSON.stringify(r2));
  await shot("2-set-shin");
  check("set: target on screen", r2.on_screen === true, JSON.stringify(r2));
  check("set: target very near center", centerDist(r2.screen, W, H) < W * 0.12, `dist=${centerDist(r2.screen, W, H).toFixed(0)}`);

  console.log("== auto mode + world coords ==");
  const mon = await session.send("eval", { expression: `[node("/root/World/Monster").global_position.x, node("/root/World/Monster").global_position.y+8, node("/root/World/Monster").global_position.z]` });
  const [mx, my, mz] = mon.value;
  const r3 = await session.send("look_at", { x: mx, y: my, z: mz }, 15000);
  console.log("  result:", JSON.stringify(r3));
  await shot("3-auto-world");
  check("auto/world: on screen", r3.on_screen === true, JSON.stringify(r3));

  console.log("== behind-camera reporting ==");
  // Look at core, then flip the pivot 180 so the core is behind the camera.
  await session.send("look_at", { path: CORE, mode: "set", camera_node: PIVOT }, 15000);
  await session.send("set_property", { path: PIVOT, property: "rotation", value: { $expr: `Vector3(node("${PIVOT}").rotation.x, node("${PIVOT}").rotation.y + PI, 0.0)` } });
  await session.send("wait", { frames: 2 });
  const proj = await session.send("eval", { expression: `get_viewport().get_camera_3d().is_position_behind(node("${CORE}").global_position)` });
  check("behind detection works", proj.value === true, JSON.stringify(proj));
  const r4 = await session.send("look_at", { path: CORE, mode: "input" }, 15000);
  check("recovers after being turned around", r4.on_screen === true, JSON.stringify(r4));

  const compact = JSON.stringify(r2);
  check("response is compact (<160 chars)", compact.length < 160, `${compact.length} chars`);
} catch (e) {
  fail++;
  console.error("ABORTED:", e.message, e.stack);
} finally {
  await session.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
