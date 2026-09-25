# Motion vocabulary

Names for what scrub measures. Measure first (frames, ms, motion table),
then name the effect with a term from this file so the user gets a
diagnosis instead of a list of coordinates.

- Say "reads as" when the name comes from the bbox curve alone, and
  confirm on the sheets before stating it as fact.
- Combine terms rather than inventing new ones: "a 40 ms stagger of
  scale-in entrances with a slight pop".
- If nothing here fits, describe the motion in these words and say it
  is an approximation.

## Reading the signal

Each motion-table row compares a frame with its predecessor. The bbox
covers the old and new position of whatever changed, so:

- **Per-frame displacement** is the change in `cx`/`cy` between rows.
  For a solid element moving along one axis, it also equals bbox width
  (or height) minus the element's resting size. The shape of this
  displacement series is the easing.
- **Center fixed while `w×h` changes** means scale, pop, pulse, or
  rotation. **Center moving** means translation.
- **`changed_px` without a moving center** means opacity, color, blur,
  or a reveal. `changed_px` counts pixels whose luma moved more than 24
  levels; `faint_px` counts those past `--threshold` (default 8). Fades
  often show only in `faint_px`, or make `changed_px` alternate between
  full and near-zero rows, so read `faint_px` for them. A fade slower
  than the threshold per frame produces no rows; re-run with a lower
  `--threshold`.
- **A near-zero row in the middle of motion** is a hold. In clips that
  index.md marks as variable frame rate, normalization duplicates frames
  to fill timestamp gaps, so a hold may come from the recorder. Confirm
  on the sheets before calling it jank.

## Easing

| Term | Definition | In scrub output |
| --- | --- | --- |
| Ease-out | Starts fast, ends slow. The default for most UI and anything responding to the user. | Displacement is largest in the first rows and shrinks to the end. |
| Ease-in | Starts slow, ends fast. Usually avoided; can feel sluggish. | Displacement grows row by row, then motion stops abruptly. |
| Ease-in-out | Slow, fast, slow. Good for elements already on screen moving from A to B. | Displacement ramps up, peaks mid-window, ramps down. |
| Linear | Constant speed. Avoid for UI; reserve for spinners or marquees. | Displacement is the same every row. |
| Asymmetric easing | A curve that accelerates and decelerates at different rates. Feels more alive than a symmetric one. | Displacement peak sits clearly off-center in the window. |
| Cubic-bezier | A custom easing curve you define for precise control. | Name it only when the user has the curve; otherwise describe the shape. |

## Springs

| Term | Definition | In scrub output |
| --- | --- | --- |
| Spring | Motion driven by physics (tension, mass, damping) rather than a set duration. | No crisp end: a tail of shrinking corrections after the main move. |
| Bounce | A spring that overshoots and settles, adding playfulness. | `cx`/`cy` (or `w×h`) passes the final value, reverses, and settles. |
| Damping | How quickly a spring settles. Lower damping means more bounce and oscillation. | Count the reversals and how fast their amplitude decays. One small overshoot means high damping; none means critically damped. |
| Stiffness / Tension | How strongly the spring pulls toward its target. Higher feels snappier. | Few frames from start to first reaching the target. |
| Mass | How heavy the animated element feels. More mass makes it slower and more sluggish. | Slow initial rise and long, low-frequency oscillation. |
| Perceptual duration | How long a spring feels finished, even though it keeps micro-settling underneath. | Report both: the frame where motion looks done on the sheets, and the last active row. |
| Momentum | Motion that carries velocity, especially after a drag or interruption. | After release, displacement continues and decays without a pointer driving it. |
| Velocity | How fast and in which direction an element is moving. A spring carries it into the next animation when interrupted, so a flicked element keeps its speed. | Displacement per row, with sign for direction. |
| Interruptible animation | An animation that can be smoothly redirected mid-flight instead of finishing first. | On a retrigger, motion reverses from its current position. A one-frame jump back to the start means it restarted instead. |

## Sequencing and timing

| Term | Definition | In scrub output |
| --- | --- | --- |
| Duration | How long an animation takes. | First to last active frame of one motion, in ms. |
| Delay | Time before an animation starts. | Frames between the visible trigger (click, press, hover) and the first active row. |
| Stagger | Animate several items one after another with a small delay between each, creating a cascade. | `changed_px` shows repeated humps at a regular offset and the bbox hops between items. The offset is the stagger delay. |
| Orchestration | Deliberately timing multiple animations so they feel like one coordinated motion. | Overlapping humps from different regions that start and settle together. |
| Interpolation / Tween | Generating all the in-between frames between a start and end value, so motion is continuous. | Its absence is a snap: the whole change lands in a single row. |
| Stepped animation | An animation that is divided into discrete steps, like a countdown timer. | Isolated active rows separated by holds at a regular interval. Regularity separates it from jank. |
| Fill mode | Whether an element keeps its first or last frame's styles before the animation starts or after it ends (e.g. forwards). | A large single-row change right after motion ends means the element jumped back to its start state. |

## Entrances and exits

| Term | Definition | In scrub output |
| --- | --- | --- |
| Fade in / Fade out | Element appears or disappears by changing opacity. | Bbox stays at the element's full box and center; only `faint_px` (and `changed_px`) rises and falls. |
| Slide in | Element enters by sliding in from off-screen (left, right, top, or bottom). | Bbox starts at a frame edge and the center moves inward. |
| Scale in | Element grows from smaller to full size as it appears, often paired with a fade. | Center fixed, `w×h` grows. |
| Pop in | Element appears with a slight overshoot, like it bounces into place. | Scale in where `w×h` passes the final size, then shrinks back. |
| Reveal | Content is uncovered gradually, often by animating a clip-path or mask. | A narrow band sweeps across the element while the content itself stays still on the sheets. |

## Movement and transforms

| Term | Definition | In scrub output |
| --- | --- | --- |
| Translate | Move an element along the X or Y axis. | Center moves; size stays at element size plus displacement. |
| Scale | Make an element bigger or smaller. | Center fixed, `w×h` changes. |
| Rotate | Spin an element around a point. | Center fixed; `w×h` oscillates for non-square elements. Read the angle on the sheets. |
| Skew | Slant an element along the X or Y axis, shearing it out of its rectangular shape. | Width or height changes with slanted edges visible on the sheets. |
| 3D tilt / Flip | Rotate in 3D space (rotateX / rotateY) to add depth. | Width (rotateY) or height (rotateX) collapses toward a line and grows back; sheets show foreshortening. |
| Transform origin | The anchor point a scale or rotation grows or spins from. | During a scale, the bbox edge or corner that stays fixed is the origin. |
| Origin-aware animation | An element animates out of its trigger, like a popover growing from the button that opened it instead of from its own center which is the default in CSS. | The fixed bbox edge sits next to the trigger on the sheets. A centered scale on a popover is a mismatch. |

## Transitions between states

| Term | Definition | In scrub output |
| --- | --- | --- |
| Crossfade | One element fades out as another fades in, in the same spot. | Fixed bbox; mid-transition sheets show both states overlapping. |
| Morph | One shape smoothly turns into another shape, e.g. Dynamic Island. | The outline changes continuously on the sheets; bbox size and aspect drift together. |
| Shared element transition | An element travels and transforms from one position into another, like a thumbnail expanding into a card. | Bbox moves and resizes in the same rows, from one layout region to another. |
| Layout animation | When an element's size or position changes, it animates to the new spot instead of snapping. | Neighbors move too: diffs show content beside or below the element shifting. |
| Accordion / Collapse | A section smoothly expands and collapses its height to show or hide content. | Bbox height grows with the top edge fixed, and content below shifts down. |
| Continuity transition | A change that keeps the user oriented by visually connecting before and after. For example, making the same rectangle bigger and smaller. | The same element persists across every sheet cell; nothing vanishes and reappears. |
| Direction-aware transition | Content slides one way going forward and the opposite way going back, so navigation has a sense of direction. | Displacement sign flips between the forward and back segments. |
| Page transition | An animation that plays when navigating from one page or route to another. | Near full-frame bbox; index.md usually reports no crop. |

## Scroll

| Term | Definition | In scrub output |
| --- | --- | --- |
| Scroll reveal | Elements fade or slide into place as they enter the viewport. | Whole-page vertical shift plus an element fading or sliding as it enters. |
| Scroll-driven animation | An animation whose progress is tied directly to scroll position. | The element changes only on rows where the page scrolls and freezes when scrolling stops. |
| Parallax | Background and foreground move at different speeds while scrolling, creating depth. | Diff sheets show layers shifting by different amounts per frame; the union bbox hides this. |

## Feedback and interaction

| Term | Definition | In scrub output |
| --- | --- | --- |
| Press / Tap feedback | A subtle scale-down when an element is clicked, so it feels physical. | Small bbox on the control; `w×h` shrinks a few percent and returns. |
| Hover effect | Visual change when the cursor moves over an element. | Change starts on the frame the cursor enters the element. |
| Hold to confirm | A progress effect that fills up while the user holds a button. | A fill advances at a steady rate while held, then completes or snaps back. |
| Swipe to dismiss | Dragging an element off-screen to close it, like a drawer or toast. | Element leaves the frame and keeps moving after release. |
| Rubber-banding | Resistance and snap-back when you drag past a boundary (the iOS overscroll feel). | Displacement shrinks as the drag continues past the edge, then springs back on release. |
| Shake / Wiggle | A quick side-to-side jitter signaling an error or rejected input. | `cx` reverses every few frames with small amplitude and ends where it started. |
| Ripple | A circle expanding from the point of a tap, confirming the press. | Bbox grows outward from the tap point, which stays at its center. |

## Looping and ambient motion

| Term | Definition | In scrub output |
| --- | --- | --- |
| Loop | An animation that repeats, a set number of times or infinitely. | `changed_px` is periodic; report the period in ms. |
| Alternate (yoyo) | A loop that plays forward then reverses each iteration, instead of jumping back to the start. | Displacement reverses smoothly at each end. A one-row jump to the start means a plain loop. |
| Marquee | Text or content that scrolls continuously in a loop. | Constant displacement that never stops. |
| Pulse | A gentle repeating scale or opacity change to draw attention. | Center fixed; `w×h` or `changed_px` rises and falls periodically. |
| Float | A gentle, continuous up-and-down drift that makes a static element feel alive and weightless. | Slow, small periodic `cy`. |
| Orbit | An element circling around another in a continuous path. | `cx` and `cy` are both periodic, a quarter period apart. |

## Polish and effects

| Term | Definition | In scrub output |
| --- | --- | --- |
| Blur | A blur filter used to soften an element or mask tiny imperfections. | Diffs show soft, low-contrast change with no crisp edges. |
| Clip-path | Clipping an element to a shape, used for reveals, masks, and before/after sliders. | The reveal band has a hard edge. |
| Mask | Hiding or revealing parts of an element using a shape or gradient — like clip-path, but with soft, fadeable edges. | The reveal band has a soft gradient edge. |
| Line drawing | An SVG path that draws itself in, like an invisible pen tracing it. | A small bbox travels along a path; each diff shows a short stroke segment. |
| Skeleton / Shimmer | A placeholder with a moving sheen shown while content loads. | A band sweeps across placeholder shapes, repeating. |
| Number ticker | Digits rolling or counting up to a value. | Change stays inside the digit area, rolling vertically or stepping. |
| Tabular numbers | Fixed-width digits so numbers don't shift around as they change. Essential for tickers, timers, and counters. | If the diff spans the whole line when only digits change, the numbers are not tabular. |
| Text morph | Text that animates character by character when it changes, drawing attention to the new value. | Change moves through individual characters in sequence. |
| Typewriter | Text appearing one character at a time, as if being typed. | Bbox extends by about one character per step, with holds between steps. |

## Performance

| Term | Definition | In scrub output |
| --- | --- | --- |
| Frame rate (FPS) | Frames drawn per second. 60fps is the baseline for smooth motion; 120fps on newer displays. | The source rate in index.md caps what the clip can show: a 30 fps recording cannot prove 60 fps smoothness. |
| Dropped frame | A frame the browser missed its deadline to draw, causing a tiny hitch in motion. | A near-zero row mid-motion followed by a row with about double displacement. |
| Jank | Visible stutter when the browser drops frames because it can't keep up with the animation. | Irregular displacement or repeated holds inside the active window. |

## Principles

| Term | Definition | In scrub output |
| --- | --- | --- |
| Anticipation | A small wind-up in the opposite direction before a move, hinting at what's about to happen. | A few rows of small displacement opposite to the main move, just before it. |
| Follow-through | Parts of an element keep moving and settle slightly after the main motion stops, adding weight. | Small changes near the element's edges or children after its center stops. |
| Squash & stretch | Deforming an element as it moves to convey weight, speed, and flexibility. | The `w`/`h` ratio changes during the move, most on the fastest rows or at impact. |
| Spatial consistency | Animating so an element keeps its identity and position across states, so users never lose track of where things went. | A violation looks like an element vanishing in one place and appearing elsewhere. |

---

Terms and definitions are quoted from the
[animation-vocabulary](https://github.com/emilkowalski/skills/tree/main/skills/animation-vocabulary)
skill by Emil Kowalski (MIT, snapshot of commit `85e8e23`). The "In
scrub output" column is specific to this skill.

Copyright (c) 2026 Emil Kowalski. Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished
to do so, subject to the following conditions: The above copyright
notice and this permission notice shall be included in all copies or
substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
