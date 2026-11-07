import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native'

import type { IconName } from '../looks/Icon'
import { useIcons } from '../ui/icons'

/**
 * An icon from the redesign's SVG set, or a text glyph until it can be drawn.
 *
 * Classic used text characters for its icons (‹ ⋯ ☰ Aa ⌕), which every phone
 * draws in its own font — different weights, sizes and baselines from one
 * device to the next. The SVG set (`looks/Icon.tsx`) is the same on all of
 * them. It loads after launch and only on builds that have react-native-svg
 * (`ui/icons.ts`); until then, and on older builds, the glyph is shown.
 *
 * Both render inside the same `size` × `size` box, so the moment the icon
 * replaces the glyph nothing around it moves.
 *
 * `glyph` may be omitted where a row reads fine without an icon (Classic's
 * sheet rows): then nothing is drawn until the icon is available.
 */
export function GlyphIcon({
  name,
  glyph,
  color,
  size = 20,
  strokeWidth,
  glyphStyle,
}: {
  name: IconName
  glyph?: string
  color: string
  size?: number
  strokeWidth?: number
  glyphStyle?: StyleProp<TextStyle>
}) {
  const icons = useIcons()

  if (!icons && glyph === undefined) return null

  return (
    <View style={[styles.box, { width: size, height: size }]}>
      {icons ? (
        <icons.Icon name={name} size={size} color={color} strokeWidth={strokeWidth} />
      ) : (
        <Text style={[styles.glyph, { color, fontSize: Math.round(size * 0.8) }, glyphStyle]}>{glyph}</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  glyph: { fontWeight: '600', textAlign: 'center' },
})
