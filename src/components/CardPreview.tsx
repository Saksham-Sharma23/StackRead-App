import { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated'
import { Image } from 'expo-image'
import { useMMKVNumber } from 'react-native-mmkv'

import type { FileEntry } from '../types'
import { badgeOf, formatBytes } from '../storage/formats'
import { progressKey, storage } from '../storage/mmkv'
import { fileUri, thumbUri } from '../storage/paths'
import { trimToWord } from '../storage/snippet'
import { useFileEntry } from '../store/selectors'
import { useLibrary } from '../store/library'
import type { Theme } from '../ui/theme'
import { Duration, Ease } from '../ui/motion'
import { useLookFonts } from '../looks/registry'
import { GlyphIcon } from './GlyphIcon'
import { snippetOf } from './useSnippet'

/**
 * A card's quick preview: hold a card, let go, and see what the file is —
 * without opening it.
 *
 * The cover, large; what the file is, how big, which group, how far in; and
 * its opening lines where they can be read cheaply — the same bounded prefix
 * the cards already use for text formats, and page one's text for a PDF
 * (through the pdfium text module, when the build has it). Formats whose text
 * needs a full parse (EPUB, DOCX) show their cover only: a preview must open
 * instantly, and parsing a book is what opening it is for.
 *
 * Open and Options are right there, so the preview is a step towards either,
 * never a dead end. A `Modal`, for the back button, like every sheet.
 */
export function CardPreview({
  fileId,
  theme,
  onClose,
  onOpen,
  onMenu,
}: {
  /** The file to preview; null when closed. */
  fileId: string | null
  theme: Theme
  onClose: () => void
  onOpen: (file: FileEntry) => void
  onMenu: (file: FileEntry) => void
}) {
  return (
    <Modal visible={fileId !== null} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]} onPress={onClose} accessibilityLabel="Close preview" />
      {/* Keyed, so a different file never inherits the last one's opening lines. */}
      {fileId ? <PreviewCard key={fileId} fileId={fileId} theme={theme} onClose={onClose} onOpen={onOpen} onMenu={onMenu} /> : null}
    </Modal>
  )
}

/** Characters of opening text shown. About eight lines at the card's width. */
const PREVIEW_CHARS = 420

function PreviewCard({
  fileId,
  theme,
  onClose,
  onOpen,
  onMenu,
}: {
  fileId: string
  theme: Theme
  onClose: () => void
  onOpen: (file: FileEntry) => void
  onMenu: (file: FileEntry) => void
}) {
  const file = useFileEntry(fileId)
  const fonts = useLookFonts()
  const groupTitle = useLibrary((s) => (file ? s.groups.find((g) => g.id === file.groupId)?.title : undefined))
  const [stored] = useMMKVNumber(progressKey(fileId), storage)
  const progress = Math.max(0, Math.min(100, stored ?? 0))
  const lines = useOpeningLines(file)

  // Removed while previewed (an undo window committing): nothing left to show.
  useEffect(() => {
    if (!file) onClose()
  }, [file, onClose])
  if (!file) return null

  const badge = badgeOf(file.name)
  const meta = [badge.label, file.size ? formatBytes(file.size) : '', groupTitle ?? ''].filter(Boolean).join(' · ')

  const act = (then: (f: FileEntry) => void) => {
    onClose()
    // Let the preview start closing before the next screen or sheet appears —
    // two Modals in one frame flicker on Android.
    requestAnimationFrame(() => then(file))
  }

  return (
    <View style={styles.center} pointerEvents="box-none">
      <Animated.View
        entering={ZoomIn.duration(Duration.medium).easing(Ease.enter)}
        accessibilityViewIsModal
        style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
      >
        <View style={[styles.cover, { backgroundColor: theme.surfaceAlt }]}>
          {file.thumb || file.thumbhash ? (
            <Image
              source={file.thumb ? { uri: thumbUri(file.thumb) } : undefined}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              placeholder={file.thumbhash ? { thumbhash: file.thumbhash } : undefined}
              placeholderContentFit="cover"
              transition={120}
            />
          ) : (
            <View style={[styles.badge, { backgroundColor: badge.color }]}>
              <Text style={styles.badgeText}>{badge.label}</Text>
            </View>
          )}
        </View>

        <View style={styles.body}>
          <Text numberOfLines={2} style={[styles.title, { color: theme.fg }, fonts?.title]}>
            {file.name}
          </Text>
          <Text numberOfLines={1} style={[styles.meta, { color: theme.fgFaint }, fonts?.meta]}>
            {meta}
          </Text>

          {progress > 0 ? (
            <View style={styles.progressRow}>
              <View style={[styles.track, { backgroundColor: theme.surfaceAlt }]}>
                <View style={[styles.fill, { backgroundColor: theme.accent, width: `${progress}%` }]} />
              </View>
              <Text style={[styles.progressText, { color: theme.fgDim }, fonts?.meta]}>
                {progress >= 100 ? 'Finished' : `${progress}% read`}
              </Text>
            </View>
          ) : null}

          {lines ? (
            <Animated.View entering={FadeIn.duration(Duration.medium).easing(Ease.enter)}>
              <ScrollView style={styles.linesBox} nestedScrollEnabled>
                <Text style={[styles.lines, { color: theme.fgDim }, fonts?.body]}>{lines}</Text>
              </ScrollView>
            </Animated.View>
          ) : null}

          <View style={styles.actions}>
            <Pressable
              onPress={() => act(onMenu)}
              accessibilityRole="button"
              accessibilityLabel="Options"
              style={[styles.secondary, { borderColor: theme.border }]}
            >
              <GlyphIcon name="more" glyph="⋯" color={theme.fgDim} size={20} />
            </Pressable>
            <Pressable
              onPress={() => act(onOpen)}
              accessibilityRole="button"
              style={[styles.primary, { backgroundColor: theme.accent }]}
            >
              <Text style={[styles.primaryText, fonts?.strong]}>Open</Text>
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </View>
  )
}

/**
 * The file's opening text, when it can be had without parsing the document.
 *
 * Text formats: the cards' own bounded, cached prefix read. PDF: page one,
 * through the pdfium text module — skipped on a build without it. Everything
 * else: null.
 */
function useOpeningLines(file: FileEntry | undefined): string | null {
  const [lines, setLines] = useState<string | null>(() => (file ? previewSnippet(file) : null))

  useEffect(() => {
    if (!file || file.format !== 'pdf') return
    let live = true
    void (async () => {
      try {
        const pdf = await import('../../modules/pdf-text/src')
        if (!pdf.isAvailable()) return
        const { tidyPdfText } = await import('../renderers/pdfPageText')
        const text = tidyPdfText(await pdf.pageText(fileUri(file.storedName), 1))
        if (live && text) setLines(trimToWord(text.replace(/\s*\n\s*/g, ' '), PREVIEW_CHARS))
      } catch {
        // A preview without its first lines is still a preview.
      }
    })()
    return () => {
      live = false
    }
  }, [file?.id, file?.format, file?.storedName])

  return lines
}

function previewSnippet(file: FileEntry): string | null {
  const text = snippetOf(file)
  return text ? trimToWord(text, PREVIEW_CHARS) : null
}

const styles = StyleSheet.create({
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 28 },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    elevation: 12,
  },
  cover: { height: 220, alignItems: 'center', justifyContent: 'center' },
  badge: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 15, letterSpacing: 0.6 },
  body: { padding: 16, gap: 8 },
  title: { fontSize: 17, fontWeight: '600', lineHeight: 22 },
  meta: { fontSize: 12 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  track: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
  progressText: { fontSize: 12 },
  linesBox: { maxHeight: 150 },
  lines: { fontSize: 13.5, lineHeight: 19 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  secondary: {
    width: 48,
    height: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '600' },
})
