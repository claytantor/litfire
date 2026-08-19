# The reviewer

`/reviewer` opens a chat with a literary editor that has read the corpus.
Unlike
an interview, the author drives: ask about structure, pacing, a character's
arc, whether a theme is actually landing, or where two scenes disagree.

```
› /reviewer
  reviewer — ask anything about the corpus
  `fix <id|arc|everything>` proofreads; corrections are spelling and
  grammar only, and every one still goes through review

▸ you      does the ledger room appear anywhere before arc-02?
◂ reviewer Twice. sit-014 puts it on the third floor; sit-031 has Carl
           taking stairs *down* to it. Both call it the same room. I have
           not decided which is right — that is yours.
```

**Conversation is wide; writing is narrow.** The reviewer will discuss anything
and is asked to be direct rather than encouraging. The only change it can
propose is spelling, punctuation, and grammar.

## The guard

"Grammar and spelling only" is enforced structurally, not requested in a prompt
— a prompt is a request, and one sloppy generation separates "fix my typos"
from "improve my prose". Every proposal is checked in `source/reviewer/guard.ts`
**before** it reaches the review queue:

| Rule                               | Rejects                           |
| ---------------------------------- | --------------------------------- |
| Frontmatter byte-identical         | any data, event, or ledger change |
| Numbers preserved                  | `40 gold` → `50 gold`             |
| Wikilink targets preserved         | rewiring the graph                |
| Generated marker regions identical | editing a `litrpg:status` block   |
| Line count unchanged               | an added or deleted sentence      |
| Per-word alignment                 | `walked` → `sauntered`            |
| Insertions from a closed class     | `the steps` → `the cold steps`    |

The word-level check is the interesting one. A single swapped word inside a long
paragraph barely moves a whole-line similarity score, so a line-level test would
wave through exactly the edit that must not pass. Aligning word by word
separates "this word became a similar word" from "this word became a different
word", which is the actual distinction between a correction and a style edit.

Word comparison is Damerau-Levenshtein rather than plain Levenshtein, because a
transposition costs two edits under plain Levenshtein — which refuses `teh` →
`the`, the most common typo there is.

The insertion rule came out of probing the guard with realistic prose rather
than from the original design: counting inserted words allows one, and one
inserted word is `the cold steps`. Grammar fixes insert closed-class words —
articles, prepositions, auxiliaries — and writing inserts everything else, so
only the closed class is permitted. Deletions additionally allow any repeated
word, which is the doubled-word fix.

**What it cannot catch**, stated precisely: `isCorrection` always admits an edit
distance of 1, because without that escape it would refuse `a` → `an`. So a
one-character substitution that changes meaning — `cold` → `bold`, `he` → `she`
— reads as a typo fix and passes. Numbers and links have their own rules;
single-character prose swaps do not. The review gate is the backstop, which is
why the guard narrows what reaches the author rather than replacing their
judgement. Refusals are reported into the conversation rather than dropped, so
a reviewer that oversteps is visible instead of looking like it found nothing.

## Grounding

A novel does not fit in a context window. Every turn ships a compact **corpus
map** — one line per file, plus open questions — and then the full text of only
the files a deterministic keyword match associates with the question. No
embeddings, no index to rebuild. Grounding is recomputed per question, so the
fifth question is not answered with the files that mattered to the first.

## Fixing

`fix <id>`, `fix <arc>`, or `fix <path>` proofreads that target. `fix everything`
covers the corpus but warns what it will cost first, because a whole-corpus pass
on a real novel is a large request and a long review queue. A target that
matches nothing returns nothing rather than guessing — silently proofreading the
wrong forty scenes is the expensive failure here.

Contradictions are surfaced, never resolved (§8). The reviewer reports what each
side claims and where; which one is true is the author's call, and a
contradiction is never a spelling error.
