import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The three constraints P18 was built under.
 *
 * Each is a rule this project has already paid for once, and each is invisible
 * in review: the code looks correct in place, and the failure only shows on a
 * device — or, for the reduced-motion one, only on a device belonging to
 * someone who has switched the setting on and is therefore least likely to be
 * the person testing.
 *
 * Source-text assertions rather than behavioural ones, for the same reason
 * `lifecycle.test.ts` uses them: the alternative is a device.
 */

function source(relative: string): string {
  return readFileSync(join(import.meta.dirname, '..', relative), 'utf8')
}

test('every entering delay is guarded against reduced motion', () => {
  /*
   * `<ReducedMotionConfig>` disables animations, but a **delay is not an
   * animation** — nothing removes it for you. Left unguarded, "Remove
   * animations" turns a stagger into dead time before things simply appear,
   * which is strictly worse than no stagger at all.
   *
   * `motion.ts` documents this trap; this asserts it.
   */
  /*
   * The assertion is on the *guard around each delay*, not on the file merely
   * importing `useReducedMotion` somewhere.
   *
   * The first version of this test checked the import. Mutation testing showed
   * it was worthless: renaming the hook throughout `EmptyBoard` left the test
   * green, because the file still contained the substring in its own comments.
   * A test that a stagger is guarded has to look at the stagger.
   *
   * Both accepted shapes put the reduced-motion check on the same expression as
   * the delay, which is the only way the two cannot drift apart:
   *
   *   .delay(reduced ? 0 : ...)          — the delay collapses to zero
   *   entering={reduced ? undefined : X}  — the animation is never built
   */
  for (const file of ['components/DraggableCard.tsx', 'components/EmptyBoard.tsx']) {
    const text = source(file)
    if (!text.includes('.delay(')) continue

    const collapsesDelay = /\.delay\(\s*reduced\s*\?/.test(text)
    const skipsEntering = /entering=\{\s*reduced\s*\?\s*undefined\s*:/.test(text)

    assert.ok(
      collapsesDelay || skipsEntering,
      `${file} staggers with .delay() but the delay is not gated on reduced motion — a delay is not an animation, so nothing disables it, and "Remove animations" would turn the stagger into dead time`,
    )

    // And the flag has to come from the hook rather than from a local of the
    // same name, or the check above could be satisfied by anything truthy.
    assert.ok(
      /const\s+reduced\s*=\s*useReducedMotion\(\)/.test(text),
      `${file} uses a 'reduced' flag that does not come from useReducedMotion()`,
    )
  }
})

test('the pager gained no new gesture', () => {
  /*
   * The arbitration in `HorizontalPager` is scar tissue: a `Pressable` once
   * swallowed every touch and made a PDF unscrollable, and a zoom check in
   * `onUpdate` made a zoomed page unpannable. P18 added a page-settle
   * animation, and the constraint was that it must be derived from the
   * existing `translateX` rather than driven by anything new.
   */
  const pager = source('components/HorizontalPager.tsx')

  const gestures = pager.match(/Gesture\.\w+\(/g) ?? []
  // Pan, Tap, and the Simultaneous that composes them. Nothing else.
  assert.deepEqual(
    gestures.sort(),
    ['Gesture.Pan(', 'Gesture.Simultaneous(', 'Gesture.Tap('].sort(),
    'a new gesture in the pager re-opens the arbitration that DETAIL.md 6.4 and 6.5 record',
  )

  // The thresholds that resolve ambiguity toward scrolling.
  assert.ok(pager.includes('activeOffsetX([-24, 24])'), 'horizontal threshold changed')
  assert.ok(pager.includes('failOffsetY([-8, 8])'), 'vertical threshold changed')
  assert.ok(pager.includes('.maxPointers(1)'), 'pinch would be claimed by the pager')
})

test('group isolation survived the page-settle change', () => {
  // Arithmetic, not a rule: there must be no path that pages out of a group.
  const pager = source('components/HorizontalPager.tsx')

  assert.ok(
    pager.includes('Math.max(0, Math.min(count - 1, next))'),
    'the clamp that makes group isolation arithmetic is gone',
  )
})

test('the reader transition animates transforms, never layout', () => {
  /*
   * This is the one animation covering the full viewport, so a layout write per
   * frame here is the most expensive mistake available. Transforms and opacity
   * stay on the UI thread; `width`, `height`, `top` and `left` do not.
   */
  const transition = source('components/ReaderTransition.tsx')

  const animatedBlock = transition.slice(
    transition.indexOf('useAnimatedStyle'),
    transition.indexOf('return ('),
  )

  for (const layoutProp of ['width:', 'height:', 'top:', 'left:', 'marginTop:']) {
    assert.ok(
      !animatedBlock.includes(layoutProp),
      `ReaderTransition animates ${layoutProp} — a layout write per frame on the largest view in the app`,
    )
  }

  assert.ok(animatedBlock.includes('transform:'), 'the transition should drive transforms')
})

test('the reader transition paints its own opaque backdrop', () => {
  /*
   * The reader animates in from card size, so for the length of the transition
   * it does not cover the screen — and the board is unmounted by then. Whatever
   * is left uncovered is the Android *window* background, which `app.json` sets
   * to the splash navy (`#0e1a3b`), so the transition flashed blue at both ends.
   *
   * This was a real regression introduced with the transition itself, and it is
   * invisible in code review: the component looked correct, and the comment in
   * `App.tsx` justifying the unmount even asserted the reader "is opaque and
   * fills the screen" — true of the hard swap it replaced, false the moment the
   * reader started at card size.
   */
  const transition = source('components/ReaderTransition.tsx')

  assert.ok(
    /backgroundColor: backdrop/.test(transition),
    'ReaderTransition must paint an opaque backdrop, or the window background shows through and the transition flashes navy',
  )

  const app = readFileSync(join(import.meta.dirname, '..', '..', 'App.tsx'), 'utf8')
  assert.ok(
    /backdrop=\{theme\.bg\}/.test(app),
    'the backdrop must be the app background — a hard-coded colour would be wrong in one of the two themes',
  )
})

test('the reader is not unmounted before its close animation finishes', () => {
  /*
   * A closing animation needs the thing it animates to still exist. `App.tsx`
   * therefore asks the reader to close and unmounts it only when the animation
   * reports back — the same mount-decoupling `SheetShell` uses, and the bug it
   * exists to prevent is the reader vanishing instantly on close while the
   * open was animated.
   */
  const app = readFileSync(join(import.meta.dirname, '..', '..', 'App.tsx'), 'utf8')

  assert.ok(app.includes('setClosing(true)'), 'close must start an animation, not unmount')
  assert.ok(
    app.includes('onClosed={handleClosed}'),
    'the unmount must be driven by the transition reporting completion',
  )
})

test('chrome auto-hide stands down for every mid-task state', () => {
  /*
   * Hiding the chrome while the user is doing something with it is worse than
   * never hiding it. Each of these guards rules out a case where the timer
   * would fire under a finger or over a control the user is using.
   */
  const reader = source('screens/ReaderScreen.tsx')

  /*
   * The single `if` that guards the timer, extracted exactly.
   *
   * An earlier version of this test sliced a window of characters around
   * `CHROME_IDLE_MS` and asserted each term appeared *somewhere* in it. That
   * passed with the `seeking` guard deleted — the word occurs elsewhere in the
   * component, so the window found it anyway. Mutation testing is what showed
   * it: removing the guard left the test green, which means it was asserting
   * nothing.
   *
   * Matching the early-return line itself is what makes each term load-bearing.
   */
  const guard = reader.match(/if \(!chromeVisible[^\n]*\) return/)?.[0]
  assert.ok(guard, 'the auto-hide early-return could not be found — has it been rewritten?')

  for (const condition of ["sheet !== 'none'", 'searchOpen', 'seeking', '!documentLive']) {
    assert.ok(
      guard.includes(condition),
      `the auto-hide timer must stand down for ${condition} — otherwise it fires mid-task`,
    )
  }
})
