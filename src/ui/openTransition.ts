/**
 * The geometry that lets the reader grow out of the card the user tapped.
 *
 * ## Why this exists as its own module
 *
 * Opening a file used to be a hard conditional swap in `App.tsx` — the board was
 * replaced by a full-screen reader in a single frame. It is the most repeated
 * transition in the app and it was the only one with no motion at all, which was
 * conspicuous because everything either side of it is animated: the card presses
 * with a spring, and `LoadingCover` paints a ThumbHash and fades out. Between
 * them was a cut.
 *
 * The missing piece was never the animation — it was the *number*. A card knows
 * where it is on screen; the reader does not, and by the time the reader mounts
 * the card is gone. So the rect has to be captured at the moment of the tap and
 * carried across the swap. That is all this module does.
 *
 * ## Why a rect and not a ref
 *
 * A shared-element library would keep both views alive and interpolate between
 * them. That needs the two to coexist, which here they cannot: `App.tsx` swaps
 * one screen for the other, and `ReaderScreen` is deliberately keyed on the file
 * id so it remounts. Passing four numbers sidesteps all of it — the reader
 * simply starts at the card's frame and springs to its own.
 *
 * The cost is that the rect is a *snapshot*. If the row scrolls while the reader
 * is open, closing would animate back to where the card no longer is. That is
 * what `rectIsUsable` below is for.
 *
 * ## Why there is nothing from `react-native` in here
 *
 * This module is pure arithmetic and is covered by `openTransition.test.ts`,
 * which runs on Node's own test runner. Importing anything from `react-native`
 * — even a hook as innocuous as `useWindowDimensions` — makes the whole file
 * unloadable there: RN's entry point is Flow-typed (`import typeof * as …`), so
 * Node fails to parse it before any test runs. The screen dimensions are passed
 * in as plain numbers for exactly that reason, and the ref that holds the rect
 * lives at the call site in `App.tsx`.
 *
 * This is the same constraint `pagination.ts` works under, and for the same
 * payoff: the part with arithmetic in it is the part that can be tested without
 * a device.
 */

/** A card's position on screen, in window coordinates. */
export interface OpenRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the reader should start from, expressed as transform values.
 *
 * Returned as scale-and-translate rather than as a frame because that is what
 * an animated style can drive on the UI thread. Animating `width`/`height`/`top`
 * would be a layout write per frame — the one thing this app's motion work has
 * consistently refused to do.
 *
 * `scale` is derived from width alone, not from width and height separately. A
 * card is 3:4 and the screen is not, so honouring both would squash the reader
 * during the flight. Matching width and letting height follow reads as the card
 * *becoming* the page, which is the intent.
 */
export interface OpenFrom {
  translateX: number
  translateY: number
  scale: number
}

/**
 * Converts a captured card rect into the transform the reader starts at.
 *
 * The translation is between *centres*, because a scale transform in RN scales
 * about the view's centre. Computing it from the corners instead is the classic
 * way to get a shared-element transition that is subtly off by half the size
 * difference — it looks like the animation is aiming at the wrong card.
 */
export function openFromRect(
  rect: OpenRect,
  screenWidth: number,
  screenHeight: number,
): OpenFrom {
  const scale = rect.width / screenWidth

  const cardCentreX = rect.x + rect.width / 2
  const cardCentreY = rect.y + rect.height / 2
  const screenCentreX = screenWidth / 2
  const screenCentreY = screenHeight / 2

  return {
    translateX: cardCentreX - screenCentreX,
    translateY: cardCentreY - screenCentreY,
    scale,
  }
}

/**
 * Whether a captured rect is still worth animating back to.
 *
 * A rect is captured on tap and used again on close, and between those two the
 * board can have moved underneath it: the row scrolled, a sibling was deleted,
 * the phone rotated. Animating back to a stale rect is worse than not animating
 * — the reader would fold into a card that is not there, which reads as a bug
 * rather than as a flourish.
 *
 * The test is deliberately cheap and generous. It is not trying to prove the
 * card is exactly where it was; it is only ruling out the cases where the answer
 * is obviously no. Anything still roughly on screen gets the animation.
 */
export function rectIsUsable(
  rect: OpenRect | null,
  screenWidth: number,
  screenHeight: number,
): rect is OpenRect {
  if (!rect) return false
  if (rect.width <= 0 || rect.height <= 0) return false

  // Fully off either edge: the row scrolled far enough that this card is gone.
  if (rect.x + rect.width <= 0 || rect.x >= screenWidth) return false
  if (rect.y + rect.height <= 0 || rect.y >= screenHeight) return false

  // Wider than the screen means the measurement came from a different
  // orientation, so the numbers describe a layout that no longer exists.
  if (rect.width > screenWidth) return false

  return true
}

/**
 * The transform a reader with no usable rect should start from.
 *
 * Opening from the "+ New group" footer, from a search result whose card is not
 * on the board, or from a card that has since scrolled away all land here. A
 * scale-and-fade from slightly small is the honest answer: it says a screen
 * arrived without claiming it came from somewhere in particular.
 */
export const OPEN_FROM_NOWHERE: OpenFrom = {
  translateX: 0,
  translateY: 0,
  scale: 0.92,
}
