# Maintaining flowplus-flow-mcp

Notes for whoever changes this server. **Nothing here is needed to build a flow** — that is the
point. A flow-builder should never have to read FlowPlus source or know what a `JsonElement` is;
if they do, this server has failed to abstract something and that is the bug to fix.

## Notes from building this


**Context budget drives the design.** The full catalog is far too large to hand
to a model. `flow_catalog` returns one line per node type; the model picks a few
and calls `flow_node_schema` for those. Without this split a session runs out of
context before writing a flow.

**`sourceOutputKey` is the trap.** Routes leave from a named output, and the
names vary by node type: mostly `success`/`failure`, but `if` uses `true`/`false`,
`switch` uses `case_primary`/`default`, approvals use `Approved`/`Rejected`/… .
`"default"` looks like a safe default and is valid on exactly one node type.

The subtlety is that `routeOutputKeys` is a *default declaration*, and config
moves it in both directions: `ParallelStart.branches[].key` adds outputs,
`allowedDecisions` on the human nodes removes them. An early version treated the
declaration as closed and refused valid four-branch fan-outs; the check is now
advisory only and says so in the warning. The server is the authority.

**The other config-shape traps, each of which cost a dead draft to learn.** AI
node `inputs` are typed declarations (`{type, source}`), not bare expressions —
the server says "must be a JSON object" without saying which object.
`ConvertToFile.actionKey` is `xlsx`, not the `convert-to-file-xlsx` you looked it
up by. Two routes may not leave one output ("duplicate Success priority 0" means
you forked where you should have sequenced). `$now` and `$trigger` are not valid
expression roots. Each is now a local warning carrying the fix.

**Disabled node types look usable.** A tenant with Automation AI switched off
still serves the AI nodes in the catalog, schemas and all, and only rejects them
at import — after the graph has been designed around them. `flow_catalog` and
`flow_node_schema` now surface `isAvailable`/`unavailableReason`, so the choice
is informed rather than discovered late.

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

