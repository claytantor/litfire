# The formula sandbox

`setting/formulas.md` holds fenced `js` blocks with an id:

````markdown
```js id=xp-for-level
level => (level <= 10 ? 100 * level ** 2 : 150 * level ** 2);
```
````

These are author-supplied executable code, so they run in `isolated-vm` — a real
V8 isolate, not `node:vm`, which shares a heap with the host and is not a security
boundary.

- No `fetch`, `process`, `require`, or module loaders (absent from a fresh isolate).
- `Math.random`, `Date.now`, and `Date` are **explicitly removed** — they exist in a
  fresh isolate and would break deterministic replay. A formula touching them throws.
- 100 ms CPU timeout, 16 MB memory cap, enforced per call.
- Formulas are hashed. Opening a vault you did not create leaves them disabled
  until you run `/consent`, because a shared corpus is executable code.

Everything except the formula curve works with formulas disabled.
