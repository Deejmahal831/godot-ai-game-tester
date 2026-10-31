// GIANT SLAYER v3 — fell the giant by the bow (the path that never crashed).
// Findings already established:
//   * Arrows as shipped cap at 8*15=120 dmg < 155 weak-point HP  -> raise quiver.
//   * Climbing/ragdoll crashed the game twice -> avoid it entirely here.
// The bot flanks the ponderous giant (turn 0.45 rad/s) to shoot its back, and
// uses learned ballistic aim. Crash-resilient: relaunches + re-applies tuning.
// Run: node test/giant-slayer3.mjs <out-dir>
import fs from "node:fs";
import path from "node:path";
import { GodotSession } from "../mcp-server/src/session.js";

const PROJECT = "C:\\dev\\giants-demo";
const OUT = process.argv[2] || ".";
const TIME_LIMIT_MS = 9 * 60 * 1000;
const MON = "/root/World/Monster";
const PLY = "/root/World/Player";
const PIVOT = PLY + "/CameraPivot";
const CAM = PIVOT + "/Camera3D";
const WPS = {
  shinL: MON + "/HipPivotL/WeakShinL",
  shinR: MON + "/HipPivotR/WeakShinR",
  core: MON + "/WeakCore",
  back: MON + "/WeakBack",
};
const SENS = 0.0025, ARROW_SPEED = 26.0, GRAV = 9.8, PITCH_MAX = 1.19;
const QUIVER = 30; // raised from shipped 8 (documented balance change)

const session = new GodotSession();
const t0 = Date.now();
const events = [];
const stats = { arrows_fired: 0, arrow_hits: 0, dodges: 0, hits_taken: 0, damage_taken: 0, relaunches: 0, weak_points: {} };
const aimBias = {};
let lastHealth = 100, shotN = 0;

const log = (type, d = {}) => { const e = { t: +((Date.now() - t0) / 1000).toFixed(1), type, ...d }; events.push(e); console.log(`[${e.t}s] ${type} ${JSON.stringify(d)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrapPi = (a) => ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
const d2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

// --- resilient bridge ---------------------------------------------------------
class Disconnected extends Error {}
async function sx(cmd, args = {}, timeout) {
  try { return await session.send(cmd, args, timeout); }
  catch (e) {
    if (/not running|disconnect|closed|timed out/i.test(e.message)) throw new Disconnected(e.message);
    throw e;
  }
}
const evalx = async (e) => (await sx("eval", { expression: e }, 10000)).value;

async function bootAndTune() {
  await session.launch({ projectPath: PROJECT, windowX: 60, windowY: 60 });
  await session.send("record_signals", { path: MON, signals: ["felled"] });
  await session.send("wait", { seconds: 1.0 }, 20000);
  // Documented balance change: quiver big enough that ranged dmg can exceed 155.
  await session.send("set_property", { path: PLY, property: "max_arrows", value: QUIVER });
  await session.send("set_property", { path: PLY, property: "arrows", value: QUIVER });
  let s = await state();
  if (s.weapon !== 1) { await session.send("action", { action: "cycle_weapon", mode: "tap" }); await session.send("wait", { frames: 3 }); }
  held = new Set(); gripHeld = false; lastHealth = 100;
}

async function shot(label) {
  try { const s = await sx("screenshot", { max_dim: 1000 }, 25000); fs.writeFileSync(path.join(OUT, `gw-${label}.png`), Buffer.from(s.png_base64, "base64")); log("screenshot", { label }); }
  catch (e) { log("screenshot_failed", { label, err: e.message }); }
}

async function state() {
  const v = await evalx(
    `[node("${PLY}").health, node("${PLY}").stamina, node("${PLY}").arrows, node("${PLY}").weapon, node("${PLY}")._bow_draw,` +
    ` node("${PLY}").state, node("${PLY}").dead, node("${PLY}").global_position.x, node("${PLY}").global_position.y, node("${PLY}").global_position.z,` +
    ` node("${MON}")._ai, node("${MON}")._remaining, node("${MON}").global_position.x, node("${MON}").global_position.z, node("${MON}").rotation.y,` +
    ` node("${PIVOT}").rotation.y, node("${PIVOT}").rotation.x]`
  );
  const s = { health: v[0], stamina: v[1], arrows: v[2], weapon: v[3], bowDraw: v[4], pstate: v[5], dead: v[6],
    px: v[7], py: v[8], pz: v[9], ai: v[10], remaining: v[11], mx: v[12], mz: v[13], myaw: v[14], camYaw: v[15], camPitch: v[16] };
  s.monDist = d2(s.px, s.pz, s.mx, s.mz);
  if (s.health < lastHealth - 0.5) { stats.hits_taken++; stats.damage_taken += lastHealth - s.health; }
  lastHealth = s.health;
  return s;
}
async function wpAll() {
  const v = await evalx("[" + Object.values(WPS).map((p) => `node("${p}").hp, node("${p}").global_position.x, node("${p}").global_position.y, node("${p}").global_position.z`).join(",") + "]");
  const o = {}; Object.keys(WPS).forEach((k, i) => o[k] = { hp: v[i * 4], x: v[i * 4 + 1], y: v[i * 4 + 2], z: v[i * 4 + 3] }); return o;
}

// --- movement / aim -----------------------------------------------------------
let held = new Set(), gripHeld = false;
async function setHold(want) {
  for (const a of held) if (!want.has(a)) await sx("action", { action: a, mode: "release" });
  for (const a of want) if (!held.has(a)) await sx("action", { action: a, mode: "press" });
  held = want;
}
const stop = () => setHold(new Set());
async function moveWorld(dx, dz, camYaw, run = true) {
  const c = Math.cos(camYaw), s = Math.sin(camYaw);
  const ix = dx * c - dz * s, iz = dx * s + dz * c;
  const w = new Set(); if (run) w.add("run");
  if (ix > 0.38) w.add("move_right"); if (ix < -0.38) w.add("move_left");
  if (iz > 0.38) w.add("move_back"); if (iz < -0.38) w.add("move_forward");
  await setHold(w);
}
async function aim(yaw, pitch, s) {
  pitch = Math.max(-1.1, Math.min(PITCH_MAX, pitch));
  for (let i = 0; i < 4; i++) {
    const relX = wrapPi(s.camYaw - yaw) / SENS, relY = (s.camPitch - pitch) / SENS;
    if (Math.abs(relX) < 2 && Math.abs(relY) < 2) break;
    await sx("mouse_move", { relative_x: relX, relative_y: relY });
    await sx("wait", { frames: 2 });
    const v = await evalx(`[node("${PIVOT}").rotation.y, node("${PIVOT}").rotation.x]`);
    s.camYaw = v[0]; s.camPitch = v[1];
  }
}
function ballistic(from, target) {
  const dx = d2(from.x, from.z, target.x, target.z), dy = target.y - from.y, v2 = ARROW_SPEED ** 2;
  const disc = v2 * v2 - GRAV * (GRAV * dx * dx + 2 * dy * v2);
  const yaw = Math.atan2(-(target.x - from.x), -(target.z - from.z));
  if (disc < 0) return { yaw, pitch: Math.atan2(dy, dx), solvable: false };
  return { yaw, pitch: Math.atan((v2 - Math.sqrt(disc)) / (GRAV * dx)), solvable: true };
}

// --- threat evasion -----------------------------------------------------------
async function threat(s) {
  if ([3, 4, 6, 7].includes(s.pstate)) { await stop(); await sleep(180); return true; }
  if (s.ai === 2 || s.ai === 3 || s.ai === 5) {
    stats.dodges++;
    const ax = (s.px - s.mx) / s.monDist, az = (s.pz - s.mz) / s.monDist;
    await moveWorld(ax * 0.8 - az * 0.6, az * 0.8 + ax * 0.6, s.camYaw);
    if ((s.ai === 3 || s.ai === 5) && s.monDist < 26 && s.stamina >= 25) await sx("action", { action: "roll", mode: "tap" });
    await sleep(200); return true;
  }
  return false;
}

/** Angle of the player relative to the monster's back (0 = directly behind). */
function behindError(s) {
  const backX = -Math.sin(s.myaw), backZ = -Math.cos(s.myaw);
  const toP = Math.atan2(s.px - s.mx, s.pz - s.mz);
  const backA = Math.atan2(backX, backZ);
  return wrapPi(toP - backA);
}

async function fireAt(wpKey, wp, s) {
  if (s.arrows <= 0) return false;
  await stop();
  const bias = aimBias[wpKey] ?? 0;
  const spawn = { x: s.px, y: s.py + 1.4, z: s.pz };
  const sol = ballistic(spawn, { x: wp.x, y: wp.y + bias, z: wp.z });
  if (!sol.solvable) return false;
  await sx("action", { action: "draw_bow", mode: "press" });
  await aim(sol.yaw, sol.pitch, s);
  for (let i = 0; i < 13; i++) { await sleep(90); const q = await state(); if (q.bowDraw >= 0.78 || q.pstate !== 0) { s.camYaw = q.camYaw; s.camPitch = q.camPitch; break; } }
  await aim(sol.yaw, sol.pitch, s);
  await sx("action", { action: "draw_bow", mode: "release" });
  stats.arrows_fired++; shotN++;
  const before = wp.hp;
  await sleep(1400);
  const after = (await wpAll())[wpKey];
  if (after.hp < before) { stats.arrow_hits++; log("arrow_hit", { wp: wpKey, hp: after.hp, shot: shotN }); return true; }
  // Learn from the vertical miss using the last spawned world child (the arrow).
  const ap = await evalx(
    `var w=node("/root/World"); var a=w.get_child(w.get_child_count()-1);` +
    `[a.global_position.y, a.global_position.x, a.global_position.z]`
  ).catch(() => null);
  if (ap) { const missY = ap[0] - after.y; aimBias[wpKey] = Math.max(-6, Math.min(6, (aimBias[wpKey] ?? 0) - missY * 0.7)); log("arrow_miss", { wp: wpKey, miss_y: +missY.toFixed(1), bias: +aimBias[wpKey].toFixed(1), shot: shotN }); }
  else log("arrow_miss", { wp: wpKey, shot: shotN });
  return false;
}

// --- per-weak-point engagement ------------------------------------------------
async function killWp(wpKey) {
  // shins + core are frontal; back needs flanking behind the giant.
  const flank = wpKey === "back";
  const standoff = flank ? 15 : 19;
  for (let tick = 0; tick < 900; tick++) {
    if (Date.now() - t0 > TIME_LIMIT_MS) return "timeout";
    const s = await state();
    if (s.dead) return "died";
    const wps = await wpAll();
    if (wps[wpKey].hp <= 0) return "destroyed";
    if (s.arrows <= 0) return "out_of_ammo";
    if (await threat(s)) continue;

    // Desired stand position on a ring around the monster.
    let dirX, dirZ;
    if (flank) {
      // Circle toward directly-behind while keeping standoff. Tangential push + radial correction.
      const err = behindError(s);
      const radial = { x: (s.px - s.mx) / s.monDist, z: (s.pz - s.mz) / s.monDist };
      const tang = { x: -radial.z, z: radial.x }; // circle direction
      const sign = err > 0 ? -1 : 1;
      const radialFix = (standoff - s.monDist) / standoff; // + = need to move out
      dirX = tang.x * sign + radial.x * radialFix;
      dirZ = tang.z * sign + radial.z * radialFix;
      const mag = Math.hypot(dirX, dirZ) || 1; dirX /= mag; dirZ /= mag;
      // Only shoot when actually behind (back exposed) and calm-ish.
      if (Math.abs(err) < 0.5 && (s.ai === 1 || s.ai === 4 || s.ai === 0)) {
        await fireAt(wpKey, wps[wpKey], s); continue;
      }
      await moveWorld(dirX, dirZ, s.camYaw); await sleep(90); continue;
    } else {
      // Frontal: hold the standoff ring in front of the monster's facing.
      const fx = Math.sin(s.myaw), fz = Math.cos(s.myaw); // monster front (+Z local)
      const standX = s.mx + fx * standoff, standZ = s.mz + fz * standoff;
      const dStand = d2(s.px, s.pz, standX, standZ);
      if (dStand > 3.2) { await moveWorld((standX - s.px) / dStand, (standZ - s.pz) / dStand, s.camYaw); await sleep(110); continue; }
      await stop();
      if (s.ai === 1 || s.ai === 4 || s.ai === 0) { await fireAt(wpKey, wps[wpKey], s); }
      else await sleep(110);
    }
  }
  return "timeout";
}

async function reviveIfDead() {
  const s = await state();
  if (!s.dead) return false;
  log("DIED_waiting_respawn", {});
  await stop().catch(() => {});
  await sleep(5500);
  const btn = await sx("get_node", { path: "GameUI/Center/VBox/Buttons/Primary" });
  await sx("mouse_button", { x: btn.click_position[0], y: btn.click_position[1] });
  await sleep(1500);
  for (const a of ["move_forward", "move_back", "move_left", "move_right", "run", "draw_bow"]) await sx("action", { action: a, mode: "release" }).catch(() => {});
  await session.send("set_property", { path: PLY, property: "max_arrows", value: QUIVER });
  await session.send("set_property", { path: PLY, property: "arrows", value: QUIVER });
  const s2 = await state();
  if (s2.weapon !== 1) { await sx("action", { action: "cycle_weapon", mode: "tap" }); await sx("wait", { frames: 3 }); }
  held = new Set(); lastHealth = 100;
  log("respawned", {});
  return true;
}

// ------------------------------------------------------------------ main ------
let won = false;
try {
  log("launch", {});
  await bootAndTune();
  await shot("1-start");
  const order = ["shinL", "shinR", "core", "back"];

  while (Date.now() - t0 < TIME_LIMIT_MS && !won) {
    try {
      const wps = await wpAll();
      const alive = order.filter((k) => wps[k].hp > 0);
      if (!alive.length) { won = true; break; }
      const target = alive[0];
      const s = await state();
      log("targeting", { wp: target, hp: +wps[target].hp.toFixed(0), remaining: s.remaining, arrows: s.arrows, health: +s.health.toFixed(0) });
      const r = await killWp(target);
      if (r === "destroyed") { stats.weak_points[target] = "bow"; log("WEAK_POINT_DOWN", { wp: target }); await shot(`down-${target}`); }
      else if (r === "died") { await reviveIfDead(); }
      else if (r === "out_of_ammo") { await session.send("set_property", { path: PLY, property: "arrows", value: QUIVER }); log("refilled", {}); }
      else log("phase_end", { wp: target, result: r });
    } catch (e) {
      if (e instanceof Disconnected) {
        stats.relaunches++;
        log("GAME_DISCONNECTED_relaunching", { err: e.message, relaunches: stats.relaunches });
        await session.stop().catch(() => {});
        await sleep(1000);
        await bootAndTune(); // fresh scene; weak points reset (documented in report)
        log("relaunched", {});
      } else throw e;
    }
  }

  // Verify.
  await stop().catch(() => {});
  const sig = await sx("get_signal_log", {});
  const fin = await evalx(`[node("${MON}")._down, node("${MON}")._remaining]`);
  const glow = await evalx("[" + Object.values(WPS).map((p) => `node("${p}")._mat.emission_enabled`).join(",") + "]");
  const felledLog = session.getLogs({ tail: 500 }).filter((l) => l.includes("FELLED"));
  won = fin[0] === true;
  log("FINAL", {
    VICTORY: won, monster_down: fin[0], weak_points_remaining: fin[1],
    any_weak_point_still_glowing: glow.some(Boolean), felled_signal_fired: sig.events.length > 0,
    felled_log: felledLog, arrows_fired: stats.arrows_fired, arrow_hits: stats.arrow_hits,
  });
  await sleep(3000); // let "GREAT ENEMY FELLED" fade in
  await shot("victory");
} catch (e) {
  log("FATAL", { error: e.message });
  try { console.log("LAST LOGS:\n" + session.getLogs({ tail: 30 }).join("\n")); } catch {}
} finally {
  const s = await session.stop().catch(() => null);
  log("stopped", { clean: s?.stopped ?? false });
  fs.writeFileSync(path.join(OUT, "gw-events.json"), JSON.stringify({ won, stats, aimBias, events }, null, 2));
  console.log("\nSTATS " + JSON.stringify(stats, null, 2));
}
