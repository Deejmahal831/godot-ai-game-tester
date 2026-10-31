// Verifies the MCP server speaks the protocol: initialize handshake + tools/list.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, "..", "mcp-server", "src", "index.js");

const proc = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const responses = [];
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) responses.push(JSON.parse(line));
  }
});

const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
await new Promise((r) => setTimeout(r, 800));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
await new Promise((r) => setTimeout(r, 800));

const init = responses.find((r) => r.id === 1);
const tools = responses.find((r) => r.id === 2);
console.log("initialize ok:", init?.result?.serverInfo?.name === "godot-ai-game-tester");
console.log("tool count:", tools?.result?.tools?.length);
console.log("tools:", tools?.result?.tools?.map((t) => t.name).join(", "));
proc.kill();
process.exit(init && tools?.result?.tools?.length >= 20 ? 0 : 1);
