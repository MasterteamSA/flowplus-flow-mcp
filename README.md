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

Register it (`.mcp.json`, or your client's equivalent):

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

Copy `skills/build-a-flow/` into `.claude/skills/` for Claude Code. Other clients
get the same guidance from the `build_a_flow` prompt the server registers.

## Tools

**Discover** — `flow_catalog` (summary only, no schemas), `flow_node_schema`
(full schemas for named types), `flow_trigger_schema`.

**Ground** — `flow_modules`, `flow_module_schema`, `flow_forms`,
`flow_form_schema`, `flow_assignees`, `flow_connectors`,
`flow_schedule_preview`. These stop the model inventing things.

**Inspect** — `flow_list`, `flow_get`, `flow_export`, `flow_validate`.

**Write** — `flow_create_draft`, gated behind `FLOWPLUS_WRITE_ENABLED`.

There is no publish, activate, or delete tool, by design. An AI-authored graph
should not reach production unreviewed; the engine classes some node types
`FinancialOrDestructive`.

## Notes from building this

**Context budget drives the design.** The full catalog is far too large to hand
to a model. `flow_catalog` returns one line per node type; the model picks a few
and calls `flow_node_schema` for those. Without this split a session runs out of
context before writing a flow.

**`sourceOutputKey` is the trap.** Routes leave from a named output, and the
names vary by node type: mostly `success`/`failure`, but `if` uses `true`/`false`,
`switch` uses `case_primary`/`default`, approvals use `Approved`/`Rejected`/… .
`"default"` looks like a safe default and is valid on exactly one node type. The
server checks this, so we check it locally first and list the valid options in
the error.

**Omitted JSON fields used to cause an HTTP 500.** On the server, several
trigger and node properties are non-nullable `JsonElement`s. Omit one and it
deserialises to `ValueKind.Undefined`; the input sanitizer then calls
`GetRawText()` on it, which throws, and the request dies as an unhandled 500
naming no field. `src/schema.ts` defaults every one of them to `{}`, so callers
can write the minimal document. This is worth fixing upstream in
`ReflectionCommandSanitizer.SanitizeJsonElement` — it should skip `Undefined`.

**Iteration creates new drafts.** `automations/import` only ever creates; there
is no update-by-document endpoint, and the per-node endpoints delete one key at
a time. Rather than a fragile delete-and-recreate dance, each repair produces a
fresh draft — so the server checks structure locally first to keep pointless
attempts down. Superseded drafts are deleted by a human in Studio.

## Development

```bash
npm run typecheck
npm run inspect                                  # MCP Inspector UI
node scripts/smoke.mjs                           # scripted end-to-end run
```

`scripts/smoke.mjs` exercises the tool list, the safety gates, and a real draft
creation against a running FlowPlus instance. It expects the env vars above.
