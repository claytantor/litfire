# Review gate

Every LLM write lands as a unified diff before it touches disk (P3: the tool
proposes, the author disposes). Built generic and UI-free in `source/review/`
because §9 says the Slice 2 spinner reuses it wholesale.

```
review — system                          1/2 · 0✔ 0✖ 2•
system/stats.md                               • pending
+4 −8 · confidence: low
Memory named as the cost of levelling; range inferred.

@@ -3,16 +3,12 @@
   - id: strength
-    min: 0
+  - id: memory
+    name: Memory

a accept · r reject · e edit · A accept-all · ←→ item · ↑↓ scroll
```

- **Nothing pending is ever written.** A proposal reaches disk only on an
  explicit accept. `enter` applies once every item is settled; `ctrl+s` applies
  whenever you like, and is the way out mid-review — with everything settled
  `enter` is quicker, but with items still pending it is a silent no-op, which
  is exactly when an author wants to save what they have.
- **`ctrl+s` confirms before it writes.** It states the counts — how many will
  be written, how many rejected and still-pending will be skipped — and needs a
  second `ctrl+s`; any other key backs out. While the prompt is up no other key
  reaches the review, so a stray `a` cannot quietly accept something behind it.
  An accepted item whose path the vault would refuse blocks the save and is
  named, rather than being reported as a failure after the fact.
- **Edit opens an inline buffer.** `e` edits the proposal in place — gutter,
  block cursor, `ctrl+s` to save, `esc` to discard. `ctrl+e` hands off to
  `$EDITOR` for anything too large to fix comfortably in a pane.
- **Proposal paths are untrusted.** They come from a model, so every path is
  resolved canonically and must land inside the vault and end in `.md`.
  `.litrpg/` (tool cache), `ledger/` (derived), and `raw/` (author input) are
  refused. A bad path fails that one item; the rest of the batch still applies.

## Where proposals come from

Extraction, `/reviewer`'s correction pass, and `/curator` all produce them.
The curator may decide to propose on its own — it ends a reply with a plan
directive and the structural pass runs — or you can ask for one directly with
`plan <instruction>` inside `/curator`.

Either way nothing has happened yet. A proposal is a suggestion until you accept
it here, which is why it does not matter who started the pass.

## Leaving with changes accepted

Accepting marks a decision. Only applying writes it — and until it does, `q` and
`esc` would have thrown the batch away.

Leaving with accepted changes now asks:

```
3 accepted change(s) have not been written yet
ctrl+s to write them · esc again to discard · any other key to go back
```

With nothing accepted it leaves at once, because a prompt whose answer is always
the same is noise.

## Changes to raw/

`raw/` is your own record, and every agent is forbidden from writing there —
except `/curator`, on your instruction, and still only as a diff you accept.

Those items are labelled `(your raw record)` so they never read as an ordinary
corpus write. The curator is told to correct what is wrong _about_ the record —
a name spelled two ways, a link that no longer resolves — and never to rewrite
what you said. Your phrasing, hesitations and contradictions are the material; a
tidier transcript is a worse one.

`ledger/`, `wiki/`, `manuscript.md` and `.litrpg/` stay closed to everyone,
curator included: they are derived, and a write there is overwritten on the
next recompute.

## Removals

A proposal can remove a file as well as write one. It arrives in the gate like
any other item, labelled `(removes file)`, with the whole file shown coming out
rather than an empty panel:

```
timeline/moments/the-first-memory.md (removes file)
• pending
+0 −24
```

`e` is not offered — there is nothing to edit, and accepting is the only thing
that acts. The same path rules apply as for a write, so `raw/`, `ledger/`,
`wiki/` and anything outside the vault are refused; a removal naming one of
those is worse than a write naming it, not better.

**Why this exists.** Corpus is generated, and generation makes duplicates:
extraction run twice over one interview slugs the same event two ways and leaves
two pages for one moment. Until removals existed, the agent that noticed could
only describe the problem — the tool could create the mess and not clear it up.

`/lint` reports the two cases worth acting on:

- **`duplicate_id`** — two pages declaring the same id. Everything that resolves
  it sees only one; the other is invisible while still on disk.
- **`duplicate_name`** — different ids, one name. This is the one that actually
  happens, and no id check would ever catch it.

Neither is resolved for you. Which page is the real one is an author's call.
