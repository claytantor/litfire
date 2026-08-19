# The in-world clock

Every point in time in a vault is whole **seconds from the origin**, negative
before it. There is no other representation. A date you can read is produced at
the edge by a calendar, and never stored.

```yaml
# timeline/moments/the-substrate-patch.md
id: the-substrate-patch
at: -26174880000000000
```

## The origin

The origin is second zero. It is not configured — it is what `at: 0` means, and
every other instant is measured from it. What a vault _can_ say is what second
zero is called:

```
/time origin The Substrate Patch
```

That name is never parsed. It is the label on zero, and the one place the clock
says what it is anchored to.

## Why bigint

`at` is a `bigint`, and the range is **±1 trillion years** — about
±3.16 × 10¹⁹ seconds.

A JavaScript number carries 53 bits of integer precision, so it is exact only
to ±9,007,199,254,740,991: roughly ±285 million years in seconds. That sounds
generous until a vault sets its origin at the story's present and dates the
formation of a world before it. Past that bound the arithmetic does not fail —
it silently rounds, and two moments a minute apart compare equal.

The rounding is worse than it sounds because it is invisible in round numbers:

| Written               | As a number           |          |
| --------------------- | --------------------- | -------- |
| `-26174880000000000`  | `-26174880000000000`  | survives |
| `-26174880000000123`  | `-26174880000000124`  | **lost** |
| `1000000000000000001` | `1000000000000000000` | **lost** |

A format that is lossless for the values used in testing and lossy for the ones
used in writing is the kind of bug found years later, in someone's book.

::: tip This is enforced, not assumed
Frontmatter is parsed with `intAsBigInt`, so `at` never passes through a double
on its way in from YAML. A `number` already outside the safe range is **refused**
rather than adopted — silently taking a value the parser has damaged would bake
the damage in. Every other integer field stays a plain number; the widening is
exactly as broad as the clock.
:::

## Calendars

A calendar turns an instant into something readable, and sometimes back again.
It is a presentation choice, held in `timeline/time.md`, and changing it never
rewrites a moment.

### Seconds — the default

```
/time seconds
```

The numbers, grouped. A vault is entirely usable on this, and an author who has
not decided what a year is called in their world should not have to before
writing a scene.

### Earth/Sol — the Gregorian example

```
/time gregorian 2031-08-15T19:33:00-07:00 America/Los_Angeles
```

The epoch is the real instant the origin sits at; the zone is any IANA name.
Together they are the whole binding — the epoch is what makes second zero a
date rather than just zero.

This is shipped as the worked example of a `Calendar`, and it is genuinely
useful for any story set on Earth. It is timezone-aware and handles daylight
saving correctly, including the trap of subtracting wall-clock fields across a
transition — two calendar days spanning a fall-back is 49 hours, not 48.

::: warning Gregorian has a horizon
`Date` spans about ±273,790 years, and the clock spans ±1 trillion. Beyond that
the calendar reports `beyond this calendar` rather than a date. Clamping would
report something wrong by geological ages; throwing would take the timeline down
over a display concern.
:::

### A calendar you wrote

```
/time custom
```

Ten months of thirty-five days, a year that skips a day every seventh, four
moons on different cycles — these are functions, and any declarative schema
covering them would be a worse programming language than the one already in the
vault. So a custom calendar is a **formula**:

````markdown
```js id=calendar
seconds => {
  const DAY = 86400n;
  const YEAR = DAY * 320n;
  const year = seconds / YEAR;
  const day = (seconds % YEAR) / DAY;
  return `Year ${year}, day ${day + 1n}`;
};
```
````

It runs under the same rules as `xp_for_level`: in an isolate with no clock, no
network and no filesystem, under a 100 ms CPU limit, and only after `/consent`
approves this vault's formulas by hash. Being unable to name the current date is
precisely what makes it safe to run.

**It receives a `BigInt` and must return a string.** Both are deliberate — a
double would round the very instants the clock was widened to hold, and a string
is the only thing a date can be once a world stops using months.

Without consent, the clock falls back to seconds and says why. A display concern
must never stop a vault loading.

## Reading it

```
/time
```

Shows the binding and every dated moment three ways at once: the raw seconds,
the calendar's reading, and the distance from origin. Seeing them side by side
is what makes a wrong epoch obvious — a date out by a century looks fine alone
and wrong the moment it sits next to the number it came from.

```
time
calendar   Gregorian (America/Los_Angeles)
origin     The Substrate Patch
epoch      2031-08-15T19:33:00-07:00

  moment                  seconds              reads as              from origin
  the-substrate-patch     0                    2031-08-15 19:33:00   0s
  the-cambrian-activation 9,460,800,000,000    beyond this calendar  ~299,794 years
```

Wiki moment pages carry both for the same reason.

## Converting a date

```
/time at 2036-08-15 02:30:00
```

```
at: 157791420
reads as     2036-08-15 02:30:00
from origin  ~5 years
```

The bare integer comes first and unpunctuated, because the next thing you do
with it is paste it into a moment's frontmatter.

It converts **either way**, and decides which by looking at the input rather
than asking: a bare integer is already an instant and gets read back as a date,
anything else is a date and gets converted. Grouped digits are accepted too,
since that is how `/time` prints them.

::: warning A calendar formula is one-way
A custom calendar formats and cannot read dates back — there is no way to invert
an arbitrary function. `/time at` still converts seconds while one is bound, and
says plainly why it cannot go the other way.
:::

## Durations

Spans longer than a day are reported with a leading `~` and computed against a
Julian year of 365.25 days. That constant exists only to make large numbers
readable — it is not a claim about any calendar, and it never reaches one. A
fictional world's year is whatever its calendar says.

## Undated moments

A moment with no `at` is **recorded but not placed**. It does not enter the
replay sequence, so nothing it carries reaches the ledger, and a scene anchored
to it still has no clock position. That is a valid permanent state, not an
error: an author often knows a thing happened long before knowing when.

`/lint` reports them so they are never silently inert.
