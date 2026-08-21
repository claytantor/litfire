# Places

A place is somewhere a scene happens. It is the thinnest
[primitive](../concepts/primitives.md) in the vault — an id, a name, and prose —
because what a room is like is writing, not data, and no field was going to
capture it.

```
/place new The Ledger Room
```

Writes `corpus/places/the-ledger-room.md`, slugging the name into the id, and opens the
[buffer](./writing-a-scene.md) so you can describe it.

| Form                      | Does                                    |
| ------------------------- | --------------------------------------- |
| `/place`                  | Everywhere, and what has happened there |
| `/place <id>`             | One place: its scenes and its cast      |
| `/place <id> edit`        | Write its description                   |
| `/place <id> name <text>` | Rename it                               |
| `/place new <name>`       | Write a new one, and open the buffer    |

As everywhere else, the verb may come before or after the id.

## Linking a scene to it

```
/situation sit-002 place the-ledger-room
```

That is the only link a place has, and it points at the place rather than away
from it: a situation says where it happens, and the place reads that back.

```
/place the-ledger-room
```

```
the-ledger-room — The Ledger Room

scenes here
  sit-002 — The Ledger Room
  sit-014 — Carl Takes the Stairs Down

who has been here
  carl, donut
```

## Two kinds of unfinished

A place can exist in either direction, and both are legitimate:

| State                                 | Means                                     |
| ------------------------------------- | ----------------------------------------- |
| A page with no scenes                 | Somewhere you have built and not yet used |
| A scene naming somewhere with no page | Somewhere you have used and not yet built |

`/place` lists both and says which is which — `no scenes` against `no page yet`.
Naming a place from a situation never requires the page to exist first; the link
is made, the gap is reported, and the wiki builds a page either way.

::: tip This used to be a bug
Wiki place ids were derived from `situation.place` alone, so a place you had
written but not yet used was invisible: no page, no name, nothing listing it.
Ids now come from both directions (D12).
:::

## In the wiki

Every place gets a page, whichever direction it came from. It carries your prose
first, then the scenes there in sequence order, who has appeared in them, and
which scene was first and last.

A place with no page of its own is titled by its id and says plainly that
nothing describes it yet, rather than rendering a tidy stub.
