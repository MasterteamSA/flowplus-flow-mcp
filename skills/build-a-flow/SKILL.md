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

**If the tenant is empty** — no modules, no forms, no roles beyond a default admin
group — say so before building, because it changes what the flow can be. You can
still produce a structurally complete graph with stubbed integrations and every
human step on the one group that exists, and that is genuinely useful for review.
What you must not do is present it as wired. Name the gap in your report and in
the automation's `description`, and let the user decide whether to configure the
tenant first.

### 3. Pick blocks narrowly

`flow_catalog` for the shortlist — it returns one line per node type, no schemas.
Then `flow_node_schema` for **only** the handful you chose.

Do not ask for every node type. There are 52, each with a full JSON Schema; you
will exhaust your context before writing anything.

**Check `unavailableNodeTypes` in the response.** A node type the tenant has
switched off still appears in the catalog with a full schema — the AI nodes are
the usual case, disabled in Control Panel. It reads as usable until import
rejects the finished graph. If something you need is off, say so *before* you
build around it, and tell the user what has to be enabled.

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
- **`sourceOutputKey` must be an output the source node has.** This is the most
  common mistake. Most nodes have `success`/`failure`; `if` has `true`/`false`;
  `switch` has `case_primary`/`default`; `human-approval` has
  `Approved`/`Rejected`/`Returned`/`Cancelled`/`Delegated`/`TimedOut`;
  `loop-over-items` has `loop`/`done`/`failure`. `"default"` is **not** a
  general-purpose value — only `switch` declares it.
- **`routeOutputKeys` is a default, not a closed set — config moves it both ways.**
  `config.branches[]` on `ParallelStart` **adds** outputs: configure four branches,
  route on those four keys, it validates. You are not limited to two lanes.
  `config.allowedDecisions` on the human nodes **removes** them: an approval
  listing `["Approved","Rejected"]` has exactly those plus `TimedOut`, and a route
  from `Cancelled` fails even though the catalog lists it. Read the configSchema,
  not just `routeOutputKeys`.
- **One route per output.** Two routes leaving the same node's same output are
  rejected as `duplicate Success priority 0`. That message does not sound like
  what it means: you forked where you should have sequenced. Chain the steps, or
  fan out properly with `ParallelStart`.
- **`actionKey` is not the catalog key.** `ConvertToFile` is looked up as
  `convert-to-file-xlsx` but configured with `"actionKey": "xlsx"`. Same trap as
  `type`, different field — the schema pins it as a `const`, so read it.
- **AI node `inputs` are typed declarations, not expressions.** This is the single
  biggest source of wasted drafts. Not `{ "customer": "={{ ... }}" }` but:
  ```jsonc
  "inputs": {
    "customer": { "type": "object", "source": "={{ $nodes.fetch.output }}",
                  "required": true, "description": "…" }
  }
  ```
  `type` is one of string, number, boolean, date, object, array, enum, file. The
  server's error — *"input 'customer' must be a JSON object"* — describes the
  value it wanted, not the shape.
- **Expressions: `$nodes.<key>.output` is the reliable root.** `$now` and
  `$trigger` both look obvious and are both refused as an "unsupported expression
  namespace". Let nodes stamp their own values rather than reaching for ambient
  ones.
- **Do not lay the graph out yourself.** Studio has a dagre auto-layout that
  knows the real node sizes and ranks the graph left-to-right; you do not, and
  the coordinates you write override it. Assign a plain ladder — x increasing
  ~320 along the chain, y offset ~160 for parallel branches — purely so nothing
  sits at 0,0, then stop.

  Past roughly ten nodes, **tell the user to run Auto-layout** (canvas controls,
  or `autoLayout` in the command palette) when you hand over the link — it ranks
  the graph properly instead of honouring whatever you guessed.

  Be honest about its limits, though: auto-layout currently lays out
  left-to-right, so a *deep* flow still comes out very wide. A 46-node payroll
  process, 33 ranks deep but only 8 wide, renders about 10,500px across. That is
  a known Studio limitation, not something your coordinates caused and not
  something you can fix from here. Say so rather than letting the user think the
  flow itself is malformed.
- **Do not add catch-all terminal nodes unless the user asks for them.** It is
  tempting to give every failure and rejection branch somewhere to land — a
  shared `halt_inputs`, `halt_payment` or `rework` `Stop` node. Do not. A branch
  that simply ends is a valid, complete flow; the run stops on its own.

  These sinks are the single biggest cause of unreadable graphs. In one 46-node
  flow three of them absorbed 16, 15 and 14 incoming edges, which put nearly
  half the edges (48%) across more than one rank and made the canvas unreadable
  at any layout direction. They add no behaviour and cost a great deal of
  legibility.

  Add a `Stop` node only when the user explicitly wants an explicit end state —
  for example a distinct "cancelled" outcome they need to see or report on.
- Omitted JSON fields are filled in for you. You do not need to write empty
  `schema`, `authenticationPolicy`, `retryPolicy` and friends.

Unsure of the shape? `flow_export` an existing automation and copy its structure.

### 4b. Rework loops — unroll them forward

The graph may not contain cycles. A process chart that loops ("rejected goes back
to recalculation") cannot be built as a back-edge; the engine refuses it outright.

Approvals have a `Returned` output that exists precisely for send-back. Unroll the
loop into a forward chain:

```
calc → approve1 ─Approved──→ commit
          ├─Returned→ fix → approve2 ─Approved→ commit
          └─Rejected→ stop
```

Forward edges may converge on a shared node; they just may not loop back. So
rework depth is fixed when you design it — two passes means two approval nodes.

If the process needs unbounded rework, end the run on `Returned` and let a
corrected re-run start a fresh execution. **Tell the user you did that**, because
it changes the audit shape: each attempt becomes its own execution record.

Do **not** reach for `LoopOverItems`. It is named "loop" and is the obvious wrong
answer: it snapshots a collection once, runs its body once per item, and its body
must return to the loop node itself. It iterates known collections; it cannot
express conditional retry.

### 4c. Human steps that collect data need a form

A `HumanTask` without one will not validate. `config.formSource` takes:

| Value | When |
|---|---|
| `ReuseTriggerForm` | flow is form-triggered and you want the same fields |
| `InlineDraft` | build one with `flow_create_inline_form` |
| `ExistingPublished` | bind a published form from `flow_forms` |

For `InlineDraft` the order is: create the automation, then attach the form to the
named node, then set `formDefinitionId` + `inlineDraftRevisionId` in the node
config and resubmit. Field `defaultValue` can reference earlier steps, so a
correction form arrives pre-filled with the values under dispute.

Never silently downgrade a data-collecting step to a decide-only `HumanApproval`.
That drops a requirement without saying so. If you genuinely cannot build the
form, say which step is affected and why.

### 5. Create and repair

`flow_create_draft` returns the server's validation report. Each issue names the
node (`targetKey`), the field (`fieldPath` / `configPath`) and often a
`suggestedFix`. Fix precisely what it names.

Repair on the **same** draft: `flow_update_draft(automationId, definition)`
applies the corrected document in place, keeping the id and the review link
stable. Do not call `flow_create_draft` again for a repair — that mints a
second draft and abandons the first. The document you pass to update is
authoritative for the whole graph: anything not in it is **deleted** from the
draft, so always send the complete definition, not just the changed part
(start from `flow_export` of the same automation if unsure of its current
state).

After about three attempts, stop and report what remains — tell the user which
node and field are unresolved instead of thrashing.

### 6. Report honestly

Give the user the `reviewUrl` and state that the flow is a draft awaiting their
review. If anything was assumed — an assignee, a threshold, a field mapping —
say so plainly. If part of the request could not be built, name that part rather
than quietly dropping it.
