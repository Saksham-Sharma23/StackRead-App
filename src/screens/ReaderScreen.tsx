import { useCallback, useEffect, useMemo, useState } from 'react'
import { BackHandler, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'

import type { FileEntry } from '../types'
import { useGroupCounts, useGroupFiles, useGroupsSorted } from '../store/selectors'
import { flushLibrarySave } from '../storage/library'
import { formatBytes } from '../storage/formats'
import { prefetchAround, cancelPrefetch } from '../renderers/webview/prefetch'
import { fileSize } from '../storage/files'
import { HorizontalPager } from '../components/HorizontalPager'
import { PageDots } from '../components/PageDots'
import { ScrollPageIndicator } from '../components/ScrollPageIndicator'
import { ActionSheet, type SheetAction } from '../components/ActionSheet'
import { Dropdown } from '../components/Dropdown'
import { ToolButton } from '../components/ToolButton'
import { TocSheet } from '../components/TocSheet'
import { ReaderSettingsSheet } from '../components/ReaderSettingsSheet'
import { usePageNav } from '../store/pageNav'
import { useSearch } from '../store/search'
import { SearchBar } from '../components/SearchBar'
import { isAvailable as pdfSearchIsAvailable } from '../../modules/pdf-text/src'
import type { TocEntry } from '../renderers/webview/pagination'
import { useTheme } from '../ui/theme'
import { Spring } from '../ui/motion'
import { useFullscreen } from '../ui/useFullscreen'

/**
 * Full-screen reader.
 *
 * Vertical scroll reads the file; horizontal swipe moves through the group.
 * Chrome (top bar + dots) auto-hides so the document owns the screen, and comes
 * back on tap.
 */

interface Props {
  initialFile: FileEntry
  onClose: () => void
}

type Sheet = 'none' | 'file' | 'group' | 'toc' | 'display'

/** Shared empty list, so "no chapters" is always the same reference. */
const EMPTY_TOC: TocEntry[] = []

/**
 * How long the reader waits before hiding its own chrome.
 *
 * Long enough to read the file name and reach the chapters button without the
 * bar disappearing mid-reach; short enough that settling into the document
 * happens on its own rather than needing a second tap. Two and a half seconds
 * is roughly where Drive and Books sit, and the value is far more forgiving
 * than it looks: hiding is reversible with one tap, so being slightly too eager
 * costs a tap, while being too slow costs the immersive mode entirely.
 */
const CHROME_IDLE_MS = 2500

export function ReaderScreen({ initialFile, onClose }: Props) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const groups = useGroupsSorted()
  const [groupId, setGroupId] = useState(initialFile.groupId)
  const files = useGroupFiles(groupId)

  const [index, setIndex] = useState(() => {
    const i = files.findIndex((f) => f.id === initialFile.id)
    return i >= 0 ? i : 0
  })

  // Read once: whether the native module is in this binary cannot change while
  // the app is running.
  const pdfSearchAvailable = pdfSearchIsAvailable()

  const searchOpen = useSearch((s) => s.open)
  const setSearchOpen = useSearch((s) => s.setOpen)
  const closeSearch = useSearch((s) => s.close)

  const [sheet, setSheet] = useState<Sheet>('none')
  const [seeking, setSeeking] = useState(false)
  const [chromeVisible, setChromeVisible] = useState(true)
  const chrome = useSharedValue(1)

  /*
   * The pager's live swipe position, shared with the page dots.
   *
   * Owned here because both ends of it are siblings: the pager writes it, the
   * dots read it, and neither should have to know about the other. It stays a
   * shared value the whole way, so following the finger costs no re-renders —
   * `index` still changes only when a turn is committed.
   */
  const swipeProgress = useSharedValue(index)

  /**
   * Immersive mode is not a separate control — it *is* the hidden-chrome state.
   *
   * Tapping the page hides the reader's own bar and the system's, together, the
   * way Drive does it: one gesture, and the document has the whole screen. A
   * dedicated button would mean two ways to hide overlapping things and four
   * combined states to reason about, three of which nobody wants.
   *
   * Sheets are the exception. While one is open the system bars must come back,
   * or the sheet sits under the navigation bar where it cannot be dismissed.
   */
  const immersive = !chromeVisible && sheet === 'none'
  useFullscreen(immersive)

  // O(1) per group. This was a filter over every file in the library, run once
  // per group, every time the group menu was rebuilt.
  const groupCounts = useGroupCounts()

  /*
   * Warm the neighbouring files in this group while the current one is read.
   *
   * Deliberately not "mount the neighbours" — that crashed pdfium and hung on
   * multiple EPUBs, and is why the pager mounts one file. This only fills the
   * prepared-document cache, one file at a time and only after animations have
   * settled, so the next swipe is a synchronous cache hit instead of a reparse.
   *
   * Cancelled on unmount so leaving the reader does not leave a queue running
   * against a group the user is no longer in.
   */
  useEffect(() => {
    prefetchAround(files, index)
    /*
     * Keyed on the window, not on the array.
     *
     * `files` is a `useMemo` over `filesById`, so **any** file's metadata
     * changing — a thumbnail landing, a progress write — produced a new array
     * identity and rescheduled prefetching for reasons that have nothing to do
     * with which file is being read. The `InteractionManager` deferral and the
     * `busy` flag absorbed the damage, but the work was being re-queued
     * constantly ([AUDIT2 §3.3](../../AUDIT2.md), [AUDIT §2.3](../../AUDIT.md)).
     *
     * What prefetching actually depends on is which three files are in the
     * window, so that is what this watches.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files[index - 1]?.id, files[index]?.id, files[index + 1]?.id])

  useEffect(() => cancelPrefetch, [])


  const current = files[index]
  const currentGroupTitle = groups.find((g) => g.id === groupId)?.title ?? 'Group'

  // Must return a *stable* reference. `?? []` allocates a fresh array on every
  // call, so Zustand sees a new value each render and re-renders forever
  // (React's "Maximum update depth exceeded"). Fall back to a shared constant
  // and let `useMemo` own the empty case instead.
  const tocRaw = usePageNav((s) => (current ? s.toc[current.id] : undefined))
  const toc = useMemo(() => tocRaw ?? EMPTY_TOC, [tocRaw])
  const requestHref = usePageNav((s) => s.requestHref)

  /*
   * Whether the current document has real geometry yet.
   *
   * Selected as a boolean, not as the position object: this gates a timer, and
   * selecting the object would re-run the effect on every reported scroll
   * position — restarting the auto-hide countdown sixty times a second, which
   * would mean it never fired at all.
   */
  const documentLive = usePageNav((s) => (current ? s.byFile[current.id] !== undefined : false))

  // A group can shrink under us (a file removed elsewhere); never index past it.
  useEffect(() => {
    if (files.length === 0) {
      onClose()
    } else if (index > files.length - 1) {
      setIndex(files.length - 1)
    }
  }, [files.length, index, onClose])

  const toggleChrome = useCallback(() => {
    setChromeVisible((v) => !v)
  }, [])

  /*
   * Chrome hides itself once the reader has been left alone.
   *
   * The reader has always *had* an immersive mode; it did not enter one on its
   * own, so the document only owned the screen if the user asked twice — once
   * to open the file and once to get the chrome out of the way. Drive and Books
   * both settle into the document by themselves, and that is the difference
   * between a reader with an immersive mode and one that is immersive.
   *
   * Three conditions gate it, and each rules out a case where hiding would be
   * actively wrong:
   *
   *  - `chromeVisible` — nothing to hide otherwise, and re-running the timer on
   *    every tick would keep rescheduling itself.
   *  - `sheet === 'none' && !searchOpen` — a sheet or the search bar is the user
   *    mid-task. `immersive` already excludes sheets for the same reason.
   *  - `!seeking` — a scrollbar drag is a held finger that reports no taps, so
   *    without this a seek lasting longer than the timeout would hide the
   *    chrome out from under the thumb being dragged.
   *  - `documentLive` — hiding chrome over a loading cover removes the only way
   *    back from a document that has not appeared yet.
   *
   * The timer is cleared and restarted whenever any of those change, so any
   * interaction that flips one of them is also what postpones the hide.
   *
   * `documentLive` is taken from the page-nav store rather than from a renderer
   * flag: a position is reported only once a renderer has real geometry, and
   * every renderer family reports one. Reaching into the WebView's own
   * `rendered` state would work for one of the three and be wrong for PDFs and
   * images.
   */
  useEffect(() => {
    if (!chromeVisible || sheet !== 'none' || searchOpen || seeking || !documentLive) return

    const t = setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS)
    return () => clearTimeout(t)
  }, [chromeVisible, sheet, searchOpen, seeking, documentLive])

  // Drive the animation from an effect, never from inside a setState updater —
  // React may re-run an updater during render, and writing a shared value there
  // is a Reanimated violation.
  //
  // A spring rather than a timing because tapping to toggle chrome is the most
  // repeated gesture in the reader: a spring retargets mid-flight with the
  // existing velocity, so rapid taps stay fluid instead of restarting.
  useEffect(() => {
    chrome.value = withSpring(chromeVisible ? 1 : 0, Spring.snappy)
  }, [chromeVisible, chrome])

  /**
   * Android back priority: an open sheet consumes it first, then the reader
   * closes. Without this, dismissing a menu would also exit the reader — the
   * mobile shape of the desktop app's Escape-key bug.
   */
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sheet !== 'none') {
        setSheet('none')
        return true
      }
      // Search sits between a sheet and the reader: it is a mode within the
      // document, so back should leave the mode before leaving the document.
      if (searchOpen) {
        closeSearch(current?.id)
        return true
      }
      onClose()
      return true
    })
    return () => sub.remove()
  }, [sheet, searchOpen, closeSearch, current, onClose])

  // Desktop flushes the index on reader close and on group switch. Same here.
  useEffect(() => {
    return () => flushLibrarySave()
  }, [])

  const switchGroup = useCallback(
    (nextGroupId: string) => {
      flushLibrarySave()
      setGroupId(nextGroupId)
      setIndex(0)
    },
    [],
  )

  const fileActions = useMemo<SheetAction[]>(
    () =>
      files.map((f, i) => ({
        key: f.id,
        label: i === index ? `${f.name}  (current)` : f.name,
        // Falls back to reading the file for entries imported before `size` was
        // recorded, so an existing library shows sizes without a re-import.
        meta: formatBytes(f.size ?? fileSize(f)),
        disabled: i === index,
        onPress: () => setIndex(i),
      })),
    [files, index],
  )

  const groupActions = useMemo<SheetAction[]>(
    () =>
      groups.map((g) => {
        const count = groupCounts[g.id] ?? 0
        return {
          key: g.id,
          label:
            g.id === groupId
              ? `${g.title}  (current)`
              : count === 0
                ? `${g.title}  (empty)`
                : g.title,
          // Switching into an empty group would show nothing at all.
          disabled: g.id === groupId || count === 0,
          onPress: () => switchGroup(g.id),
        }
      }),
    [groups, groupId, groupCounts, switchGroup],
  )

  const chromeStyle = useAnimatedStyle(() => ({
    opacity: chrome.value,
    transform: [{ translateY: (1 - chrome.value) * -12 }],
  }))

  const dotsStyle = useAnimatedStyle(() => ({
    opacity: chrome.value,
    transform: [{ translateY: (1 - chrome.value) * 12 }],
  }))

  if (!current) return null

  return (
    <View style={[styles.root, { backgroundColor: theme.bg }]}>
      <View style={styles.tapLayer}>
        <HorizontalPager
          files={files}
          index={index}
          onIndexChange={setIndex}
          progress={swipeProgress}
          onTap={toggleChrome}
          seeking={seeking}
          fullscreen={immersive}
        />
      </View>

      {/* Top bar: close · file picker · group picker · page stepper */}
      <Animated.View
        pointerEvents={chromeVisible ? 'auto' : 'none'}
        style={[styles.topBar, { paddingTop: insets.top + 8 }, chromeStyle]}
      >
        <ToolButton
          glyph="‹"
          onPress={onClose}
          accessibilityLabel="Back to library"
          style={styles.backBtn}
          textStyle={styles.backGlyph}
        />

        {/* File and Group pickers, mirroring the desktop reader's top bar. */}
        <Dropdown
          label="File"
          value={current.name}
          onPress={() => setSheet('file')}
          flex={1.35}
        />

        <Dropdown
          label="Group"
          value={currentGroupTitle}
          onPress={() => setSheet('group')}
          flex={1}
        />

        {/* Chapters appears only for a document that declares one. */}
        {toc.length > 0 && (
          <ToolButton
            glyph="☰"
            onPress={() => setSheet('toc')}
            accessibilityLabel="Chapters"
            style={styles.toolBtn}
          />
        )}

        <ToolButton
          glyph="⌕"
          onPress={() => setSearchOpen(!searchOpen)}
          accessibilityLabel="Find in document"
          style={styles.toolBtn}
        />

        <ToolButton
          glyph="Aa"
          onPress={() => setSheet('display')}
          accessibilityLabel="Display settings"
          style={styles.toolBtn}
        />
      </Animated.View>

      {/*
        Only while the chrome is up: the bar is part of the chrome, and leaving
        it on screen in immersive mode would contradict the one rule the reader
        has — tap and the document owns the screen.

        PDF gets the bar with a reason rather than a dead input. The affordance
        being visible-but-explained is the coherent state; silently finding
        nothing in a document that contains the word is not.
      */}
      {chromeVisible && searchOpen && current && (
        <SearchBar
          fileId={current.id}
          theme={theme}
          topOffset={insets.top + 52}
          /*
           * PDF search now runs on the pdfium text engine already in the build,
           * so the only remaining unsupported case is a build whose native
           * module is older than this JS — normal during development, since JS
           * arrives over Fast Refresh and native code does not.
           */
          unsupportedReason={
            current.format === 'pdf' && !pdfSearchAvailable
              ? 'PDF search needs a rebuild of the dev client'
              : undefined
          }
        />
      )}

      <ScrollPageIndicator
        fileId={current.id}
        topInset={immersive ? 0 : insets.top}
        bottomInset={immersive ? 0 : insets.bottom}
        onSeekingChange={setSeeking}
      />

      {/* Bottom: dots for position within the group */}
      <Animated.View
        pointerEvents={chromeVisible ? 'auto' : 'none'}
        style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }, dotsStyle]}
      >
        <PageDots count={files.length} index={index} progress={swipeProgress} theme={theme} />
      </Animated.View>

      <ActionSheet
        visible={sheet === 'file'}
        title="Jump to file"
        subtitle={`${files.length} in this group`}
        actions={fileActions}
        theme={theme}
        onClose={() => setSheet('none')}
      />

      <ActionSheet
        visible={sheet === 'group'}
        title="Switch group"
        actions={groupActions}
        theme={theme}
        onClose={() => setSheet('none')}
      />

      <TocSheet
        visible={sheet === 'toc'}
        entries={toc}
        theme={theme}
        onSelect={(href) => requestHref(current.id, href)}
        onClose={() => setSheet('none')}
      />

      <ReaderSettingsSheet
        visible={sheet === 'display'}
        theme={theme}
        onClose={() => setSheet('none')}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  tapLayer: { flex: 1 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 10,
    paddingBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.82)',
  },
  backBtn: { width: 26, alignItems: 'center', justifyContent: 'center' },
  backGlyph: { color: '#fff', fontSize: 26, fontWeight: '400', lineHeight: 28 },
  toolBtn: { width: 30, height: 34, alignItems: 'center', justifyContent: 'center' },
  toolGlyph: { color: '#fff', fontSize: 15, fontWeight: '600' },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 12,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
})

/*
 * A default export as well as the named one.
 *
 * `React.lazy` resolves `.default`, and App.tsx loads this screen lazily so the
 * renderer graph — react-native-pdf, the WebView host, the viewer's template
 * literal, the EPUB and pagination modules — stays out of the startup bundle.
 * The named export is kept because it is what the rest of the codebase and the
 * tests refer to.
 */
export default ReaderScreen
