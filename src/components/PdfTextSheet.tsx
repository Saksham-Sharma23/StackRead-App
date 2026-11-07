import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native'

import { pageText } from '../../modules/pdf-text/src'
import { tidyPdfText } from '../renderers/pdfPageText'
import type { Theme } from '../ui/theme'
import { SheetShell } from './SheetShell'

/**
 * Select and copy text from a PDF.
 *
 * ## Why a sheet, not selection on the page
 *
 * The PDF is drawn by pdfium as images of pages (`react-native-pdf`), which
 * has no text layer at all — there is nothing on the page to long-press. Text
 * selection there would mean a native overlay mapping every glyph's box, which
 * the library does not offer. The text itself is already available: the
 * `pdf-text` module that powers find-in-document reads it from the same pdfium
 * engine. So the page's text is shown here as ordinary selectable text, with
 * the system's own Copy / Share / Select-all toolbar, plus a button to share
 * the whole page.
 *
 * Opens on the page being read, and steps through pages without leaving the
 * sheet. A page with no text is almost always a scanned image, and says so.
 */
export function PdfTextSheet({
  visible,
  uri,
  page,
  total,
  theme,
  onClose,
}: {
  visible: boolean
  /** The PDF's `file://` URI in the library. */
  uri: string
  /** The page being read, 1-based. */
  page: number
  /** Pages in the document; 0 if not known yet. */
  total: number
  theme: Theme
  onClose: () => void
}) {
  const [shown, setShown] = useState(page)
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  // Each opening starts on the page being read.
  useEffect(() => {
    if (visible) setShown(Math.max(1, page))
  }, [visible, page])

  useEffect(() => {
    if (!visible) return
    let live = true
    setText(null)
    setFailed(false)
    pageText(uri, shown)
      .then((raw) => {
        if (live) setText(tidyPdfText(raw))
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [visible, uri, shown])

  const last = total > 0 ? total : shown
  const canPrev = shown > 1
  const canNext = shown < last

  return (
    <SheetShell visible={visible} theme={theme} onClose={onClose}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: theme.fg }]}>Text on this page</Text>
        <View style={styles.pager}>
          <Pressable
            onPress={() => setShown((p) => p - 1)}
            disabled={!canPrev}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Previous page"
          >
            <Text style={[styles.step, { color: canPrev ? theme.accent : theme.fgFaint }]}>‹</Text>
          </Pressable>
          <Text style={[styles.count, { color: theme.fgDim }]}>
            {total > 0 ? `${shown} / ${total}` : `${shown}`}
          </Text>
          <Pressable
            onPress={() => setShown((p) => p + 1)}
            disabled={!canNext}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Next page"
          >
            <Text style={[styles.step, { color: canNext ? theme.accent : theme.fgFaint }]}>›</Text>
          </Pressable>
        </View>
      </View>

      {failed ? (
        <Text style={[styles.note, { color: theme.fgDim }]}>The text on this page couldn’t be read.</Text>
      ) : text === null ? (
        <ActivityIndicator style={styles.loading} color={theme.accent} />
      ) : text === '' ? (
        <Text style={[styles.note, { color: theme.fgDim }]}>
          This page has no text to select — it’s probably a scanned image.
        </Text>
      ) : (
        <>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {/* `selectable` gives the system's own Copy / Select all toolbar. */}
            <Text selectable style={[styles.text, { color: theme.fg }]}>
              {text}
            </Text>
          </ScrollView>
          <Pressable
            onPress={() => void Share.share({ message: text }).catch(() => {})}
            style={[styles.share, { borderColor: theme.border }]}
            accessibilityRole="button"
          >
            <Text style={[styles.shareText, { color: theme.accent }]}>Share page text</Text>
          </Pressable>
        </>
      )}
    </SheetShell>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 8,
  },
  title: { fontSize: 16, fontWeight: '600' },
  pager: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  step: { fontSize: 24, lineHeight: 26, paddingHorizontal: 4 },
  count: { fontSize: 13, fontVariant: ['tabular-nums'], minWidth: 54, textAlign: 'center' },
  loading: { paddingVertical: 28 },
  note: { fontSize: 14, paddingHorizontal: 20, paddingVertical: 18, lineHeight: 20 },
  body: { flexGrow: 0 },
  bodyContent: { paddingHorizontal: 20, paddingBottom: 12 },
  text: { fontSize: 15, lineHeight: 22 },
  share: {
    marginHorizontal: 20,
    marginTop: 4,
    marginBottom: 6,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  shareText: { fontSize: 14, fontWeight: '600' },
})
