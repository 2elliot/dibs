# Analysis prompt — design note

The prompt (`prompt.ts`) is the product. Everything downstream (proposals, the handshake, the hidden
oracle) only works if the model returns findings that are **cited, concrete, and scoped to shared
keys**. This note records why the prompt is shaped the way it is, so tuning doesn't quietly undo it.

## What the model is asked to do

One finding per **shared key** — a key more than one participant has an item on. The user prompt
pre-computes that shared set and lists it, so the model doesn't have to infer sharing and can't
drift onto private keys. Keys outside the fixture vocabulary are out of scope.

## The five relations

`conflict` / `dependency` / `duplicate` / `compatible` / `unowned`, matching `protocol.RELATIONS`.
The reducer maps them (`docs/API.md`, "What `submit_analysis` writes"):

- conflict/dependency/duplicate → a **proposal** (needs `contractText`).
- compatible → an **aligned** contract (no vote); `contractText` = the agreed interface.
- unowned → a **notice**; `contractText` = `""`.

## Non-negotiable developer requirements

The charter's "exactly one session transport" is the planted S2 fault: one agent defaults to bearer,
another to cookie. The prompt tells the model a stated requirement is non-negotiable and to resolve a
true conflict by the charter (or the producer's own output), **not** by asking both sides to
compromise into a both-transports hybrid. A hybrid is what makes the hidden oracle pass by accident;
we want a real, single-transport contract.

## Concreteness

`contractText` must carry routes, methods, request/response JSON, header/cookie names, status codes,
exported names + signatures, and file paths. That is the bar the verifier's Droid SDK review checks
clause by clause, and the bar an agent needs to actually code against the contract.

## Citations are evidence

Every non-`unowned` finding must cite real `plan_item` ids. The reducer drops a finding whose cited
ids don't exist (rule 3) and ignores a finding on an already-`agreed` key unless it cites a genuinely
new/changed item (rule 8). `validate.ts` enforces the same locally so we never waste a `submit`.

## Tuning discipline

Per the plan: tune only on `plans-s2-dev`, the S2 pilot, the 13:30 traces, and the dry runs. S1 and
N are held out. Record the disclosure in the worker README. Changing the model or token budget is a
one-line change here (`MAX_OUTPUT_TOKENS`) and in `config.ts` (`anthropicModel`).
