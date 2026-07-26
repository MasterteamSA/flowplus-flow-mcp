/**
 * Minimal stdio JSON-RPC harness. Spawns the server, runs a scripted set of
 * calls, prints a compact result per step. Not a substitute for the Inspector —
 * just something that can run unattended in a terminal.
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("node", ["dist/index.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

const pending = new Map();
let nextId = 1;

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => reject(new Error(`${method} timed out`)), 90_000);
  });
}

const text = (r) => r?.result?.content?.[0]?.text ?? JSON.stringify(r?.error ?? r);
const isErr = (r) => r?.result?.isError === true;

function report(label, response, preview = 220) {
  const body = text(response);
  console.log(`\n${isErr(response) ? "✗" : "✓"} ${label}`);
  console.log("  " + body.replace(/\s+/g, " ").slice(0, preview));
  return body;
}

try {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await send("tools/list", {});
  const names = tools.result.tools.map((t) => t.name).sort();
  console.log(`\n✓ tools/list — ${names.length} tools`);
  console.log("  " + names.join(", "));

  for (const forbidden of ["flow_publish", "flow_activate", "flow_delete"]) {
    console.log(names.includes(forbidden) ? `✗ ${forbidden} EXPOSED` : `✓ ${forbidden} absent`);
  }

  report("flow_catalog (summary)", await send("tools/call", {
    name: "flow_catalog", arguments: { category: "logic" },
  }), 400);

  report("flow_node_schema(['if'])", await send("tools/call", {
    name: "flow_node_schema", arguments: { keys: ["if"] },
  }), 260);

  report("flow_node_schema(bogus)", await send("tools/call", {
    name: "flow_node_schema", arguments: { keys: ["does-not-exist"] },
  }), 200);

  report("flow_list", await send("tools/call", {
    name: "flow_list", arguments: { limit: 5 },
  }), 240);

  report("flow_export(2)", await send("tools/call", {
    name: "flow_export", arguments: { automationId: 2 },
  }), 240);

  report("flow_validate(2)", await send("tools/call", {
    name: "flow_validate", arguments: { automationId: 2 },
  }), 240);

  // Structural guard: route pointing at a node that does not exist.
  report("flow_create_draft (dangling route — must refuse)", await send("tools/call", {
    name: "flow_create_draft",
    arguments: {
      definition: {
        name: "smoke bad",
        triggers: [{ key: "t", type: "ManualTrigger", name: "T", config: { startNodeKey: "a" } }],
        nodes: [{ key: "a", type: "SetFields", name: "A", config: { fields: { x: "1" } } }],
        routes: [{ sourceNodeKey: "a", targetNodeKey: "ghost" }],
      },
    },
  }), 300);

  // Invented node type.
  report("flow_create_draft (unknown node type — must refuse)", await send("tools/call", {
    name: "flow_create_draft",
    arguments: {
      definition: {
        name: "smoke bad type",
        triggers: [{ key: "t", type: "ManualTrigger", name: "T", config: { startNodeKey: "a" } }],
        nodes: [{ key: "a", type: "SendCarrierPigeon", name: "A" }],
        routes: [],
      },
    },
  }), 300);

  // The real thing: note every JsonElement field is omitted on purpose, to prove
  // the schema defaults prevent the server-side sanitizer 500.
  report("flow_create_draft (valid, minimal fields)", await send("tools/call", {
    name: "flow_create_draft",
    arguments: {
      definition: {
        name: "MCP smoke — two step",
        description: "created by scripts/smoke.mjs",
        triggers: [
          { key: "manual", type: "ManualTrigger", name: "Manual start", config: { startNodeKey: "greet" } },
        ],
        nodes: [
          { key: "greet", type: "SetFields", name: "Set greeting", config: { fields: { greeting: "hi" } }, position: { x: 320, y: 200 } },
          { key: "finish", type: "SetFields", name: "Set done", config: { fields: { done: "true" } }, position: { x: 320, y: 360 } },
        ],
        routes: [{ sourceNodeKey: "greet", targetNodeKey: "finish", routeType: "Default" }],
      },
    },
  }), 700);
} catch (error) {
  console.error("\nSMOKE FAILED:", error.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
