# Skills

A skill is something a character can do that they could not always do.

That last clause is the whole primitive. An artifact can be taken away; a skill
is in the person, and nobody can be disarmed of it. So the interesting part is
never the ability in the abstract — it is the scene where somebody got it, and
every scene after that where they have it.

litfire tracks exactly that. You write down what the skill is, a scene says who
acquired it and when, and from that point forward in the timeline it appears on
their status screen. You never write "and she still has it" anywhere.

## Writing one

A skill is a page like any other primitive:

```
raw/skills/pattern-reading.md
```

Prose in the body, and as much or as little frontmatter as you have decided:

```yaml
---
id: pattern-reading
name: Pattern Reading
system: the-lathe
requires_skills: [seed-contact]
requires_level: 3
---
What she can do is not read minds. It is read the shape of a decision after it
has been made, in the seconds before anyone acts on it.
```

Only `id` is required, and even that defaults to the filename.

| Field             | Is                                                 |
| ----------------- | -------------------------------------------------- |
| `id`              | Kebab-case, and the filename                       |
| `name`            | What it is called on the page                      |
| `system`          | The system that grants it. Omit for "every system" |
| `requires_skills` | Skills a character needs first, by id              |
| `requires_level`  | The level below which it cannot be acquired        |

Then, as with everything under `raw/`:

```
/ingest skill
```

which proposes the typed page in `corpus/skills/` through the review gate, and
never touches your note.

::: tip You do not have to decide the mechanics yet
`requires_skills` and `requires_level` are both optional and both easy to add
later. A skill with a name and three paragraphs about what it costs someone is a
complete and useful page. The checks will tell you if it ever contradicts a
scene.
:::

## The other place a skill can live

Skills predate having pages of their own, and the older form still works — a row
in a system's frontmatter:

```yaml
# raw/systems/the-lathe.md
skills:
  - id: pattern-reading
    name: Pattern Reading
    requires_skills: [seed-contact]
```

That is a fine way to sketch a dozen at once. What it cannot do is say what any
of them _is_, which is why pages exist.

**Both are legal at the same time, and the page wins field by field.** Writing a
page for a skill your system already lists does not retract the `requires_level`
you set there months ago — it fills in what the row had no room for. If you set
the same field in both, the page is the answer.

## Which system grants it

`system:` matters when your vault has more than one, because prerequisites
resolve through the **acquiring character's own system**. A skill The Seed grants
is not undefined merely because the Custodian never heard of it.

Leave the field out and the skill is available under every system, which is what
an author with one system means without having to know the field exists. Name a
system, and acquiring it under a different one is reported:

```
unknown_skill: 'pattern-reading' is not defined by system 'the-panillion-mesh'
```

## Putting it on somebody

A page declares that the skill exists. An **event in a scene** is what puts it on
a person:

```yaml
# raw/situations/sit-014-the-vent.md
events:
  - actor: linh-tran
    type: acquire_skill
    skill: pattern-reading
    note: what the Seed showed her
```

From that situation forward, `pattern-reading` is in Linh's state — so it renders
in `{skills}` on her status screen in that scene and every scene after it in the
timeline. `lose_skill` takes it back off, from that point forward.

The prose describing _how_ she came by it belongs in that scene's body, not on
the skill's page. The page is what the skill is; the scene is what happened. A
skill three people acquire has one page and three stories.

::: warning The tool will never write this event for you
What happens in a scene is the story. litfire proposes pages, formulas and
structure; it does not decide that somebody learned something. That line is the
same one that keeps it out of your prose.
:::

## What gets checked

| Finding                     | Means                                                       |
| --------------------------- | ----------------------------------------------------------- |
| `unknown_skill`             | A scene acquires a skill nothing defines — usually a typo   |
| `skill_before_prerequisite` | Acquired before something it says it requires               |
| `skill_acquired_twice`      | Two scenes both grant it to the same person                 |
| `artifact_without_skill`    | Someone used a thing whose `requires_skills` they lack      |
| `broken_reference`          | The page names a system or prerequisite that does not exist |

All of them are reported, never enforced. A prerequisite acquired in the wrong
order is sometimes the point — the tool's job is to be sure you noticed.

## Its page in the wiki

`/wiki build` writes `wiki/skills/<id>.md` for every skill it can see: one you
gave a page, one a system declares, and one that exists only because an event
named it. That last case is called out on the page, because a skill nobody ever
wrote down is a typo until proven otherwise.

Each page carries what the skill requires, which system grants it, **every
character who acquired it and the scene where they did**, and your own prose from
the corpus page.

A skill you have only just written gets a page immediately, saying nobody has it
yet. That is a useful thing to be told.
