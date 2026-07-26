---
name: build-a-flow
description: Build a FlowPlus automation flow from a natural-language description. Use when the user asks to create, design, draft, or scaffold a workflow, automation, process, or flow in FlowPlus — e.g. "make a flow that routes expenses over 5000 to finance for approval". Requires the flowplus-flow-mcp server.
---

# Build a FlowPlus flow

Turn a description into a validated **draft** automation. You cannot publish or
activate — a human does that in Workflow Studio. Never tell the user their flow
is live.

## Order of work

### 1. Understand before building

Restate the request as a trigger plus ordered steps. If the trigger is ambiguous,
ask — the four options are manual, webhook, form submission, and schedule, and
guessing wrong means rebuilding.

Worth one question up front; not worth five.

### 2. Ground every reference

**Do this before choosing node types.** A flow that references a module, field,
form, or person that does not exist is worse than no flow, because it looks
right.

| Need | Call |
|---|---|
| Write to a data module | `flow_modules`, then `flow_module_schema` |
| Trigger on / bind a form | `flow_forms`, then `flow_form_schema` |
| Route work to a person or group | `flow_assignees` |
| Use Slack, Gmail, Teams, … | `flow_connectors` |
| Run on a schedule | `flow_schedule_preview` to confirm the cron |

Never invent a module key, field name, or assignee.

### 3. Pick blocks narrowly

`flow_catalog` for the shortlist — it returns one line per node type, no schemas.
Then `flow_node_schema` for **only** the handful you chose.

Do not ask for every node type. There are 52, each with a full JSON Schema; you
will exhaust your context before writing anything.

### 4. Compose the definition

```jsonc
{
  "name": "Expense approval",
  "triggers": [{
    "key": "on_submit",
    "type": "FormSubmitTrigger",       // PascalCase nodeType/triggerType, not the catalog key
    "name": "Expense submitted",
    "config": { "startNodeKey": "check_amount" }   // must name a real node
  }],
  "nodes": [
    { "key": "check_amount", "type": "If", "name": "Over 5000?",
      "config": { "condition": "..." }, "position": { "x": 320, "y": 200 } },
    { "key": "approve", "type": "HumanApproval", "name": "Finance approval",
      "config": { }, "position": { "x": 160, "y": 380 } }
  ],
  "routes": [
    { "sourceNodeKey": "check_amount", "sourceOutputKey": "true",
      "targetNodeKey": "approve", "routeType": "Condition" }
  ]
}
```

Rules that actually bite:

- **`type` is the PascalCase `nodeType`**, not the lowercase catalog `key`.
  `SetFields`, not `set-fields`.
- **`sourceOutputKey` must be an output the source node declares.** This is the
  most common mistake. Most nodes have `success`/`failure`; `if` has
  `true`/`false`; `switch` has `case_primary`/`default`; `human-approval` has
  `Approved`/`Rejected`/`Returned`/`Cancelled`/`Delegated`/`TimedOut`;
  `loop-over-items` has `loop`/`done`/`failure`. `"default"` is **not** a
  general-purpose value — only `switch` declares it. Read `routeOutputKeys` in
  the `flow_node_schema` response.
- **Set `position`** so the graph is readable: x around 320, y increasing ~160
  per step, branches offset left and right.
- Omitted JSON fields are filled in for you. You do not need to write empty
  `schema`, `authenticationPolicy`, `retryPolicy` and friends.

Unsure of the shape? `flow_export` an existing automation and copy its structure.

### 5. Create and repair

`flow_create_draft` returns the server's validation report. Each issue names the
node (`targetKey`), the field (`fieldPath` / `configPath`) and often a
`suggestedFix`. Fix precisely what it names.

Each call creates a **new** draft, so correct the definition properly rather than
resubmitting hopefully. After about three attempts, stop and report what remains
— tell the user which node and field are unresolved instead of thrashing.

### 6. Report honestly

Give the user the `reviewUrl` and state that the flow is a draft awaiting their
review. If anything was assumed — an assignee, a threshold, a field mapping —
say so plainly. If part of the request could not be built, name that part rather
than quietly dropping it.
