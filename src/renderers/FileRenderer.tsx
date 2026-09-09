import { StyleSheet, Text, View } from 'react-native'

import { badgeOf } from '../storage/formats'
import { useTheme } from '../ui/theme'
import { ImageRenderer } from './ImageRenderer'
import { PdfRenderer } from './PdfRenderer'
import { WebViewRenderer } from './WebViewRenderer'
import type { RendererProps } from './types'

/**
 * Dispatches to a renderer by format.
 *
 * PDF and images take the native fast path. Everything else — EPUB, HTML,
 * Markdown, text, DOCX, spreadsheets, comics and archives — shares one bundled
 * WebView host, which is why adding a format costs a function in
 * `webview/prepare` rather than a new renderer.
 */
export function FileRenderer(props: RendererProps) {
  const { file } = props

  switch (file.format) {
    case 'image':
      return <ImageRenderer {...props} />
    case 'pdf':
      return <PdfRenderer {...props} />
    case 'epub':
    case 'html':
    case 'markdown':
    case 'text':
    case 'docx':
    case 'xlsx':
    case 'csv':
    case 'comic':
    case 'archive':
      return <WebViewRenderer {...props} />
    default:
      return <ComingSoon label={badgeOf(file.name).label} name={file.name} />
  }
}

function ComingSoon({ label, name }: { label: string; name: string }) {
  const theme = useTheme()
  return (
    <View style={[styles.center, { backgroundColor: theme.bg }]}>
      <View style={[styles.chip, { backgroundColor: theme.surfaceAlt }]}>
        <Text style={[styles.chipText, { color: theme.fgDim }]}>{label}</Text>
      </View>
      <Text style={[styles.title, { color: theme.fg }]} numberOfLines={2}>
        {name}
      </Text>
      <Text style={[styles.body, { color: theme.fgDim }]}>
        This format is imported and tracked. Its reader arrives in the next phase.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  chipText: { fontSize: 13, fontWeight: '700', letterSpacing: 0.6 },
  title: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  body: { fontSize: 13, textAlign: 'center', lineHeight: 19, maxWidth: 280 },
})
