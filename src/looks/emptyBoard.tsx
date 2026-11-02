import { Pressable, StyleSheet, Text, View } from 'react-native'

import type { Theme } from '../ui/theme'
import { Icon } from './Icon'
import { useLookFonts, useSkin } from './registry'
import { ext, type EmptyBoardProps } from './skin'

/**
 * The empty board, one layout for every optional look.
 *
 * The layout is Modern's (drawn board, title, two lines of explanation, two
 * actions); each look supplies only its colours (the theme), its type
 * (`skin.fonts`) and its corner radius (`skin.corner`). One layout means the
 * first thing a new user sees teaches the same thing whichever look they
 * picked. Classic keeps its own EmptyBoard.
 */

/** A drawn board: three rows of cards, one card picked out, and the swipe named. */
function Illustration({ theme, corner }: { theme: Theme; corner: number }) {
  const e = ext(theme)
  const fonts = useLookFonts()
  const small = Math.min(corner, 6)
  return (
    <View style={[styles.illus, { backgroundColor: theme.surface, borderColor: theme.border, borderRadius: corner + 6 }]}>
      {[0, 1, 2].map((row) => (
        <View key={row} style={styles.illusRow}>
          <View style={styles.illusHead}>
            <View style={[styles.illusChip, { backgroundColor: e.groups[row], borderRadius: Math.min(corner, 2) }]} />
            <View style={[styles.illusBar, { width: row === 0 ? 70 : 50, backgroundColor: theme.fgFaint }]} />
          </View>
          <View style={styles.illusCards}>
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const picked = row === 0 && i === 1
              return (
                <View
                  key={i}
                  style={[
                    styles.illusCard,
                    {
                      borderRadius: small,
                      backgroundColor: picked ? theme.surfaceAlt : theme.bg,
                      borderColor: picked ? theme.accent : theme.border,
                      borderWidth: picked ? 1.5 : 1,
                    },
                  ]}
                />
              )
            })}
          </View>
        </View>
      ))}
      <View style={[styles.tag, { backgroundColor: theme.accent, borderRadius: corner >= 10 ? 999 : corner }]}>
        <Icon name="swipe" size={12} color={e.onAccent} strokeWidth={2} />
        <Text style={[styles.tagText, { color: e.onAccent }, fonts?.body]}>swipe between files</Text>
      </View>
    </View>
  )
}

export function LookEmptyBoard({ theme, onAddFiles, onImport }: EmptyBoardProps) {
  const e = ext(theme)
  const fonts = useLookFonts()
  const corner = useSkin()?.corner ?? 14
  return (
    <View style={styles.empty}>
      <Illustration theme={theme} corner={corner} />
      <Text style={[styles.title, { color: theme.fg }, fonts?.display]}>A board, not a folder</Text>
      <Text style={[styles.body, { color: theme.fgDim }, fonts?.body]}>
        Put related files in one row — a paper and its references, say. Swipe sideways to move between them while you read;
        scroll down for your other rows.
      </Text>
      <Text style={[styles.note, { color: theme.fgFaint }, fonts?.body]}>
        A group is only a label, so moving a file between groups never touches the file.
      </Text>
      <Pressable
        onPress={onAddFiles}
        style={[styles.btn, { backgroundColor: theme.accent, borderRadius: corner }]}
        android_ripple={{ color: theme.border }}
      >
        <Icon name="filePlus" size={20} color={e.onAccent} />
        <Text style={[styles.btnText, { color: e.onAccent }, fonts?.strong]}>Add files</Text>
      </Pressable>
      <Pressable
        onPress={onImport}
        style={[styles.btn, styles.btnOutline, { borderColor: theme.border, borderRadius: corner }]}
        android_ripple={{ color: theme.border }}
      >
        <Icon name="folder" size={20} color={theme.fg} />
        <Text style={[styles.btnText, { color: theme.fg }, fonts?.strong]}>Import a folder or ZIP</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', paddingTop: 16, paddingBottom: 12 },
  illus: { alignSelf: 'stretch', height: 176, borderWidth: StyleSheet.hairlineWidth * 2, padding: 18, gap: 10, overflow: 'hidden' },
  illusRow: { gap: 6 },
  illusHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  illusChip: { width: 8, height: 8 },
  illusBar: { height: 6, borderRadius: 3, opacity: 0.6 },
  illusCards: { flexDirection: 'row', gap: 6 },
  illusCard: { width: 42, height: 26 },
  tag: { position: 'absolute', top: 12, right: 14, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { fontSize: 10 },
  title: { fontSize: 24, fontWeight: '600', letterSpacing: -0.5, textAlign: 'center', marginTop: 26 },
  body: { fontSize: 15, lineHeight: 23, textAlign: 'center', marginTop: 10, maxWidth: 320 },
  note: { fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 10, maxWidth: 300 },
  btn: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', height: 50, alignSelf: 'stretch', marginTop: 24 },
  btnOutline: { borderWidth: 1, marginTop: 10 },
  btnText: { fontSize: 15, fontWeight: '600' },
})
