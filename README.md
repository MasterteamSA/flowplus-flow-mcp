# flowplus-flow-mcp

An MCP server that lets an AI assistant build FlowPlus automation flows from a
natural-language description.

> "When an expense form is submitted, if the amount is over 5000 send it to the
> finance manager for approval, otherwise auto-approve and write it to the
> Expenses module."

…becomes a validated draft automation you review and publish in Workflow Studio.

Works with any MCP client — Claude Code, Codex, Cursor. Nothing is added to the
FlowPlus backend; this is purely a client of its existing design API.

## Why this is thin

The FlowPlus automation engine is already self-describing. `builder/catalog`
returns the whole vocabulary — trigger types, ~52 node types each with a JSON
Schema for its config, route types — and `automations/import` accepts a complete
flow as one document and answers with a structured validation report.

So this server contains no flow logic. It exchanges tokens, keeps the catalog
from flooding the model's context, checks a few things locally that are cheaper
to catch here than after a round trip, and refuses to publish anything.

## Setup

```bash
npm install && npm run build
```

Configure via environment:

| Variable | Required | Default | |
|---|---|---|---|
| `FLOWPLUS_BASE_URL` | yes | | e.g. `http://localhost:5012` |
| `FLOWPLUS_USERNAME` | yes | | |
| `FLOWPLUS_PASSWORD` | yes | | |
| `FLOWPLUS_APP_CODE` | | `flowplus2` | application code for the token exchange |
| `FLOWPLUS_STUDIO_URL` | | `http://localhost:4400` | used to build review links |
| `FLOWPLUS_TENANT_ID` | | | sent as `X-Tenant-Id` when set |
| `FLOWPLUS_WRITE_ENABLED` | | `false` | **must be `true` to create drafts** |
| `FLOWPLUS_TIMEOUT_MS` | | `60000` | |

Register it. Prefer **user level** (`~/.claude.json`, or your client's equivalent) over a
`.mcp.json` inside the FlowPlus repos — a flow-builder should not have the backend source in
reach. Give it its own empty working directory:

```json
{
  "mcpServers": {
    "flowplus": {
      "command": "node",
      "args": ["/absolute/path/to/flowplus-flow-mcp/dist/index.js"],
      "env": {
        "FLOWPLUS_BASE_URL": "http://localhost:5012",
        "FLOWPLUS_USERNAME": "admin",
        "FLOWPLUS_PASSWORD": "…",
        "FLOWPLUS_WRITE_ENABLED": "true"
      }
    }
  }
}
```

Install the skill at user level too, so it travels with you rather than with a checkout:

```bash
cp -r skills/build-a-flow ~/.claude/skills/
```

Other clients get the same guidance from the `build_a_flow` prompt the server registers.

## Tools

**Discover** — `flow_catalog` (summary only, no schemas), `flow_node_schema`
(full schemas for named types), `flow_trigger_schema`.

**Ground** — `flow_modules`, `flow_module_schema`, `flow_forms`,
`flow_form_schema`, `flow_assignees`, `flow_connectors`,
`flow_schedule_preview`. These stop the model inventing things.

**Inspect** — `flow_list`, `flow_get`, `flow_export`, `flow_validate`.

**Write** — `flow_create_draft` and `flow_update_draft` (revises an existing
draft in place, keeping its id — use it for the repair loop instead of minting
a new draft per attempt), both gated behind `FLOWPLUS_WRITE_ENABLED`.

There is no publish, activate, or delete tool, by design. An AI-authored graph
should not reach production unreviewed; the engine classes some node types
`FinancialOrDestructive`.

## Implementation notes

Server quirks, workarounds and design rationale live in [docs/MAINTAINING.md](docs/MAINTAINING.md). That is maintainer material — people *building flows* need none of it, and should not need the FlowPlus source either.

## Development

```bash
npm run typecheck
npm run inspect                                  # MCP Inspector UI
node scripts/smoke.mjs                           # scripted end-to-end run
```

`scripts/smoke.mjs` exercises the tool list, the safety gates, and a real draft
creation against a running FlowPlus instance. It expects the env vars above.
