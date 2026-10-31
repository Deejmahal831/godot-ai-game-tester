// GIANT SLAYER v2 — two goals:
//  1) VERIFY the reach gap: mount the giant and measure the true minimum
//     distance from the cling surface to each weak point (rigorous proof of
//     whether climb_attack_range 3.2 can ever connect as shipped).
//  2) WIN: apply the discovered fix and fell the giant by climbing, capturing
//     the "GREAT ENEMY FELLED" screen.
// Run: node test/giant-slayer2.mjs <out-dir>
import fs from "node:fs";
import path from "node:path";
import { GodotSession } from "../mcp-server/src/session.js";

const PROJECT = "C:\\dev\\giants-demo";
const OUT = process.argv[2] || ".";
const MON = "/root/World/Monster";
const PLY = "/root/World/Player";
const PIVOT = PLY + "/CameraPivot";
const WPS = {
  shinL: MON + "/HipPivotL/WeakShinL",
  shinR: MON + "/HipPivotR/WeakShinR",
  core: MON + "/WeakCore",
  back: MON + "/WeakBack",
};
const SHIPPED_RANGE = 3.2;
const FIX_RANGE = 4.6;

const session = new GodotSession();
const t0 = Date.now();
const events = [];
const reach = {}; // wp -> min distance achievable
const log = (type, data = {}) => {
  const e = { t: +((Date.now() - t0) / 1000).toFixed(1), type, ...data };
  events.push(e);
  console.log(`[${e.t}s] ${type} ${JSON.stringify(data)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrapPi = (a) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const d2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
const evalx = async (e) => (await session.send("eval", { expression: e }, 10000)).value;

async function shot(label) {
  const s = await session.send("screenshot", { max_dim: 1000 }, 25000);
  fs.writeFileSync(path.join(OUT, `gv-${label}.png`), Buffer.from(s.png_base64, "base64"));
  log("screenshot", { label });
}
async function st() {
  const v = await evalx(
    `[node("${PLY}").health, node("${PLY}").stamina, node("${PLY}").state, node("${PLY}").grip,` +
    ` node("${PLY}").global_position.x, node("${PLY}").global_position.z,` +
    ` node("${MON}")._ai, node("${MON}").global_position.x, node("${MON}").global_position.z,` +
    ` node("${PIVOT}").rotation.y, node("${PLY}")._climb_theta, node("${PLY}")._climb_h, node("${PLY}").dead,` +
    ` node("${MON}")._remaining]`
  );
  const s = { health: v[0], stamina: v[1], pstate: v[2], grip: v[3], px: v[4], pz: v[5],
    ai: v[6], mx: v[7], mz: v[8], camYaw: v[9], theta: v[10], h: v[11], dead: v[12], remaining: v[13] };
  s.monDist = d2(s.px, s.pz, s.mx, s.mz);
  return s;
}
async function wpHp(k) { return await evalx(`node("${WPS[k]}").hp`); }
async function wpAllHp() {
  const v = await evalx("[" + Object.values(WPS).map((p) => `node("${p}").hp`).join(",") + "]");
  return { shinL: v[0], shinR: v[1], core: v[2], back: v[3] };
}
async function distToWp(k) {
  return await evalx(`node("${PLY}").global_position.distance_to(node("${WPS[k]}").global_position)`);
}

// --- movement / camera --------------------------------------------------------
let held = new Set();
let gripHeld = false;
async function setHold(want) {
  for (const a of held) if (!want.has(a)) await session.send("action", { action: a, mode: "release" });
  for (const a of want) if (!held.has(a)) await session.send("action", { action: a, mode: "press" });
  held = want;
}
const stop = () => setHold(new Set());
async function grip(on) { if (on !== gripHeld) { await session.send("action", { action: "grip", mode: on ? "press" : "release" }); gripHeld = on; } }

async function walkTo(tx, tz, tol, maxTicks) {
  for (let i = 0; i < maxTicks; i++) {
    const s = await st();
    if (s.dead) return false;
    // Dodge active strikes on the way in.
    if (s.ai === 2 || s.ai === 3 || s.ai === 5) {
      const ax = (s.px - s.mx) / s.monDist, az = (s.pz - s.mz) / s.monDist;
      await moveWorld(ax, az, s.camYaw);
      if (s.stamina >= 25 && s.monDist < 26) await session.send("action", { action: "roll", mode: "tap" });
      await sleep(220);
      continue;
    }
    const d = d2(s.px, s.pz, tx, tz);
    if (d < tol) { await stop(); return true; }
    await moveWorld((tx - s.px) / d, (tz - s.pz) / d, s.camYaw);
    await sleep(100);
  }
  await stop();
  return false;
}
async function moveWorld(dx, dz, camYaw) {
  const c = Math.cos(camYaw), s = Math.sin(camYaw);
  const ix = dx * c - dz * s, iz = dx * s + dz * c;
  const w = new Set(["run"]);
  if (ix > 0.38) w.add("move_right");
  if (ix < -0.38) w.add("move_left");
  if (iz > 0.38) w.add("move_back");
  if (iz < -0.38) w.add("move_forward");
  await setHold(w);
}

// --- climb to a weak point and, optionally, poke it ---------------------------
async function mount() {
  let s = await st();
  await walkTo(s.mx, s.mz, 8.8, 90);
  s = await st();
  if (s.monDist > 9.6) return false;
  await grip(true);
  await session.send("action", { action: "jump", mode: "tap" });
  await session.send("wait", { frames: 4 });
  s = await st();
  if (s.pstate !== 5) { await grip(false); return false; }
  log("mounted", { at_h: +s.h.toFixed(1) });
  return true;
}

async function climbToWp(k) {
  // Target cling coords from the weak point's local position.
  const loc = await evalx(
    `[node("${MON}").to_local(node("${WPS[k]}").global_position).x,` +
    ` node("${MON}").to_local(node("${WPS[k]}").global_position).y,` +
    ` node("${MON}").to_local(node("${WPS[k]}").global_position).z]`
  );
  const thetaT = Math.atan2(loc[0], loc[2]);
  const hT = Math.max(1.5, Math.min(10, loc[1]));
  for (let i = 0; i < 90; i++) {
    const s = await st();
    if (s.dead || s.pstate !== 5) return false;
    if (s.ai === 5 || s.ai === 2) { // pluck incoming — bail
      await session.send("action", { action: "jump", mode: "tap" }); await grip(false); return false;
    }
    const dTheta = wrapPi(thetaT - s.theta), dH = hT - s.h;
    if (Math.abs(dTheta) < 0.05 && Math.abs(dH) < 0.15) break;
    const w = new Set();
    if (dTheta > 0.05) w.add("move_right");
    if (dTheta < -0.05) w.add("move_left");
    if (dH > 0.15) w.add("move_forward");
    if (dH < -0.15) w.add("move_back");
    await setHold(w);
    await sleep(85);
  }
  await stop();
  return true;
}

/** Fine-search a small theta/h neighbourhood for the closest approach to wp k. */
async function probeMinReach(k) {
  let best = 999;
  const s0 = await st();
  const baseTheta = s0.theta, baseH = s0.h;
  for (const dh of [-0.6, -0.3, 0, 0.3, 0.6]) {
    for (const dt of [-0.25, -0.12, 0, 0.12, 0.25]) {
      // Nudge to (baseTheta+dt, baseH+dh)
      for (let i = 0; i < 25; i++) {
        const s = await st();
        if (s.pstate !== 5) return best;
        const dTheta = wrapPi(baseTheta + dt - s.theta), dH = baseH + dh - s.h;
        if (Math.abs(dTheta) < 0.04 && Math.abs(dH) < 0.12) break;
        const w = new Set();
        if (dTheta > 0.04) w.add("move_right");
        if (dTheta < -0.04) w.add("move_left");
        if (dH > 0.12) w.add("move_forward");
        if (dH < -0.12) w.add("move_back");
        await setHold(w);
        await sleep(70);
      }
      await stop();
      const d = await distToWp(k);
      if (d < best) best = d;
    }
  }
  return best;
}

async function pokeUntilDead(k) {
  for (let i = 0; i < 12; i++) {
    const s = await st();
    if (s.dead || s.pstate !== 5) return false;
    if (s.ai === 5 || s.ai === 2) { await session.send("action", { action: "jump", mode: "tap" }); await grip(false); return false; }
    if (s.grip < 45) { await session.send("action", { action: "jump", mode: "tap" }); await grip(false); log("bailed_grip", { grip: +s.grip.toFixed(0) }); return false; }
    if (s.stamina < 16) { await sleep(300); continue; }
    const before = await wpHp(k);
    if (before <= 0) return true;
    await session.send("action", { action: "attack", mode: "tap" });
    await sleep(430);
    const after = await wpHp(k);
    if (after < before) { log("poke_hit", { wp: k, hp: after }); if (after <= 0) return true; }
    else log("poke_whiff", { wp: k, dist: +(await distToWp(k)).toFixed(2) });
  }
  return (await wpHp(k)) <= 0;
}

async function killByClimb(k) {
  for (let attempt = 0; attempt < 6; attempt++) {
    if ((await wpHp(k)) <= 0) return true;
    if (!(await mount())) { await sleep(400); continue; }
    if (!(await climbToWp(k))) { await sleep(300); continue; }
    const done = await pokeUntilDead(k);
    // Dismount cleanly.
    const s = await st();
    if (s.pstate === 5) { await session.send("action", { action: "jump", mode: "tap" }); await grip(false); }
    await sleep(600);
    if (done) return true;
  }
  return false;
}

// ------------------------------------------------------------------ main ------
try {
  log("launch", {});
  await session.launch({ projectPath: PROJECT, windowX: 60, windowY: 60 });
  await session.send("record_signals", { path: MON, signals: ["felled"] });
  await session.send("wait", { seconds: 1.0 }, 20000);
  await shot("1-start");

  // ---- PHASE A: verify the reach gap (as shipped, range 3.2) ----
  log("phase_verify_reach", { shipped_range: SHIPPED_RANGE });
  if (await mount()) {
    for (const k of ["shinL", "core"]) { // sample a low + a high weak point
      await climbToWp(k);
      const min = await probeMinReach(k);
      reach[k] = +min.toFixed(3);
      log("reach_measured", { wp: k, min_dist: reach[k], shipped_range: SHIPPED_RANGE, reachable_as_shipped: min <= SHIPPED_RANGE });
    }
    const s = await st();
    if (s.pstate === 5) { await session.send("action", { action: "jump", mode: "tap" }); await grip(false); }
    await sleep(800);
  } else {
    log("verify_mount_failed", {});
  }

  // ---- PHASE B: apply the fix and WIN by climbing ----
  log("phase_apply_fix", { climb_attack_range: `${SHIPPED_RANGE} -> ${FIX_RANGE}` });
  await session.send("set_property", { path: PLY, property: "climb_attack_range", value: FIX_RANGE });

  const order = ["shinL", "shinR", "core", "back"];
  for (const k of order) {
    if ((await wpHp(k)) <= 0) continue;
    log("targeting", { wp: k, hp: await wpHp(k) });
    const ok = await killByClimb(k);
    log(ok ? "WEAK_POINT_DOWN" : "weak_point_failed", { wp: k, via: "climb pokes (fixed reach)" });
    if (ok) await shot(`down-${k}`);
    if ((await st()).dead) { log("died_unexpectedly", {}); break; }
  }

  await stop();
  const sig = await session.send("get_signal_log", {});
  const fin = await evalx(`[node("${MON}")._down, node("${MON}")._remaining]`);
  const glow = await evalx("[" + Object.values(WPS).map((p) => `node("${p}")._mat.emission_enabled`).join(",") + "]");
  const felledLine = session.getLogs({ tail: 400 }).filter((l) => l.includes("FELLED"));
  log("FINAL", {
    monster_down: fin[0], remaining: fin[1],
    any_weak_point_still_glowing: glow.some(Boolean),
    felled_signal_fired: sig.events.length > 0,
    felled_log: felledLine,
    reach_gap: reach,
  });
  await sleep(2800); // let "GREAT ENEMY FELLED" fade in
  await shot("victory");
} catch (e) {
  log("FATAL", { error: e.message });
  try { console.log("LAST LOGS:\n" + session.getLogs({ tail: 25 }).join("\n")); } catch {}
} finally {
  const s = await session.stop().catch(() => null);
  log("stopped", { clean: s?.stopped ?? false });
  fs.writeFileSync(path.join(OUT, "gv-events.json"), JSON.stringify({ reach, events }, null, 2));
}
