import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'

import { usePageNav } from '../store/pageNav'
import { Ease, Spring, Timing } from '../ui/motion'

/**
 * A draggable scroll position control: a thin track down the right edge with a
 * thumb showing position, and a page badge beside it.
 *
 * Dragging the thumb seeks **live**, the way Drive does, rather than only
 * committing on release. Both renderer families honour it through the existing
 * `pageNav` jump channel — PDF via its `page` prop, the WebView via a `seek`
 * message.
 *
 * The touch target is far wider than the visible track so the thumb is
 * catchable, while the drawn control stays unobtrusive.
 */

/** How long the control stays fully visible after movement stops. */
const IDLE_HIDE_MS = 1400

/**
 * Opacity the track keeps once idle, rather than fading to nothing.
 *
 * Fading fully out made the control effectively non-interactive: there was
 * nothing on screen to aim at, so reaching the seek bar meant scrolling first
 * just to summon it. A faint resting track is the standing invitation — it says
 * "you can drag here" without competing with the page.
 *
 * The thumb and badge still fade out completely; only the track persists.
 */
const IDLE_TRACK_OPACITY = 0.28
/** Live-seek throttle while dragging. */
const SEEK_THROTTLE_MS = 60
/** Vertical padding inside the track, so the ends are reachable. */
const TRACK_PAD = 4

interface Props {
  fileId: string
  topInset: number
  bottomInset: number
  /** Raised while a seek drag is in flight, so the pager can stand down. */
  onSeekingChange?: (seeking: boolean) => void
}

export function ScrollPageIndicator({
  fileId,
  topInset,
  bottomInset,
  onSeekingChange,
}: Props) {
  const pos = usePageNav((s) => s.byFile[fileId])
  const requestJump = usePageNav((s) => s.requestJump)

  const visible = useSharedValue(0)
  const progress = useSharedValue(0)
  const active = useSharedValue(0)

  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * True while a seek is outstanding, readable from `show` without being a
   * dependency of it — `show` is called from effects that must not re-run when
   * it changes identity. Declared here, with the other refs, because it is
   * assigned during render further down and a later declaration would be a
   * temporal dead zone reference.
   */
  const pendingRef = useRef(false)
  const lastSeekAt = useRef(0)

  /**
   * Track height, as a shared value rather than a ref.
   *
   * The pan callbacks below are worklets running on the UI thread. A ref read
   * from a worklet is captured and frozen at the time the worklet is created —
   * Reanimated warns "[Worklets] Tried to modify key `current` of an object
   * which has been already passed to a worklet" — so writing `.current` from
   * `onLayout` would never reach the gesture, and a seek would map against a
   * stale height after a rotation or a chrome-driven relayout.
   */
  const trackHeight = useSharedValue(1)

  const [dragging, setDragging] = useState(false)
  const [dragPage, setDragPage] = useState(0)

  /**
   * The page a seek asked for, held until the document actually arrives there.
   *
   * ## The bug this fixes
   *
   * Releasing the thumb used to send it straight back to where the drag
   * started, wait, and only then jump to the requested page. The cause is a
   * race, not an animation: `dragging` goes false the instant the finger lifts,
   * which re-enables the follow effect below — but `current` still holds the
   * *old* page, because a PDF takes hundreds of milliseconds to render the new
   * one and only reports through `onPageChanged` once it has. So the effect
   * dutifully springs the thumb back to the page being left, and the badge with
   * it, until the document finally reports and it jumps again.
   *
   * ## Why a pending value rather than a longer `dragging`
   *
   * This is the optimistic-UI pattern: show the requested state immediately,
   * keep it until it is confirmed, and reconcile when the truth arrives. Simply
   * holding `dragging` true for longer would freeze the control for a fixed
   * guess at the load time — too short and the snap-back returns, too long and
   * a fast document feels stuck. Confirmation is the honest signal, so this
   * clears on arrival rather than on a timer.
   *
   * Null means "nothing outstanding — follow the document", which is the
   * ordinary case.
   */
  const [pendingPage, setPendingPage] = useState<number | null>(null)
  // Mirrored during render so `show` can read it without taking it as a
  // dependency, which would re-create the callback and re-run the effects that
  // depend on it.
  pendingRef.current = pendingPage !== null

  const current = pos?.current ?? 0
  const total = pos?.total ?? 0


  // Keep the latest total on a ref: the gesture callbacks are created once but
  // must seek against the current document, not the one present at mount.
  const totalRef = useRef(total)
  totalRef.current = total

  const show = useCallback(() => {
    visible.value = withTiming(1, Timing.tint)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    // A seek in flight keeps the control up: the badge is the only feedback
    // that the requested page is on its way, so hiding it mid-load would look
    // like the seek was simply ignored.
    if (pendingRef.current) return
    hideTimer.current = setTimeout(() => {
      // Slower than it appeared, and accelerating away: a control that is
      // leaving of its own accord should not snatch attention on the way out.
      visible.value = withTiming(0, { duration: 320, easing: Ease.exit })
    }, IDLE_HIDE_MS)
  }, [visible])

  /*
   * Clear the pending seek once the document reports it has arrived.
   *
   * Tolerant by a page, deliberately. A PDF reports the page its viewport
   * settles on, which after a seek to page 443 can legitimately be 442 or 444
   * depending on where the page boundary falls — demanding an exact match would
   * leave the request outstanding forever and freeze the control.
   *
   * Also cleared when the user scrolls somewhere else entirely: a report far
   * from the request means they took over by hand, and their position wins over
   * a request they have already abandoned.
   */
  useEffect(() => {
    if (pendingPage === null) return
    if (!current) return
    if (Math.abs(current - pendingPage) <= 1) setPendingPage(null)
  }, [current, pendingPage])

  /*
   * A pending seek cannot outlive the file it was made against.
   *
   * Swiping to another document while one is loading would otherwise leave the
   * new file's control displaying the old file's requested page.
   */
  useEffect(() => {
    setPendingPage(null)
  }, [fileId])

  /*
   * Give up on a request the document never confirms.
   *
   * A seek into a corrupt region, or a renderer that reports nothing at all,
   * would otherwise pin the control to a page it never reaches. Falling back to
   * reality after a few seconds is strictly better than a control that has
   * quietly stopped tracking the document.
   */
  useEffect(() => {
    if (pendingPage === null) return
    const t = setTimeout(() => setPendingPage(null), 6000)
    return () => clearTimeout(t)
  }, [pendingPage])

  /*
   * Follow the document while the user scrolls it themselves.
   *
   * Suppressed while a seek is outstanding as well as while dragging — those
   * are the two states where the document's reported position is *behind* what
   * the user has asked for, and following it would drag the thumb backwards.
   * That was the snap-back: `dragging` alone covers only the half of the wait
   * during which the finger is still down.
   */
  useEffect(() => {
    if (total < 2 || dragging || pendingPage !== null) return
    // A spring, not a curve: the thumb is *following* the document rather than
    // answering the user, so it should feel weighted.
    progress.value = withSpring(total > 1 ? (current - 1) / (total - 1) : 0, Spring.gentle)
    show()
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [current, total, dragging, pendingPage, progress, show])

  const beginDrag = useCallback(() => {
    setDragging(true)
    onSeekingChange?.(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    visible.value = withTiming(1, Timing.tint)
    active.value = withTiming(1, Timing.tint)
  }, [onSeekingChange, visible, active])

  const endDrag = useCallback(() => {
    const page = dragPageRef.current

    /*
     * Commit the final page, unthrottled.
     *
     * The throttle above can swallow the last frames of a drag, so without this
     * a quick flick lands on wherever the throttle last let through rather than
     * where the finger actually stopped — off by a few pages, which on a long
     * document is off by a lot.
     *
     * Set as pending *before* `dragging` drops, so there is never a frame in
     * which both are clear and the follow effect can fire against the old
     * position. That ordering is the fix; the two flags are one handover.
     */
    if (page > 0) {
      setPendingPage(page)
      setDragPage(page)
      lastSeekAt.current = Date.now()
      requestJump(fileId, page)
    }

    setDragging(false)
    onSeekingChange?.(false)
    active.value = withTiming(0, Timing.exit)
    show()
  }, [onSeekingChange, active, show, fileId, requestJump])

  /**
   * The page under the finger right now, for the badge and for release.
   *
   * A ref as well as state: `endDrag` needs the final page synchronously, and
   * reading it from `dragPage` there would see whatever React had last
   * committed — which, with the badge update throttled below, can be a frame or
   * two behind the finger.
   */
  const dragPageRef = useRef(0)

  const seekTo = useCallback(
    (fraction: number, force: boolean) => {
      const t = totalRef.current
      if (t < 2) return

      const page = Math.min(t, Math.max(1, Math.round(fraction * (t - 1)) + 1))
      dragPageRef.current = page

      /*
       * The throttle now covers the badge as well as the jump.
       *
       * `setDragPage` sat *above* the early return, so it ran on every frame of
       * the drag — a React re-render of this component sixty times a second,
       * for a number that can only change as fast as the eye can read it. The
       * comment said "throttled so a fast drag cannot flood a PDF with
       * re-renders" while the component itself was doing exactly that.
       *
       * The thumb does not depend on this: it is driven by `progress`, a shared
       * value written on the UI thread, so it keeps following the finger at
       * full frame rate regardless of what React does.
       */
      const now = Date.now()
      if (!force && now - lastSeekAt.current < SEEK_THROTTLE_MS) return
      lastSeekAt.current = now

      setDragPage(page)
      requestJump(fileId, page)
    },
    [fileId, requestJump],
  )

  const pan = Gesture.Pan()
    // Wakes on vertical movement, which the pager already ignores — so the two
    // never contend. The pager is additionally locked via `onSeekingChange`.
    .activeOffsetY([-4, 4])
    .failOffsetX([-20, 20])
    .maxPointers(1)
    .onBegin((e) => {
      runOnJS(beginDrag)()
      const f = Math.min(1, Math.max(0, (e.y - TRACK_PAD) / trackHeight.value))
      progress.value = f
      runOnJS(seekTo)(f, true)
    })
    .onUpdate((e) => {
      const f = Math.min(1, Math.max(0, (e.y - TRACK_PAD) / trackHeight.value))
      progress.value = f
      runOnJS(seekTo)(f, false)
    })
    .onFinalize(() => {
      runOnJS(endDrag)()
    })

  // The track brightens as the thumb is grabbed, so the whole control reads as
  // engaged rather than only the part under the finger.
  // The track never fully disappears — see IDLE_TRACK_OPACITY.
  const fade = useAnimatedStyle(() => ({
    opacity: IDLE_TRACK_OPACITY + visible.value * (1 - IDLE_TRACK_OPACITY),
    width: 3 + active.value * 2,
  }))

  /*
   * The thumb grows on grab by animating width, not `scaleX`.
   *
   * Scaling a rounded rect stretches its caps into an ellipse — the same reason
   * the page dots animate real width. At 9pt wide with a 5pt radius the
   * distortion is obvious the moment it is touched, which is precisely when the
   * user is looking at it.
   */
  const thumb = useAnimatedStyle(() => {
    // Starts at a size that is visibly grabbable. The previous 5pt was chosen
    // to look tidy and made the control read as decoration rather than as a
    // handle — you cannot aim at a hairline.
    const w = 9 + active.value * 5
    return {
      top: `${progress.value * 100}%`,
      opacity: visible.value,
      width: w,
      borderRadius: w / 2,
    }
  })

  const badge = useAnimatedStyle(() => ({
    opacity: visible.value,
    top: `${progress.value * 100}%`,
  }))

  // Formats with no meaningful page count (spreadsheets report 0) show nothing.
  if (total < 2) return null

  return (
    <GestureDetector gesture={pan}>
      <View
        style={[styles.wrap, { top: topInset + 56, bottom: bottomInset + 56 }]}
        onLayout={(e) => {
          trackHeight.value = Math.max(1, e.nativeEvent.layout.height - TRACK_PAD * 2)
        }}
      >
        <Animated.View style={[styles.track, fade]} pointerEvents="none" />
        <Animated.View style={[styles.thumb, thumb]} pointerEvents="none" />

        {/*
          The badge lives outside the 44pt gesture column.
          
          As a child of it, the label had 24pt of usable width and "443 / 592"
          wrapped into three stacked fragments — the heavy black block that made
          this control look broken rather than merely plain. Absolutely
          positioned against the same parent but laid out right-to-left from the
          track, with `numberOfLines={1}` as a guarantee rather than a hope.
        */}
        <Animated.View style={[styles.badge, badge]} pointerEvents="none">
          <Text numberOfLines={1} style={styles.badgeText}>
            {/*
              While a seek is outstanding the badge shows where the reader is
              *going*, not the page being left — the label is dropped in that
              case because a publisher's page label belongs to the reported
              position and would contradict the number beside it.
            */}
            {dragging || pendingPage !== null
              ? (dragging ? dragPage : pendingPage)
              : (pos?.label ?? current)}
            <Text style={styles.badgeTotal}>{` / ${total}`}</Text>
          </Text>

          {/*
            The percentage is dropped while dragging.
            
            Mid-drag the page number is the thing being aimed at, and a second
            number changing at a different rate beside it competes for the eye.
            It returns on release, when it is context rather than noise.
          */}
          {!dragging && pendingPage === null && pos?.percent != null && (
            <>
              <View style={styles.badgeDivider} />
              <Text style={styles.badgePercent}>{pos.percent}%</Text>
            </>
          )}
        </Animated.View>
      </View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  // Wide enough to catch a thumb reliably; the drawn control stays thin.
  wrap: { position: 'absolute', right: 0, width: 44 },
  /* `width` is animated (it thickens on grab), so it is deliberately absent
     here — a static value would read as the source of truth and get "restored"
     by the next reader. */
  track: {
    position: 'absolute',
    right: 6,
    top: TRACK_PAD,
    bottom: TRACK_PAD,
    borderRadius: 2,
    backgroundColor: 'rgba(128,128,140,0.32)',
  },
  /*
   * Width and radius are animated, so they are set in the worklet rather than
   * here — only the properties that never change live in the stylesheet.
   *
   * The border is what keeps the thumb visible against a white page: a pure
   * white thumb on a white PDF is otherwise invisible exactly where a reader
   * most needs it.
   */
  thumb: {
    position: 'absolute',
    right: 5,
    height: 44,
    marginTop: -22,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.25)',
  },
  /*
   * Right-anchored to the track rather than parented inside it.
   *
   * `right: 18` places it just left of the thumb; because the parent is only
   * 44pt wide, the badge must be free to extend *past* its parent's left edge,
   * which absolute positioning without a width constraint allows. The previous
   * version relied on the parent for width and got 24pt.
   */
  badge: {
    position: 'absolute',
    right: 18,
    marginTop: -15,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(20,20,24,0.86)',
  },
  badgeText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    // Never wrap: a wrapped page counter is what made this look broken.
    includeFontPadding: false,
  },
  /* The total is context, not the value — dimmed so the eye lands on the page. */
  badgeTotal: {
    color: 'rgba(255,255,255,0.55)',
    fontWeight: '500',
  },
  /* A hairline rule instead of a second line: keeps the badge one row tall, so
     it never grows into the three-stacked-fragments shape again. */
  /*
   * An explicit height, not `alignSelf: 'stretch'`.
   *
   * Stretch resolves against the row's cross size, which here is driven by the
   * text and left the hairline with no height at all — so the divider and the
   * percentage beside it rendered as nothing. A fixed height is the only thing
   * that reliably draws in a text-sized row.
   */
  badgeDivider: {
    width: StyleSheet.hairlineWidth,
    height: 13,
    marginHorizontal: 8,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  badgePercent: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
})
