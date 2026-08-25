# flowplus-flow-mcp

An MCP server that lets an AI assistant build FlowPlus automation flows from a
natural-language description.

> "When an expense form is submitted, if the amount is over 5000 send it to the
> finance manager for approval, otherwise auto-approve and write it to the
> Expenses module."

…becomes a validated draft automation you review and publish in Workflow Studio.

Works with any MCP client — Claude Code, Codex, Cursor. Nothing is added to the
FlowPlus backend; this is purely a client of its existing design API.

## How it works

The FlowPlus automation engine is already self-describing. `builder/catalog`
returns the whole vocabulary — trigger types, ~52 node types each with a JSON
Schema for its config, route types — and `automations/import` accepts a complete
flow as one document and answers with a structured validation report.

So this server contains no flow logic. It exchanges tokens, keeps the catalog
from flooding the model's context, checks a few things locally that are cheaper
to catch here than after a round trip, and refuses to publish anything.

The loop it enables: describe → ground every reference (modules, forms,
assignees) → fetch schemas for only the node types needed → compose the
definition → `flow_create_draft` → repair against the validation report with
`flow_update_draft` → hand the user a Studio link to review and publish.

## Requirements

- **Node.js 20+** (developed on 22).
- A reachable **FlowPlus backend** (local or remote) with the automation engine
  feature enabled — the design endpoints return 503 when it is off.
- A FlowPlus **user account** for the server to authenticate with. Prefer a
  dedicated service account: the drafts it creates are attributed to this user,
  and its permissions bound what the AI can see.

## Installation

### From npm (recommended)

Nothing to install up front — reference the package with `npx` in your client
config (below) and it is fetched and run automatically:

```bash
npx -y flowplus-flow-mcp
```

### From source

```bash
git clone https://github.com/MasterteamSA/flowplus-flow-mcp.git
cd flowplus-flow-mcp
npm install
npm run build
```

The server is the compiled `dist/index.js`. Either way it speaks MCP over
stdio — your AI client launches it; you never run it by hand (except to test).

## Configuration

Everything is environment variables, passed by the MCP client at launch:

| Variable | Required | Default | Notes |
|---|---|---|---|
| `FLOWPLUS_BASE_URL` | yes | | API origin, e.g. `http://localhost:5012` or your gateway URL |
| `FLOWPLUS_USERNAME` | yes | | account the server logs in as |
| `FLOWPLUS_PASSWORD` | yes | | |
| `FLOWPLUS_APP_CODE` | | `flowplus2` | application code for the two-step token exchange (`/api/auth/login` → `/api/applications/{code}/launch`) |
| `FLOWPLUS_STUDIO_URL` | | `http://localhost:4400` | origin used to build the `reviewUrl` links |
| `FLOWPLUS_TENANT_ID` | | | sent as `X-Tenant-Id` when set; omit for single-tenant |
| `FLOWPLUS_WRITE_ENABLED` | | `false` | **must be `true` to create or update drafts.** Leave unset for a read-only explorer |
| `FLOWPLUS_TIMEOUT_MS` | | `60000` | per-request timeout |

Two rules of thumb:

- **Register at user level**, not with a `.mcp.json` inside the FlowPlus
  repos — a flow-builder should not have the backend source in reach, and the
  skill deliberately abstracts the system away from the coding agent.
- **When running from source, use an absolute path to `node`** in the config.
  MCP clients launch servers with a minimal `PATH`; if Node came from
  nvm/mise/homebrew, plain `"node"` often fails to resolve. `which node` tells
  you the path to use. (The `npx` form avoids the whole issue.)

### Claude Code

Either register from the terminal:

```bash
claude mcp add flowplus --scope user \
  --env FLOWPLUS_BASE_URL=http://localhost:5012 \
  --env FLOWPLUS_USERNAME=your-service-account \
  --env FLOWPLUS_PASSWORD=your-password \
  --env FLOWPLUS_WRITE_ENABLED=true \
  -- npx -y flowplus-flow-mcp
```

…or add it to `~/.claude.json` yourself:

```json
{
  "mcpServers": {
    "flowplus": {
      "command": "npx",
      "args": ["-y", "flowplus-flow-mcp"],
      "env": {
        "FLOWPLUS_BASE_URL": "http://localhost:5012",
        "FLOWPLUS_USERNAME": "your-service-account",
        "FLOWPLUS_PASSWORD": "your-password",
        "FLOWPLUS_STUDIO_URL": "http://localhost:4400",
        "FLOWPLUS_WRITE_ENABLED": "true"
      }
    }
  }
}
```

Running from a source checkout instead, swap the command for
`"/absolute/path/to/node"` with args
`["/absolute/path/to/flowplus-flow-mcp/dist/index.js"]`.

Then install the skill. **Easiest for teams**: add the Masterteam plugin
marketplace, which installs the server registration and the skill together —

```
/plugin marketplace add MasterteamSA/claude-plugins
/plugin install flowplus@masterteam
```

— or, from a source checkout, copy the skill to user level yourself:

```bash
cp -r skills/build-a-flow ~/.claude/skills/
```

The skill teaches the build loop (ground first, compose, repair on the same
draft) and the sharp edges (output keys, rework loops must be unrolled, inline
forms). Without it the model still works but rediscovers those the hard way.

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.flowplus]
command = "npx"
args = ["-y", "flowplus-flow-mcp"]
startup_timeout_sec = 60

[mcp_servers.flowplus.env]
FLOWPLUS_BASE_URL = "http://localhost:5012"
FLOWPLUS_USERNAME = "your-service-account"
FLOWPLUS_PASSWORD = "your-password"
FLOWPLUS_STUDIO_URL = "http://localhost:4400"
FLOWPLUS_WRITE_ENABLED = "true"
```

Codex has no skills directory; it gets the same build-loop guidance through the
`build_a_flow` prompt the server registers.

### Other MCP clients

Any client that can launch a stdio server works: command = `npx`, args =
`["-y", "flowplus-flow-mcp"]`, env as above. The `build_a_flow` prompt carries
the guidance.

## Verify the setup

1. Restart your AI client (a running session keeps the old server process).
2. Ask it to list its flow tools — you should see **18 tools**, `flow_catalog`
   through `flow_update_draft`. In Claude Code, `/mcp` shows the server status
   directly.
3. Ask something read-only first: *"list the automations in FlowPlus"* →
   `flow_list` should return real data.
4. Then the real thing: *"build a flow that runs every Monday at 9am and emails
   a summary to the finance group"*. Expect grounding calls, a draft, and a
   Studio `reviewUrl` — and the words "draft, not running", because nothing
   this server does can publish.

On startup the server logs one line to stderr
(`flowplus-flow-mcp ready against … writes=enabled`), which MCP clients surface
in their server logs.

## Tools

**Discover** — `flow_catalog` (summary only, no schemas), `flow_node_schema`
(full schemas for named types), `flow_trigger_schema`.

**Ground** — `flow_modules`, `flow_module_schema`, `flow_forms`,
`flow_form_schema`, `flow_assignees`, `flow_connectors`,
`flow_schedule_preview`. These stop the model inventing things.

**Inspect** — `flow_list`, `flow_get`, `flow_export`, `flow_validate`.

**Write** — `flow_create_draft` and `flow_update_draft` (revises an existing
draft in place, keeping its id — use it for the repair loop instead of minting
a new draft per attempt), plus `flow_create_inline_form` /
`flow_validate_inline_form` for HumanTask forms. All gated behind
`FLOWPLUS_WRITE_ENABLED`.

There is no publish, activate, or delete tool, by design. An AI-authored graph
should not reach production unreviewed; the engine classes some node types
`FinancialOrDestructive`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Server never appears in the client | `command` is `"node"` but Node is not on the client's minimal PATH — use the absolute path from `which node`. Check the client's MCP logs for the stderr line. |
| `FLOWPLUS_BASE_URL is not set` on startup | The env block is missing or in the wrong scope/file for your client. |
| Every design call returns 503 | The automation engine feature gate is off for the tenant — enable it in Control Panel. |
| `AUTH_002` / login failures | Wrong credentials, or `FLOWPLUS_APP_CODE` doesn't match an application the account can launch. The server does the session→application token exchange itself; you only supply username/password. |
| "Draft creation is disabled" | Working as intended: set `FLOWPLUS_WRITE_ENABLED=true` and restart the client. |
| Tools respond but writes 404 on a specific automation | Wrong tenant — set `FLOWPLUS_TENANT_ID` to the tenant that owns the automation. |
| Client still shows 17 tools after an update | It's running the old process. Rebuild (`npm run build`), then restart the session or reconnect via `/mcp`. |

## Implementation notes

Server quirks, workarounds and design rationale live in
[docs/MAINTAINING.md](docs/MAINTAINING.md). That is maintainer material —
people *building flows* need none of it, and should not need the FlowPlus
source either.

## Development

```bash
npm run typecheck
npm run inspect                                  # MCP Inspector UI
node scripts/smoke.mjs                           # scripted end-to-end run
```

`scripts/smoke.mjs` exercises the tool list, the safety gates, draft creation,
and the update-in-place regression (create → grow → shrink → export) against a
running FlowPlus instance. It expects the env vars above. Note it leaves its
clearly-named scratch drafts behind — there is deliberately no delete API.
