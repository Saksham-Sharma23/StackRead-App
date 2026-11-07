import { Alert, Linking, Platform, Share } from 'react-native'

import { crashReportMailto, crashReportText, type CrashReportRecord } from './crashReport'

/**
 * Asks, once, whether to email the report of the crash that ended the last
 * session. Nothing is sent unless the user sends it from their own mail app —
 * see `crashReport.ts` for why it works this way.
 *
 * Falls back to the share sheet when no mail app takes the link, so the user
 * can still copy the report or send it some other way.
 */
export function offerCrashReport(record: CrashReportRecord): void {
  const platform = `${Platform.OS} ${String(Platform.Version)}`
  Alert.alert(
    'StackRead closed unexpectedly',
    'You can email a short error report to help fix it. It contains no file names or contents, and you’ll see it before it’s sent.',
    [
      { text: 'Not now', style: 'cancel' },
      {
        text: 'Send report',
        onPress: () => {
          Linking.openURL(crashReportMailto(record, platform)).catch(() => {
            void Share.share({ message: crashReportText(record, platform) }).catch(() => {})
          })
        },
      },
    ],
  )
}
