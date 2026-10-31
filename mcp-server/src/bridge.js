import net from "node:net";

/**
 * TCP client for the AiGameTester autoload running inside the game.
 * Protocol: newline-delimited JSON with request ids.
 */
export class Bridge {
  constructor(port, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.connected = false;
  }

  connect(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tryConnect = () => {
        const socket = net.createConnection({ port: this.port, host: this.host });
        socket.setNoDelay(true);
        socket.once("connect", () => {
          this.socket = socket;
          this.connected = true;
          socket.on("data", (chunk) => this._onData(chunk));
          socket.on("close", () => this._onClose());
          socket.on("error", () => {});
          resolve();
        });
        socket.once("error", () => {
          socket.destroy();
          if (Date.now() > deadline) {
            reject(new Error(`Could not connect to game bridge on port ${this.port} within ${timeoutMs}ms`));
          } else {
            setTimeout(tryConnect, 250);
          }
        });
      };
      tryConnect();
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  }

  _onClose() {
    this.connected = false;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Game connection closed"));
    }
    this.pending.clear();
  }

  /** Send a command; resolves with the `result` payload or throws on error. */
  async send(cmd, args = {}, timeoutMs = 15000) {
    if (!this.connected || !this.socket) {
      throw new Error("Not connected to a running game. Use launch_game first.");
    }
    const id = this.nextId++;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Command '${cmd}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ id, cmd, args }) + "\n");
    });
    if (!response.ok) {
      throw new Error(response.error || `Command '${cmd}' failed`);
    }
    return response.result;
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }
}
