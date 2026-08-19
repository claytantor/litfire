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
