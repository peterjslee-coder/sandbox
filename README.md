# Sandbox

A static hosting space for small working programs. No build step, no framework,
no server — plain HTML, CSS and ES modules, served from GitHub Pages.

## Adding a program

1. `mkdir apps/<slug>` and put `index.html` in it.
2. Link the shell so it inherits the design system:
   ```html
   <link rel="stylesheet" href="../../assets/shell.css">
   <script type="module">import { initTheme, registerSW, el } from '../../assets/shell.js';</script>
   ```
3. Add one entry to `apps.json`.
4. Add the new paths to `PRECACHE` in `sw.js` and bump `CACHE`.
5. Push. Pages redeploys on its own.

## What the shell gives you

`assets/shell.css` — color tokens (light + dark, both validated), cards, buttons,
status chips, the hub grid. Use the tokens; don't hard-code hex in an app.

`assets/shell.js` — `initTheme()`, `registerSW()`, `el()` DOM helper,
`encodeState()` / `decodeState()` for putting state in a URL hash, `copyText()`,
and `store` (localStorage that degrades quietly in private mode).

## Programs

### `apps/meeting-fit`

Meeting staffing check. A director enters a meeting title and its intended
outcome; keyword cues suggest which of six work types the meeting needs, which
the director confirms or overrides. Against the invited roster the app returns:

- which required types no one in the room is energized by, and who on the wider
  team could fill that gap
- who was invited but has no genius the meeting uses
- a suggested agenda sequenced by phase, with a named lead per stretch

Team profiles are entered by each person on the **My profile** tab, which emits a
short code they send back to the director. Everything is device-local; the only
data that travels is a code containing a name and six letters.

**Leader criteria.** The leader picks what a good meeting means to them —
decisions that hold, momentum, nothing slips, new thinking, nobody burned. Each
criterion carries weights over the six types, and a type's importance is the
strongest claim any active criterion makes on it. The coverage list is ordered by
weighted cost, and the read names the gap that costs *this* leader most rather
than the first one alphabetically.

**Forecast.** Logistic regression over this device's own debriefs — eight
features (gap count, a type nobody can do, a type resting on one person,
headcount, length, responsive/disruptive skew, altitude mismatch, how draining
the room found it) predicting whether the stated outcome was hit. Plain gradient
descent with L2, trained in the browser in about a millisecond, no data leaving
the device and no model API. Below `forecast.minMeetings` it says nothing;
between there and `confidentAt` it shrinks toward the rules-based prior by
`n / (n + shrinkK)` and says out loud that it is only a hint. Sample size is
shown next to every claim.

The model lives in `apps/meeting-fit/model.json` — types, phases, handoffs and
level definitions. The engine reads it generically, so pointing it at a different
framework is a file swap, not a rewrite.

**On the source of the vocabulary.** The six type names come from the assessment
a team has already taken; this tool stores and reads results, it does not assess
anyone and contains no assessment instrument. The model, its materials and the
official team map are The Table Group's.
