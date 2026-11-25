---
name: suture-replay-triage
description: How to classify a Suture audit violation as a Tier 1 universal invariant or a Tier 2 workbook assertion, explain #DIV/0!, #NUM!, #SQL! and #PY! values in plain language, and produce a shareable Suture X-Ray replay link.
always: false
triggers: tier 1, tier 2, invariant, assertion, replay link, x-ray, #DIV/0!, #NUM!, #SQL!, #PY!, counterexample triage
---

# Suture replay triage

Use this when you explain a `suture_run_audit` result to a person.

## Tier 1 or Tier 2

**Tier 1** invariants hold for every Suture workbook. A Tier 1 violation means the model, or an engine boundary, did
something no spreadsheet should do:

| id | Meaning |
|---|---|
| `T1.noUnhandledException` | A kernel threw instead of returning a value or an error |
| `T1.noNonFiniteLeak` | NaN or ±Infinity reached a cell instead of becoming `#NUM!` |
| `T1.strictErrorPropagation` | An error did not propagate strictly from its origin |
| `T1.editOrderDeterminism` | Results depended on the order inputs were edited |
| `T1.crossEngineTolerance` | SQL and NumPy disagreed by more than 1e-9 (batched mode) |

**Tier 2** assertions are the workbook's own business rules, declared in its `exorcist.assertions`: `gte`, `lte`, `gt`,
`lt`, `between`, `notError`, `finite`, `notNull`, and `monotonicWith`. A Tier 2 violation means the model is
well-behaved as a program but wrong as a model: a runway below zero, a price at zero, a margin above 100 %.

In the audit result, `tier1` and `tier2` list every check with a status. Tier 2 checks after the first violation show
`not reached`: the search stopped at the first failure, so they were neither proven nor disproven.

## Error values

Each error value in Suture carries a message, the cell it started at (`origin`), and the engine (`formula`, `sql`,
`py`).

| Value | Plain-language meaning | Where to look |
|---|---|---|
| `#DIV/0!` | A formula divided by zero | The denominator's lineage; which fuzz input drove it to zero |
| `#NUM!` | A number that is not finite: NaN, ±Infinity, overflow, `0^0`, a non-finite SQL or NumPy result | The first cell in the lineage whose value is not finite |
| `#SQL!` | The DuckDB query failed: a syntax error, a type error, a missing bound table | The `=SQL()` cell named in `origin`; the message is DuckDB's |
| `#PY!` | The Python cell failed, or it is blocked because the workbook's Python is not trusted | The `=PY()` cell; if the message says it is blocked, the user has not trusted the file |
| `#VALUE!`, `#REF!`, `#NAME?`, `#N/A`, `#CYCLE!`, `#TIMEOUT!` | Wrong type, bad reference, unknown name, lookup miss, circular reference, engine timeout | The cell in `origin` |

An error that appears at the asserted cell usually started upstream. Report `origin`, not just the cell that failed.

## Writing the triage

1. One sentence: tier, id, the asserted cell, and the rule. Example: "Tier 2 `net-price-positive` failed: `Quote!B2`
   must be > 0 and was 0."
2. The shrunk inputs, as a short list of `cell = value`.
3. The lineage chain with dialects, inputs first: `Inputs!B3 (IN) -> Pricing!A1 (SQL) -> Quote!B2 (FX)`, with each
   step's counterexample value and base value, and the `failingEdge` marked.
4. The cause in one sentence, if the lineage shows it.

## The X-Ray link

- Link: `https://suture-nu.vercel.app/#` + `replay.fragment` (the fragment starts with `replay=v1.`).
- `replay.fragment` is `null` when the artifact would make a URL longer than 8,192 characters. Say so; the replay
  artifact (`replay.artifact`, format `suture.replay`) can be downloaded from the Suture Crew dashboard and imported in
  Suture with **Download / Import Replay JSON**.
- For `flagship:1` and `flagship:2`, the link opens the workbook and replays the counterexample directly.
- For a `.suture.json` file, Suture matches the artifact's `workbookHash` against the workbooks it already has. The
  bundled `wholesale-quote.suture.json` is built into Suture's live app (**Wholesale Quote (Crew sample)** in the
  workbook picker), so its link opens and replays directly. For the user's own workspace models, Suture asks the user to
  import the same file first when it has no workbook with that hash yet, then replays it. Tell the user this before
  they click.
- The link contains the counterexample's input values. Treat it like the model itself when sharing.
