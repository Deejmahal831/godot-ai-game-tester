// Drives giants-demo entirely with the virtual gamepad: left stick to move,
// right stick to turn the camera, and the A button to jump. Verifies each via
// the game's own state (player position, camera yaw, on-floor / height).
// Run: node test/gamepad-test.mjs <out-dir>
import fs from "node:fs";
import path from "node:path";
import { GodotSession } from "../mcp-server/src/session.js";

const PROJECT = "C:\\dev\\giants-demo";
const OUT = process.argv[2] || ".";
const PLY = "/root/World/Player";
const PIVOT = "/root/World/Player/CameraPivot";

let pass = 0, fail = 0;
const check = (n, c, d = "") => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}  ${d}`); } };
const session = new GodotSession();
const evalx = async (e) => (await session.send("eval", { expression: e }, 10000)).value;
const shot = async (l) => { const s = await session.send("screenshot", { max_dim: 700 }, 25000); fs.writeFileSync(path.join(OUT, `gp-${l}.png`), Buffer.from(s.png_base64, "base64")); };

try {
  await session.launch({ projectPath: PROJECT, windowX: 60, windowY: 60 });
  await session.send("wait", { seconds: 1.2 }, 20000);

  console.log("== left stick: move forward ==");
  const p0 = await evalx(`[node("${PLY}").global_position.x, node("${PLY}").global_position.z]`);
  await session.send("joy_stick", { stick: "left", y: -1.0 }, 10000); // hold forward
  await session.send("wait", { seconds: 1.2 }, 20000);
  await session.send("joy_stick", { stick: "left", x: 0, y: 0 }, 10000); // release
  await session.send("wait", { frames: 5 });
  const p1 = await evalx(`[node("${PLY}").global_position.x, node("${PLY}").global_position.z]`);
  const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  check("left stick moved the player", moved > 3, `moved=${moved.toFixed(2)} from ${JSON.stringify(p0)} to ${JSON.stringify(p1)}`);
  await shot("1-moved");

  console.log("== right stick: turn the camera ==");
  const yaw0 = await evalx(`node("${PIVOT}").rotation.y`);
  await session.send("joy_stick", { stick: "right", x: 1.0, duration: 0.8 }, 10000); // flick camera right, auto-return
  await session.send("wait", { frames: 5 });
  const yaw1 = await evalx(`node("${PIVOT}").rotation.y`);
  check("right stick rotated the camera", Math.abs(yaw1 - yaw0) > 0.2, `yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}`);

  console.log("== A button: jump ==");
  const onFloor0 = await evalx(`node("${PLY}").is_on_floor()`);
  const y0 = await evalx(`node("${PLY}").global_position.y`);
  await session.send("joy_button", { button: "a", mode: "tap" }, 10000);
  // Sample height a few frames later — jumping lifts the player off the floor.
  let airborne = false, maxY = y0;
  for (let i = 0; i < 12; i++) {
    await session.send("wait", { frames: 2 });
    const y = await evalx(`node("${PLY}").global_position.y`);
    if (y > maxY) maxY = y;
    if (!(await evalx(`node("${PLY}").is_on_floor()`))) airborne = true;
  }
  check("A button caused a jump", airborne || maxY > y0 + 0.3, `startFloor=${onFloor0} y0=${y0.toFixed(2)} maxY=${maxY.toFixed(2)} airborne=${airborne}`);

  console.log("== trigger axis: draw bow (rt) ==");
  // giants-demo binds draw_bow to right trigger axis 5. Switch to bow first.
  const weapon = await evalx(`node("${PLY}").weapon`);
  if (weapon !== 1) { await session.send("joy_button", { button: "y", mode: "tap" }, 10000).catch(() => {}); }
  await evalx(`node("${PLY}").set("weapon", 1)`).catch(() => {});
  await session.send("joy_axis", { axis: "rt", value: 1.0 }, 10000);
  await session.send("wait", { seconds: 0.5 }, 20000);
  const drawing = await evalx(`node("${PLY}")._bow_draw`);
  await session.send("joy_axis", { axis: "rt", value: 0.0 }, 10000);
  check("right trigger registered (bow draw > 0)", typeof drawing === "number" && drawing > 0.05, `bow_draw=${drawing}`);

  console.log("== raw index + release-all sanity ==");
  const byIndex = await session.send("joy_button", { button: 0, mode: "tap" }, 10000); // A by raw index
  check("raw button index works", byIndex.button === 0, JSON.stringify(byIndex));
  const unknown = await session.send("joy_button", { button: "nope" }, 5000).then(() => "no-error").catch((e) => e.message);
  check("unknown button name errors clearly", /Unknown button/.test(unknown), unknown);
} catch (e) {
  fail++;
  console.error("ABORTED:", e.message, e.stack);
} finally {
  await session.stop().catch(() => {});
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
