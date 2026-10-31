// Performance benchmark for the Godot AI Game Tester bridge.
// Times each operation category against a real game so we optimize with data.
// Run: node test/benchmark.mjs [projectPath]
import { performance } from "node:perf_hooks";
import { GodotSession } from "../mcp-server/src/session.js";

const PROJECT = process.argv[2] || "C:\\dev\\giants-demo";
// Simulate a heavy, low-fps game (like Realms) to expose frame-gating.
const FPS_CAP = process.argv[3] ? Number(process.argv[3]) : 0;
const session = new GodotSession();

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { n: s.length, min: +s[0].toFixed(1), median: +pct(50).toFixed(1), mean: +(sum / s.length).toFixed(1), p90: +pct(90).toFixed(1), max: +s[s.length - 1].toFixed(1) };
}

async function bench(label, fn, iters) {
  // warmup
  await fn();
  const times = [];
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  const st = stats(times);
  console.log(`  ${label.padEnd(34)} median ${String(st.median).padStart(7)}ms   p90 ${String(st.p90).padStart(7)}ms   (min ${st.min}, max ${st.max}, n=${st.n})`);
  return { label, ...st };
}

const results = {};
try {
  console.log(`\nProject: ${PROJECT}`);
  console.log("== launch (cold) ==");
  const tLaunch = performance.now();
  const launch = await session.launch({ projectPath: PROJECT, windowX: 60, windowY: 60, fpsCap: FPS_CAP || undefined });
  if (FPS_CAP) console.log(`  (render fps capped to ${FPS_CAP} to simulate a heavy game)`);
  const launchMs = performance.now() - tLaunch;
  console.log(`  launch_game (boot + inject + connect)   ${launchMs.toFixed(0)}ms`);
  results.launch_ms = +launchMs.toFixed(0);
  await session.send("wait", { seconds: 1.0 }, 20000);

  const perf = await session.send("perf");
  console.log(`  game fps: ${perf.fps.toFixed(0)}  (frame time ~${(1000 / perf.fps).toFixed(1)}ms)`);
  results.game_fps = Math.round(perf.fps);

  console.log("\n== per-op latency ==");
  results.ping = await bench("ping (pure round-trip)", () => session.send("ping"), 60);
  results.eval_small = await bench("eval (1 number)", () => session.send("eval", { expression: "1+1" }), 40);
  results.eval_array = await bench("eval (8-field array)", () => session.send("eval", { expression: '[node("/root/World/Player").health, node("/root/World/Player").stamina, node("/root/World/Player").global_position.x, node("/root/World/Player").global_position.y, node("/root/World/Player").global_position.z, node("/root/World/Monster")._remaining, node("/root/World/Player").state, node("/root/World/Player").weapon]' }), 40);
  results.get_node = await bench("get_node (Player)", () => session.send("get_node", { path: "/root/World/Player" }), 40);
  results.tree_shallow = await bench("get_scene_tree (depth 2)", () => session.send("get_scene_tree", { max_depth: 2 }), 15);
  results.tree_full = await bench("get_scene_tree (full)", () => session.send("get_scene_tree", {}), 15);
  results.action = await bench("input_action (press, no wait)", () => session.send("action", { action: "jump", mode: "press" }), 30);

  console.log("\n== screenshots: PNG vs JPG ==");
  results.shot_full = await bench("screenshot PNG (full res)", () => session.send("screenshot", {}, 20000), 15);
  results.shot_full_jpg = await bench("screenshot JPG (full res)", () => session.send("screenshot", { format: "jpg" }, 20000), 15);
  results.shot_800 = await bench("screenshot PNG (800)", () => session.send("screenshot", { max_dim: 800 }, 20000), 15);
  results.shot_800_jpg = await bench("screenshot JPG (800)", () => session.send("screenshot", { max_dim: 800, format: "jpg" }, 20000), 15);
  results.shot_480_jpg = await bench("screenshot JPG (480)", () => session.send("screenshot", { max_dim: 480, format: "jpg" }, 20000), 15);
  // Payload sizes (transfer cost).
  const png = await session.send("screenshot", { max_dim: 800 }, 20000);
  const jpg = await session.send("screenshot", { max_dim: 800, format: "jpg" }, 20000);
  console.log(`  payload @800: PNG ${(png.png_base64.length / 1024).toFixed(0)}KB  vs  JPG ${(jpg.png_base64.length / 1024).toFixed(0)}KB`);

  console.log("\n== batch: N ops in one round trip ==");
  const readCmds = ["health", "stamina", "state", "weapon", "global_position.x", "global_position.z"].map((f) => ({ cmd: "eval", args: { expression: `node("/root/World/Player").${f}` } }));
  results.batch6 = await bench("batch of 6 reads (1 round trip)", () => session.send("batch", { commands: readCmds }, 20000), 20);
  console.log(`  vs 6 separate reads measured below in 'realistic read pattern'`);

  console.log("\n== state snapshots ==");
  results.save = await bench("save_state (giants ~139 nodes)", () => session.saveState("bench", {}), 8);
  results.load = await bench("load_state", () => session.loadState({ name: "bench" }), 8);

  console.log("\n== round-trip throughput (frame-gating check) ==");
  const N = 50;
  const tSeq = performance.now();
  for (let i = 0; i < N; i++) await session.send("ping");
  const seqMs = performance.now() - tSeq;
  console.log(`  ${N} sequential pings: ${seqMs.toFixed(0)}ms total = ${(seqMs / N).toFixed(1)}ms/op`);
  results.seq_ping_per_op = +(seqMs / N).toFixed(1);

  // How many reads a typical "look at the situation" costs today vs. batched-in-eval.
  console.log("\n== realistic read pattern ==");
  const tMany = performance.now();
  for (const f of ["health", "stamina", "state", "weapon", "global_position.x", "global_position.z"]) {
    await session.send("eval", { expression: `node("/root/World/Player").${f}` });
  }
  const manyMs = performance.now() - tMany;
  const tOne = performance.now();
  await session.send("eval", { expression: '[node("/root/World/Player").health, node("/root/World/Player").stamina, node("/root/World/Player").state, node("/root/World/Player").weapon, node("/root/World/Player").global_position.x, node("/root/World/Player").global_position.z]' });
  const oneMs = performance.now() - tOne;
  console.log(`  6 separate evals: ${manyMs.toFixed(0)}ms   vs   1 batched eval: ${oneMs.toFixed(0)}ms   (${(manyMs / oneMs).toFixed(1)}x)`);
  results.read_6_separate_ms = +manyMs.toFixed(0);
  results.read_1_batched_ms = +oneMs.toFixed(0);

  console.log("\n== SUMMARY (median ms) ==");
  for (const k of ["ping", "eval_small", "eval_array", "get_node", "tree_shallow", "tree_full", "action", "shot_full", "shot_800", "shot_480", "shot_320", "save", "load"]) {
    if (results[k]) console.log(`  ${k.padEnd(16)} ${results[k].median}ms`);
  }
  console.log(`  launch           ${results.launch_ms}ms`);
  console.log(`  game_fps         ${results.game_fps}`);
} catch (e) {
  console.error("BENCH ERROR:", e.message, e.stack);
} finally {
  await session.stop().catch(() => {});
  console.log("\n(stopped)");
}
