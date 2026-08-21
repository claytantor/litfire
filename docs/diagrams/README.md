# Diagrams

PlantUML sources, with a rendered SVG committed beside each so the docs
site and GitHub can show them without a PlantUML install.

| Diagram                                        | What it says                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`authoring-flow.puml`](./authoring-flow.puml) | Where a fact goes from the moment you write it to the manuscript. Every arrow into the corpus passes through the review gate; everything below the corpus is regenerated from it. |

To re-render after an edit:

```sh
java -jar plantuml.jar -tsvg docs/diagrams/authoring-flow.puml
```

Colours are litfire's own TUI role colours from `source/theme.ts` — the
author's layer, the model's, and the computed one — so a diagram and the
terminal agree about who owns what.
