# Writing a scene

`/situation new [title]` scaffolds a scene and opens it in the native buffer;
`/situation edit <id>` reopens one. No external process is involved — the
terminal you are already in is where the writing happens.

```
editing situations/inbox/sit-001-the-ledger-room.md
ln 1/4 · col 1

1 The ledger room was on the third floor, which Carl only
2 learned after taking the stairs down to it twice.
3
4 "You said down," he said.

^s save · esc discard · ^z undo · ^k kill line
```

| Key           | Does                                        |
| ------------- | ------------------------------------------- |
| `^s`          | Save and close                              |
| `esc`         | Close; asks once if there are edits to lose |
| `^z` / `^y`   | Undo / redo                                 |
| `^k`          | Kill to end of line, then the break         |
| `↑↓←→`        | Move; `home`/`end` for the line             |
| `alt+←→`      | Move by word                                |
| `pgup`/`pgdn` | Move by a screen                            |

**Undo is per run of typing, not per character.** An undo stack that gives back
one letter at a time is, for prose, the same as having no undo. A run ends when
you delete, press enter, paste, or move the cursor away.

**The buffer edits the body, never the frontmatter.** A situation's frontmatter
is what `/situation place`, extraction, and the ledger maintain; the prose is
the author's alone (P6), and that is the half the buffer opens on. Frontmatter
is written back exactly as it was parsed, so a save can normalise its formatting
but can never change its meaning. To edit it, use Obsidian or any editor — the
vault is plain files, and always was.

The buffer opens on what is on disk at that moment, not on the last recompute,
so a scene changed in Obsidian a second ago is the version you get.
