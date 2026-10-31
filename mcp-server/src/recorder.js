import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PNG } from "pngjs";
import gifenc from "gifenc";

// gifenc ships as CommonJS; its named exports arrive on the default export.
const { GIFEncoder, quantize, applyPalette } = gifenc;

/**
 * Captures frames from the running game (via the bridge screenshot command) on
 * an interval and encodes them into an animated GIF. Also produces a contact
 * sheet (grid of sampled frames) so an AI can review motion, not just a still.
 *
 * Frames are stored as compressed PNG buffers during capture (cheap on memory)
 * and decoded only at encode time.
 */
export class Recorder {
  constructor(session) {
    this.session = session;
    this.active = false;
    this.frames = []; // { png: Buffer, t: ms-since-start }
    this.opts = null;
    this._loop = null;
    this._startedAt = 0;
    this._droppedForCap = 0;
    this._captureErrors = 0;
  }

  get status() {
    return {
      recording: this.active,
      frames: this.frames.length,
      elapsed_seconds: this.active ? +((Date.now() - this._startedAt) / 1000).toFixed(1) : 0,
      fps_target: this.opts?.fps ?? null,
      dropped_for_cap: this._droppedForCap,
      capture_errors: this._captureErrors,
    };
  }

  start(opts = {}) {
    if (this.active) throw new Error("Already recording. Call stop_recording first.");
    this.opts = {
      fps: Math.max(1, Math.min(30, opts.fps ?? 10)),
      max_dim: opts.max_dim ?? 480,
      max_frames: Math.max(1, opts.max_frames ?? 600),
      max_seconds: opts.max_seconds ?? 120,
    };
    this.frames = [];
    this._droppedForCap = 0;
    this._captureErrors = 0;
    this._startedAt = Date.now();
    this.active = true;
    this._runLoop();
    return { ...this.status, options: this.opts };
  }

  async _runLoop() {
    const interval = 1000 / this.opts.fps;
    while (this.active) {
      const tick = Date.now();
      // Stop conditions.
      if (this.frames.length >= this.opts.max_frames) {
        this._droppedForCap++;
        break;
      }
      if ((Date.now() - this._startedAt) / 1000 >= this.opts.max_seconds) break;
      try {
        const r = await this.session.send("screenshot", { max_dim: this.opts.max_dim }, 15000);
        this.frames.push({ png: Buffer.from(r.png_base64, "base64"), t: Date.now() - this._startedAt });
      } catch {
        // Bridge busy or game gone; count it and keep trying briefly.
        this._captureErrors++;
        if (!this.session.running || !this.session.bridge?.connected) break;
      }
      const spent = Date.now() - tick;
      if (this.active && spent < interval) await new Promise((res) => setTimeout(res, interval - spent));
    }
    // If we broke out of the loop because a cap was hit, stop cleanly.
    this.active = false;
  }

  /** Stop capturing. Does not encode — call encode() next. */
  stopCapture() {
    this.active = false;
  }

  _defaultPath(ext) {
    const dir = path.join(os.tmpdir(), "godot-ai-tester");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    return path.join(dir, `recording-${stamp}.${ext}`);
  }

  _decodeFrames() {
    const decoded = [];
    let W = 0, H = 0;
    for (const f of this.frames) {
      try {
        const png = PNG.sync.read(f.png);
        if (!W) { W = png.width; H = png.height; }
        // Normalize odd-sized frames to the first frame's dimensions.
        decoded.push({ data: png.width === W && png.height === H ? png.data : resizeRGBA(png.data, png.width, png.height, W, H), t: f.t });
      } catch {
        /* skip unreadable frame */
      }
    }
    return { decoded, W, H };
  }

  /**
   * Encode captured frames into an animated GIF on disk.
   * @returns {{path, frames, width, height, duration_seconds, bytes}}
   */
  async encodeGif(savePath, { fps } = {}) {
    if (!this.frames.length) throw new Error("No frames were captured.");
    const { decoded, W, H } = this._decodeFrames();
    if (!decoded.length) throw new Error("All captured frames failed to decode.");
    const outPath = savePath ? path.resolve(savePath) : this._defaultPath("gif");
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const gif = GIFEncoder();
    const playFps = Math.max(1, Math.min(50, fps ?? this.opts?.fps ?? 10));
    // Prefer real inter-frame timing when available; fall back to fps.
    for (let i = 0; i < decoded.length; i++) {
      const rgba = decoded[i].data;
      const palette = quantize(rgba, 256, { format: "rgb565" });
      const index = applyPalette(rgba, palette, "rgb565");
      let delay = Math.round(1000 / playFps);
      if (i + 1 < decoded.length) {
        const dt = decoded[i + 1].t - decoded[i].t;
        if (dt > 5 && dt < 2000) delay = dt;
      }
      gif.writeFrame(index, W, H, { palette, delay });
    }
    gif.finish();
    const bytes = Buffer.from(gif.bytes());
    fs.writeFileSync(outPath, bytes);
    const duration = (decoded[decoded.length - 1].t - decoded[0].t) / 1000 || decoded.length / playFps;
    return {
      path: outPath,
      frames: decoded.length,
      width: W,
      height: H,
      duration_seconds: +duration.toFixed(1),
      bytes: bytes.length,
    };
  }

  /**
   * Build a contact sheet: up to `count` evenly-sampled frames laid out in a
   * grid, as a single PNG. Returns the PNG buffer (base64-able) so an AI can
   * review the motion across time in one image.
   */
  buildContactSheet({ count = 9, cols = 3 } = {}) {
    if (!this.frames.length) throw new Error("No frames captured.");
    const { decoded, W, H } = this._decodeFrames();
    if (!decoded.length) throw new Error("All captured frames failed to decode.");
    const n = Math.min(count, decoded.length);
    const pick = [];
    for (let i = 0; i < n; i++) {
      pick.push(decoded[Math.round((i * (decoded.length - 1)) / Math.max(1, n - 1))]);
    }
    const rows = Math.ceil(n / cols);
    const pad = 4;
    // Scale each cell down so the sheet isn't enormous.
    const cellW = Math.min(W, 320);
    const scale = cellW / W;
    const cellH = Math.round(H * scale);
    const sheetW = cols * cellW + (cols + 1) * pad;
    const sheetH = rows * cellH + (rows + 1) * pad;
    const sheet = new PNG({ width: sheetW, height: sheetH });
    sheet.data.fill(0x1a); // dark background

    pick.forEach((frame, idx) => {
      const cx = idx % cols, cy = Math.floor(idx / cols);
      const ox = pad + cx * (cellW + pad);
      const oy = pad + cy * (cellH + pad);
      for (let y = 0; y < cellH; y++) {
        const sy = Math.min(H - 1, Math.floor(y / scale));
        for (let x = 0; x < cellW; x++) {
          const sx = Math.min(W - 1, Math.floor(x / scale));
          const si = (sy * W + sx) * 4;
          const di = ((oy + y) * sheetW + (ox + x)) * 4;
          sheet.data[di] = frame.data[si];
          sheet.data[di + 1] = frame.data[si + 1];
          sheet.data[di + 2] = frame.data[si + 2];
          sheet.data[di + 3] = 255;
        }
      }
    });
    return { png: PNG.sync.write(sheet), width: sheetW, height: sheetH, tiles: n };
  }
}

/** Nearest-neighbor resize of an RGBA buffer (only used for mismatched frames). */
function resizeRGBA(data, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}
