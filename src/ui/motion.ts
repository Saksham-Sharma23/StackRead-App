import { Easing, LinearTransition, ReduceMotion, useReducedMotion } from 'react-native-reanimated'

/**
 * The app's motion vocabulary.
 *
 * Every animation should reach for a token here rather than an inline number.
 * The point is not tidiness — it is that scattered magic durations drift apart
 * and end up disagreeing, which is what made this app's motion feel assembled
 * rather than designed.
 *
 * ## Why springs, not curves
 *
 * A spring is *interruptible*: retargeting mid-flight carries the existing
 * velocity into the new animation. A duration+easing animation always restarts
 * from zero velocity, which is the "rubbery restart" you feel when tapping
 * something twice quickly. That interruptibility is the main reason iOS motion
 * reads as fluid, so `withSpring` is the default here and `withTiming` is
 * reserved for things with no physical analogue (opacity, colour).
 *
 * ## Why these numbers
 *
 * Reanimated 4 accepts springs as `{ duration, dampingRatio }` — the same
 * parameterization SwiftUI uses for `.spring(duration:bounce:)`, where
 * `bounce = 1 - dampingRatio`. So these are expressed as intent rather than as
 * reverse-engineered stiffness/mass triples.
 *
 * Note `duration` is *perceptual*: Reanimated runs roughly 1.5x that long, with
 * the tail below the threshold of notice. So 350 here is not 350ms of visible
 * movement — it is 350ms of *felt* movement.
 */

/**
 * Spring configs, in Apple's units.
 *
 * The damping ratios are the load-bearing part:
 *
 *  - `1.0` is critically damped — no overshoot at all. Correct where an
 *    overshoot would be a visible bug rather than a flourish.
 *  - `0.85` overshoots by roughly 1-2% of travel. At the distances this app
 *    animates that is below conscious perception, but it registers as *alive*
 *    rather than computed. This is SwiftUI's `.snappy`, and it is the default.
 *  - Below ~0.7 the bounce becomes plainly visible, which reads as toy-like on
 *    a reading app. Used only where a bounce carries meaning.
 */
export const Spring = {
  /**
   * The default. Press feedback, sheets, chrome, dots.
   *
   * 350 rather than Apple's stock 500 because most motion here is small-travel
   * — a 3% scale, a 12pt slide. Perceived duration should scale with distance;
   * a short movement that takes as long as a long one reads as laggy, not calm.
   */
  snappy: { duration: 350, dampingRatio: 0.85 },

  /** Larger travel, or anywhere an overshoot would look like a bug. */
  smooth: { duration: 400, dampingRatio: 1 },

  /** Weighted settling — something following the user rather than answering them. */
  gentle: { duration: 500, dampingRatio: 1 },

  /**
   * One deliberate overshoot. Used *only* for the card lift on long-press,
   * where the bounce is informative: it signals "picked up".
   */
  playful: { duration: 400, dampingRatio: 0.7 },

  /**
   * Page-turn settle.
   *
   * Chosen to match what the pager already does rather than to change it. The
   * previous hand-tuned config worked out to a damping ratio of 0.96 settling
   * in ~220ms, which was already right — this preserves that feel while giving
   * it a name.
   */
  pager: { duration: 300, dampingRatio: 0.95 },

  /**
   * Screen-scale travel: the reader opening out of a card, and folding back.
   *
   * Slower than `smooth` because the distance is the whole screen, and
   * perceived duration should scale with distance — the same reasoning that
   * makes `snappy` short. Critically damped, because an overshoot at this size
   * is not a flourish, it is the reader visibly missing its own edges.
   *
   * This is the one animation in the app that covers the full viewport, so it
   * is also the one where a dropped frame is most obvious. Everything it drives
   * is a transform or an opacity — never a layout property — so it stays on the
   * UI thread throughout.
   */
  screen: { duration: 460, dampingRatio: 1 },
} as const

/**
 * Durations for the things a spring cannot express — opacity and colour.
 *
 * `fast` keeps the 180ms this app already used everywhere. That value was fine;
 * it was the *easing* that was wrong (see `Ease`).
 */
export const Duration = {
  /** Colour swaps and press tints — fast enough to read as instantaneous. */
  instant: 100,
  /** Small fades: chrome, toasts, indicators. */
  fast: 180,
  /** Backdrops, and anything covering real distance. */
  medium: 260,
  /** Screen-scale fades. */
  slow: 400,
} as const

/**
 * Asymmetric easing curves.
 *
 * The previous code used Reanimated's default (`inOut(quad)`) everywhere, which
 * is symmetric — it eases in *and* out of every animation, including ones that
 * only ever move one way. That is the single biggest reason the app felt
 * non-native: an element arriving should decelerate into place (fast start reads
 * as responsive), and an element leaving should accelerate away (slow start
 * gives a beat of "did I mean that?", fast finish gets it out of the way).
 *
 * There is deliberately no `inOut` token. It is what we removed, and not
 * offering it is what stops it coming back.
 */
export const Ease = {
  /**
   * Arriving. Roughly easeOutExpo.
   *
   * The `y2 = 1` control point means the element visually lands at about 40% of
   * the nominal duration and the remainder is imperceptible settle — so a 180ms
   * fade with this curve feels markedly faster than 180ms with `inOut(quad)`,
   * at the same actual duration.
   */
  enter: Easing.bezier(0.16, 1, 0.3, 1),
  /** Leaving. Standard ease-in: starts gently, accelerates out. */
  exit: Easing.bezier(0.4, 0, 1, 1),
  /** Moving between two visible positions, where neither end is an entrance. */
  standard: Easing.bezier(0.4, 0, 0.2, 1),
} as const

/**
 * Pre-composed `withTiming` configs.
 *
 * Call sites should read `withTiming(1, Timing.enter)` — with no numerals in
 * them at all. That is the actual goal of this module; tokens that still leave
 * magic numbers at the call site would not be worth the indirection.
 */
export const Timing = {
  enter: { duration: Duration.fast, easing: Ease.enter },
  exit: { duration: Duration.fast, easing: Ease.exit },
  standard: { duration: Duration.medium, easing: Ease.standard },
  /** For colour and tint, where anything slower reads as lag. */
  tint: { duration: Duration.instant, easing: Ease.standard },
  /** Backdrop and other larger-area fades. */
  backdrop: { duration: Duration.medium, easing: Ease.enter },
} as const

/** Transform amounts, shared so a press feels identical everywhere. */
export const Scale = {
  /** Pressed state. Matches the value the cards already used. */
  press: 0.97,
  /** A card lifted for dragging. */
  lift: 1.06,
} as const

/**
 * Whether the user has asked the system to reduce motion.
 *
 * This is Reanimated's own hook rather than an `AccessibilityInfo` wrapper, so
 * it stays in sync with the `<ReducedMotionConfig>` at the app root — which is
 * what actually disables animations. Most components need no reduced-motion
 * code at all because of that; reach for this hook only where the *structure*
 * changes rather than the animation, such as skipping a stagger delay (a delay
 * is not an animation, so nothing disables it for you).
 */
export { useReducedMotion, ReduceMotion }

/**
 * The standard "things moved, close the gap" transition.
 *
 * Reach for this whenever siblings shift because one of them left or was
 * reordered. Pairing an exit animation with this on the *siblings* is not
 * optional polish: without it the leaving item fades out while its neighbours
 * teleport into the gap, which looks worse than no animation at all.
 *
 * Built as a function because a layout-animation builder is stateful — sharing
 * one instance across components would let one component's modifiers leak into
 * another's.
 *
 * Note `.dampingRatio()` is the ratio (1 = critically damped); the separate
 * `.damping()` modifier is a raw coefficient and means something quite
 * different.
 */
export function layoutTransition() {
  return LinearTransition.springify(Spring.smooth.duration).dampingRatio(
    Spring.smooth.dampingRatio,
  )
}
