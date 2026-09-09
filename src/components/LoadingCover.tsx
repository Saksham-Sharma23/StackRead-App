import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Image } from 'expo-image'
import Animated, { FadeOut } from 'react-native-reanimated'

import type { Theme } from '../ui/theme'
import { Duration, Ease } from '../ui/motion'

/**
 * What the reader shows while a document is being prepared.
 *
 * ## Why this is not just a spinner
 *
 * It was one: an `ActivityIndicator` on a flat background, for however long the
 * unzip, assembly and first image round-trip took. The board did better than
 * the reader — every card already paints a ThumbHash the moment it mounts, so
 * opening a file went from a plausible cover to a grey rectangle, which reads
 * as the app losing the thing it was just showing.
 *
 * Drive never shows nothing. It paints something structurally correct
 * immediately and refines in place. The ThumbHash is exactly that: ~25 bytes
 * already in the index, decoded natively in under a millisecond, so it is
 * available on the first frame with no file read at all.
 *
 * ## Why it is blurred and dimmed rather than shown as-is
 *
 * A ThumbHash is a 32x32-ish approximation. At card size it reads as a cover;
 * at full-screen size it reads as a mistake unless it is clearly a placeholder.
 * Scaling it up under a scrim says "something is coming" instead of "here is a
 * very bad image", and it keeps the spinner legible against a light cover.
 *
 * ## Why it fades out rather than cutting
 *
 * The document appears underneath this, so a hard unmount swaps one image for
 * another in a single frame — which is the jarring part of a load, not the
 * wait. Fading reads as the page resolving.
 */

interface Props {
  theme: Theme
  /** Base64 ThumbHash from the index, if the file has one. */
  thumbhash?: string
}

export function LoadingCover({ theme, thumbhash }: Props) {
  return (
    <Animated.View
      // Only the exit is animated. Entering is the first frame of an open, and
      // fading *in* a loading state delays the very thing it exists to show.
      exiting={FadeOut.duration(Duration.fast).easing(Ease.exit)}
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }]}
      pointerEvents="none"
    >
      {thumbhash ? (
        <>
          <Image
            // No `source`: the placeholder *is* the content here. expo-image
            // decodes the hash natively, so this costs no file read and no
            // bridge crossing.
            source={undefined}
            placeholder={{ thumbhash }}
            placeholderContentFit="cover"
            style={StyleSheet.absoluteFill}
          />
          {/*
            Scrim over the blur. Without it the spinner disappears against a
            pale cover, and the placeholder reads as a failed render rather
            than as a document arriving.
          */}
          <View
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)' },
            ]}
          />
        </>
      ) : null}

      <View style={[StyleSheet.absoluteFill, styles.center]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
})
