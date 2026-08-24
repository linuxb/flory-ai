# Refine and Harness-State (04)

> Status: Draft v0.1 | Depends on: [00-overview](./00-overview.md) | The mechanism follows prime-agent's Continual Harness, while Flory's metadata-only state model and mem-hints are original.

## 1. Design Position

Harness-state is Flory's self-optimization layer. It influences the prompt quality of a future task or turn, but **never stores raw text**: no concrete context, prompts, or long-term-memory content. It stores only:

1. **Assembly-rule parameters**, such as enabled sections, order, and budget weights.
2. **Behavior-policy metadata**, such as tool preferences, disproven paths, and subagent specifications.
3. **Mem-hints**, which specify how to query memory rather than containing memory.

The final prompt is assembled by a pure function:

```
assemble(harness_state@vN, task_input, linearized_ctx) → prompt
```

The same input always produces the same output. This purity enables exact prompt diffs, historical fork evaluation, inverse-edit rollback, and replay testing.

## 2. Harness-State Schema

```jsonc
{
  "schema_version": 1,
  "scope": "local",
  "entries": {
    "assembly_rule": {
      "ar-01": { "section": "tool_guidance", "enabled": true, "order": 3,
                 "token_budget": 400, "version": 2 }
    },
    "policy_hint": {
      "ph-02": { "kind": "tool_preference", "tool": "inventory.check",
                 "rule_ref": "prefer_batch_query", "evidence_seqs": [412, 587], "version": 1 }
    },
    "mem_hint": {
      "mh-03": {
        "trigger": { "task_type": "pricing", "channel": "amazon-au" },
        "query": { "store": "mem-pg", "recipe": "SELECT lesson FROM pricing_lessons WHERE channel=$1 ORDER BY score DESC LIMIT 3", "params_from": ["task.channel"] },
        "ttl_days": 90, "version": 1
      }
    },
    "subagent_spec": {
      "sa-04": { "purpose": "listing_qa", "planner_template_ref": "tpl://listing-qa@v3",
                 "when": "post_publish", "version": 1 }
    }
  },
  "refinements": []
}
```

- Any text that can appear in a prompt is stored through a `*_ref` or `recipe` reference; the raw text lives in a versioned template library or memory store. Harness-state contains no prose.
- `evidence_seqs` anchors every policy to concrete event-log events, preserving provenance for every lesson.

## 3. Mem-Hints: Query Recipes, Not Memory

Unlike prime-agent, which stores raw memory and injects it after truncation, Flory resolves a mem-hint during assembly:

```
assembly:
  for hint in match(mem_hints, task_input):
      results = execute(hint.query, task_input)
      prompt_sections += render(results, hint)
```

Benefits:

- **Freshness:** memory updates require no harness-state refine; a query naturally retrieves the latest data.
- **Cost:** potentially useful memory does not consume persistent tokens; a non-matching trigger costs zero.
- **Governance:** memory-store permissions, redaction, and TTL are managed independently, with no leakage surface in harness-state.

`query.recipe` must come from a whitelisted, parameterized, read-only, row-limited query template. Refine may choose or parameterize a template, never generate arbitrary query code. This prevents injection and preserves assembly purity against the same memory snapshot.

## 4. Refine Flow

### 4.1 Triggers

| Trigger | Description |
|---|---|
| Human API | `POST /runs/{id}/refine`, optionally with targeted instructions. |
| Automatic N-turn trigger | Run the review gate after every N planner turns (default: 25). |
| Event trigger | Run the gate once after rollback and once when a run ends. |

### 4.2 Two stages

```
gate (low-cost model, small budget)
  input: recent log summary + current harness-state overview
  output: {should_refine, rationale, instructions}
  policy: reject one-off noise and unsupported assumptions; 20-minute cooldown
    ↓ should_refine
propose (structured output)
  output: JSON edits {action, kind, id, payload, reason, evidence_seqs, expected_outcome}
    ↓
validate (deterministic)
  schema, mem-hint template, and scope validation
    ↓
apply (optimistic concurrency)
  compare baseline version; record before/after snapshots for every edit
    ↓
evaluate (Flory-specific; see 4.3)
```

Validation rejects global-scope overreach because global is read-only during local refinement; a local override is required. Apply rejects version conflicts and writes each edit to refinement history.

### 4.3 Historical evaluation and rollback

prime-agent's `expectedOutcome` is free text and is not verified. Flory replaces it with a reproducible offline gate:

- Every refine creates `harness_state@vN`; evaluation substitutes that version into forks of selected historical runs while keeping every other inherited event unchanged.
- `expected_outcome` is a measurable structure, for example `{evaluator_ref, metrics, acceptance_rules, corpus_ref}`. `corpus_ref` resolves to explicit `(run_id, at_vertex_id, eval_up_to_seq)` tuples rather than an undifferentiated traffic window.
- Each source/fork pair is evaluated independently at a declared `fold_mode`. Exact prompt diffs and deterministic invariant checks are hard gates; model and live-read scores are recorded with their evaluator pins and limitations.
- A refine that fails any hard gate is rejected before promotion. Passing cases produce a reviewable recommendation, not automatic production authorization, because unrelated ToB histories are not parallel samples.
- Rollback remains mechanical: replay the stored inverse edits and record a new versioned refinement event. In production it is triggered by an absolute safety guardrail or an operator decision, never by a cross-case comparative estimate.

### 4.4 Scope discipline

- Default to `local`; promotion to `global` is explicit and requires evidence across at least K different runs.
- During local refine, global entries are read-only. Use a local override; local values win on merge and conflicts are prefixed.

## 5. Interfaces with Documents 01–03

- Refine input evidence is a projection of the [event log](./01-jit-dag-and-event-log.md); `evidence_seqs` directly name event sequences.
- The mandatory post-rollback gate in [03](./03-replan-and-recovery.md) is the main path by which failure lessons enter `policy_hint` or the memory store.
- Repeated check-rule rejection patterns from [02](./02-transaction-model.md) should refine policy hints to help planners avoid mistakes. The rule engine decides admission; refine reduces wasted attempts. These responsibilities do not overlap.

## 6. Open Questions

- Memory-store write flow: should refine write a lesson directly or create a pending record for human review? Start with the latter.
- Historical-corpus curation: define how cases are selected and retired without allowing cherry-picked examples to masquerade as general evidence.
- The tension between assembly purity and fresh memory. Strict replay should pin a memory snapshot and resolve queries from recorded cache.
