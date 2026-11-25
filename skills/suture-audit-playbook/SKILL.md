---
name: suture-audit-playbook
description: Standard procedure for auditing Suture .suture.json models with the Exorcist and for proving a non-masking formula or SQL patch with suture_verify_patch (counterexampleFixed, freshAuditPassed, zero regressions) before anyone edits a file.
always: false
triggers: suture audit, exorcist, audit workbook, verify patch, formula fix, non-masking fix, suture_run_audit, suture_verify_patch
---

# Suture audit playbook

Use this procedure whenever you audit a Suture workbook or propose a fix for one. Each step names the MCP tool it uses.
Every tool result is recorded with `suture_crew_record_audit` so the Suture Crew dashboard shows the same evidence the
chat does.

## The servers

| Server | Root | Use it for |
|---|---|---|
| `@suture-crew:suture` | `SUTURE_WORKSPACE`, or the folder the server started in | The user's own `.suture.json` models |
| `@suture-sample` | The app's bundled `samples/` folder | `wholesale-quote.suture.json`, the zero-setup demo |
| `@suture-crew:ledger` | The app's data folder | `suture_crew_record_audit` only |

`flagship:1` (SaaS runway) and `flagship:2` (100,000-row e-commerce margin) are built into every Suture server.

## 1. Inventory

1. `suture_list_workbooks`. Record it (`source` = the server you called).
2. A file entry with an `error` is not a valid workbook. Report the error text and skip the file.
3. Note each workbook's `python` field. `blocked` means it has `=PY()` cells that will evaluate to `#PY!` unless the
   user trusts the file. Under Node, trusted Python can reach the file system and the network, so trust is the user's
   decision, made in the conversation, for one named file.

## 2. Audit

1. `suture_run_audit { workbook }`. Leave `trustPython` unset unless the user trusted this file in this conversation.
   Leave `seed` unset for a fresh search; quote the returned `seed` so the run can be repeated.
2. Record the result.
3. Read `verdict`:
   - `passed`: every Tier 1 invariant and Tier 2 assertion held for `search.runs` runs. This is evidence, not proof.
   - `violated`: continue with step 3.
   - `configError`: the workbook's `exorcist` block is wrong (`message` says how). Fix the configuration, not the model.
   - `stopped`: the run was interrupted; run it again.

## 3. Read the counterexample

- `violation`: the tier (1 = universal invariant, 2 = the workbook's own assertion), its `id`, `rule` and `detail`.
- `failingInputs`: the shrunk inputs. Shrinking keeps only what is needed to fail, so these values are the story.
- `lineage`: every cell from those inputs to the violated cell, with its `dialect` (`literal`, `sql`, `py`, `formula`),
  its counterexample `value`, and its `base` value.
- `failingEdge`: the first edge `from -> to` where the value went wrong. The cause is usually at or above `from`.
- `replay.fragment`: the X-Ray link body. The link is `https://suture-nu.vercel.app/#` + fragment.

See the `suture-replay-triage` skill for classifying the violation and explaining error values.

## 4. Find the cause, then fix it there

Call `suture_inspect_lineage` on the cells along the failing edge. The cause is the first cell whose rule is wrong for
the counterexample. Typical causes:

| Symptom at the asserted cell | Usual cause upstream | Non-masking fix |
|---|---|---|
| Negative or zero price | Discounts added in SQL (`1 - (a + b + c)`) | Compound them: `(1 - a) * (1 - b) * (1 - c)` |
| Discount above policy | Cap applied to each term | Cap the stacked total once |
| `#DIV/0!` or a sign flip in a ratio | Denominator reaches zero or changes sign | Guard only where the guarded value is the correct business answer, and say why |
| `#NUM!` | Non-finite intermediate (overflow, NaN, `0^0`) | Fix the operation that produced it |

**Masking is not a fix.** Do not wrap the failing cell in `IFERROR`, clamp an output with `MAX`/`MIN` to satisfy an
assertion, delete or loosen an assertion, or narrow a fuzz domain. Each of these makes the audit pass while the model
still computes the wrong number.

## 5. Prove it

1. `suture_verify_patch { workbook, patches: [{ cell, formula }], replayArtifact }`, passing the `replay.artifact`
   from the audit so the original counterexample is replayed against the patched model. The file on disk is not changed.
2. Record the result.
3. Accept the patch only when **all** of these hold:
   - `ok: true`
   - `counterexampleFixed: true`
   - `freshAuditPassed: true` (a new Exorcist search with the same seed found nothing)
   - `regressions: []` (no check that held at the original base case now fails, and no cell newly evaluates to an error)
4. Show `baseValueDiffs`: the base-case values the patch changed. A correct fix often changes them; the reviewer must
   accept each one.

## Worked example: the bundled sample

`wholesale-quote.suture.json` prices a quote. `Pricing!A1` is DuckDB SQL:

```sql
SELECT {{Inputs!B2}}::DOUBLE * (1 - ({{Inputs!B3}}::DOUBLE + {{Inputs!B4}}::DOUBLE + {{Inputs!B5}}::DOUBLE)) AS net_price
```

The SQL adds the three discounts instead of compounding them, so once they sum to 1 or more the net price is 0 or
negative. The Exorcist finds this, violating `net-price-positive` on `Quote!B2`, and downstream
`Quote!B4 = (B2-B3)/B2` sits on a division cliff. One shrunk counterexample is volume 0.4 + promo 0.4 + loyalty 0.2
(a price of exactly 0); the exact shrunk values vary with the random seed, so report the ones the audit returned. The
non-masking fix compounds the discounts in the SQL:

```text
Pricing!A1  =SQL("SELECT {{Inputs!B2}}::DOUBLE * (1 - {{Inputs!B3}}::DOUBLE) * (1 - {{Inputs!B4}}::DOUBLE) * (1 - {{Inputs!B5}}::DOUBLE) AS net_price")
```

`suture_verify_patch` returns `ok: true`, `counterexampleFixed: true`, `freshAuditPassed: true`, `regressions: []`, and
`baseValueDiffs` showing the base net price moving from 96 to 97.47 (compounded discounts are slightly smaller).
Wrapping `Quote!B4` in `IFERROR` would have hidden the cliff and left every quote with stacked discounts underpriced.
