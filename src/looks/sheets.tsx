import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'

import type { FileEntry, Group } from '../types'
import type { Theme } from '../ui/theme'
import type { ActionSheetProps, SheetAction } from '../components/ActionSheet'
import type { LibrarySearchProps } from '../components/LibrarySearch'
import { SheetShell } from '../components/SheetShell'
import { badgeOf, formatBytes } from '../storage/formats'
import { fileSize } from '../storage/files'
import { useFileCount, useGroupsSorted } from '../store/selectors'
import { FONT_SIZE_RANGE, LINE_HEIGHT_RANGE, MARGIN_RANGE, stepValue, useReaderSettings } from '../store/readerSettings'
import { useAppearance } from '../store/appearance'
import { Icon } from './Icon'
import { READING_PALETTES } from './palettes'
import { LOOK_PAGE, PAGE_CHOICES, READING_FONT_CHOICES } from './readingFonts'
import { useLookFonts, useSkin } from './registry'
import { face, groupTint, type LookFonts } from './skin'
import { cleanTitle, positionLabel } from './text'
import { Duration, Ease } from '../ui/motion'

/**
 * The sheets every optional look shares (TASKS3 L4, L5). Each takes the look's
 * type from `useLookFonts()` and its colours from the theme, so one layout
 * serves all four looks. Classic never renders any of these: it keeps
 * ActionSheet, ReaderSettingsSheet and LibrarySearch exactly as they are.
 *
 * Every action here is one the Classic sheet already offers.
 */

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * Rows arrive with a short, staggered fade as a sheet opens — 24ms apart and
 * capped at eight rows, so even a 100-file list is fully in within about a third
 * of a second. A fade only: no slide, no spring. Rows that appear later (a
 * filter narrowing and widening) take the same quick fade.
 */
const rowIn = (i: number) => FadeIn.duration(Duration.fast).easing(Ease.enter).delay(Math.min(i, 8) * 24)

/** Closes first, then acts — the same order ActionSheet uses, so a sheet never mutates state mid-slide. */
const after = (onClose: () => void, fn: () => void) => () => {
  onClose()
  requestAnimationFrame(fn)
}

function Header({ title, subtitle, theme, fonts, right }: { title: string; subtitle?: string; theme: Theme; fonts: LookFonts | null; right?: string }) {
  return (
    <View style={styles.head}>
      <View style={styles.headRow}>
        <Text numberOfLines={1} style={[styles.title, { color: theme.fg }, fonts?.title]}>
          {title}
        </Text>
        {right ? <Text style={[styles.meta, { color: theme.fgFaint }, fonts?.meta]}>{right}</Text> : null}
      </View>
      {subtitle ? (
        <Text numberOfLines={2} style={[styles.subtitle, { color: theme.fgDim }, fonts?.body]}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  )
}

// ------------------------------------------------------------ action sheet

/** ActionSheet's contract, drawn with an icon tile and a description where the action has them. */
export function LookActionSheet({ visible, title, subtitle, actions, theme, onClose }: ActionSheetProps) {
  const fonts = useLookFonts()
  return (
    <SheetShell visible={visible} theme={theme} onClose={onClose}>
      {title ? <Header title={title} subtitle={subtitle} theme={theme} fonts={fonts} /> : null}
      <ScrollView style={styles.list} bounces={false}>
        {actions.map((a, i) => (
          <ActionRow key={a.key} index={i} action={a} theme={theme} fonts={fonts} onClose={onClose} />
        ))}
      </ScrollView>
    </SheetShell>
  )
}

function ActionRow({ action: a, index, theme, fonts, onClose }: { action: SheetAction; index: number; theme: Theme; fonts: LookFonts | null; onClose: () => void }) {
  const r = useSkin()?.corner ?? 12
  const color = a.disabled ? theme.fgFaint : a.destructive ? theme.danger : theme.fg
  return (
    <AnimatedPressable
      entering={rowIn(index)}
      disabled={a.disabled}
      onPress={after(onClose, a.onPress)}
      android_ripple={{ color: theme.surfaceAlt }}
      style={[styles.row, a.detail ? styles.rowTall : null]}
    >
      {a.icon ? (
        <View style={[styles.tile, { backgroundColor: theme.surfaceAlt, borderRadius: r }]}>
          <Icon name={a.icon} size={22} color={a.destructive ? theme.danger : color} />
        </View>
      ) : null}
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.label, { color }, fonts?.body]}>
          {a.label}
        </Text>
        {a.detail ? <Text style={[styles.detail, { color: theme.fgDim }, fonts?.body]}>{a.detail}</Text> : null}
      </View>
      {a.meta ? <Text style={[styles.meta, { color: theme.fgDim }, fonts?.meta]}>{a.meta}</Text> : null}
      {a.icon && !a.disabled && !a.destructive ? <Icon name="right" size={18} color={theme.fgFaint} /> : null}
    </AnimatedPressable>
  )
}

// ------------------------------------------------------------ jump to file

export interface JumpSheetProps {
  visible: boolean
  theme: Theme
  files: FileEntry[]
  index: number
  groupId: string
  groupTitle: string
  onPick: (index: number) => void
  onClose: () => void
}

/**
 * Jump to file: numbered rows, sizes in a mono column, the current file marked
 * with an accent bar and a check, and a filter for the 100-file groups the
 * flat list made hard to use.
 */
export function JumpSheet({ visible, theme, files, index, groupId, groupTitle, onPick, onClose }: JumpSheetProps) {
  const fonts = useLookFonts()
  const [filter, setFilter] = useState('')
  const r = useSkin()?.corner ?? 12
  useEffect(() => {
    if (visible) setFilter('')
  }, [visible])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return files
      .map((f, i) => ({ f, i, title: cleanTitle(f.name) }))
      .filter((r) => !q || r.title.toLowerCase().includes(q) || r.f.name.toLowerCase().includes(q))
  }, [files, filter])

  return (
    <SheetShell visible={visible} theme={theme} onClose={onClose}>
      <Header title="Jump to file" theme={theme} fonts={fonts} right={`${files.length} file${files.length === 1 ? '' : 's'}`} />
      <View style={styles.groupLine}>
        <View style={[styles.dot, { backgroundColor: groupTint(theme, groupId) }]} />
        <Text numberOfLines={1} style={[styles.groupName, { color: theme.fgDim }, fonts?.body]}>
          {groupTitle}
        </Text>
      </View>
      {files.length > 8 && (
        <View style={[styles.filter, { backgroundColor: theme.surfaceAlt, borderRadius: Math.min(r, 10) }]}>
          <Icon name="search" size={16} color={theme.fgFaint} />
          <TextInput
            value={filter}
            onChangeText={setFilter}
            placeholder="Filter this group"
            placeholderTextColor={theme.fgFaint}
            style={[styles.filterInput, { color: theme.fg }, fonts?.body]}
            autoCorrect={false}
            autoCapitalize="none"
            selectionColor={theme.accent}
          />
        </View>
      )}
      <ScrollView style={styles.list} bounces={false} keyboardShouldPersistTaps="handled">
        {rows.map(({ f, i, title }, j) => {
          const current = i === index
          return (
            <AnimatedPressable
              key={f.id}
              entering={rowIn(j)}
              disabled={current}
              onPress={after(onClose, () => onPick(i))}
              android_ripple={{ color: theme.surfaceAlt }}
              style={[styles.row, styles.fileRow, current && { backgroundColor: theme.surfaceAlt }]}
            >
              {current && <View style={[styles.currentBar, { backgroundColor: theme.accent }]} />}
              <Text style={[styles.no, { color: current ? theme.accent : theme.fgFaint }, fonts?.meta]}>{positionLabel(i)}</Text>
              <Text numberOfLines={1} style={[styles.label, styles.flex, { color: current ? theme.accent : theme.fg }, fonts?.body]}>
                {title}
              </Text>
              {current && <Icon name="check" size={18} color={theme.accent} strokeWidth={2} />}
              <Text style={[styles.meta, { color: theme.fgFaint }, fonts?.meta]}>{formatBytes(f.size ?? fileSize(f))}</Text>
            </AnimatedPressable>
          )
        })}
        {rows.length === 0 && <Text style={[styles.empty, { color: theme.fgFaint }, fonts?.body]}>No files match</Text>}
      </ScrollView>
    </SheetShell>
  )
}

// ------------------------------------------------------------ switch group

export interface GroupSheetProps {
  visible: boolean
  theme: Theme
  groups: Group[]
  counts: Record<string, number>
  currentId: string
  onPick: (groupId: string) => void
  onClose: () => void
}

export function GroupSheet({ visible, theme, groups, counts, currentId, onPick, onClose }: GroupSheetProps) {
  const fonts = useLookFonts()
  return (
    <SheetShell visible={visible} theme={theme} onClose={onClose}>
      <Header title="Switch group" theme={theme} fonts={fonts} />
      <ScrollView style={styles.list} bounces={false}>
        {groups.map((g, i) => {
          const count = counts[g.id] ?? 0
          const current = g.id === currentId
          // Same rule as Classic: switching into an empty group would show nothing.
          const disabled = current || count === 0
          return (
            <AnimatedPressable
              key={g.id}
              entering={rowIn(i)}
              disabled={disabled}
              onPress={after(onClose, () => onPick(g.id))}
              android_ripple={{ color: theme.surfaceAlt }}
              style={[styles.row, current && { backgroundColor: theme.surfaceAlt }]}
            >
              <View style={[styles.chip, { backgroundColor: groupTint(theme, g.id) }]} />
              <Text numberOfLines={1} style={[styles.label, styles.flex, { color: count === 0 ? theme.fgFaint : theme.fg }, fonts?.body]}>
                {g.title}
              </Text>
              <Text style={[styles.meta, { color: theme.fgFaint }, fonts?.meta]}>{count === 0 ? 'empty' : count}</Text>
              {current && <Icon name="check" size={18} color={theme.accent} strokeWidth={2} />}
            </AnimatedPressable>
          )
        })}
      </ScrollView>
    </SheetShell>
  )
}

// ----------------------------------------------------------------- display

/**
 * The Display sheet for the optional looks: a reading-font row (the one new
 * control), then today's size, line spacing and margins, then seven page
 * themes. Same store as Classic's sheet, so settings carry across looks.
 */
export function DisplaySheet({ visible, theme, onClose }: { visible: boolean; theme: Theme; onClose: () => void }) {
  const fonts = useLookFonts()
  const s = useReaderSettings()
  const readingFont = useAppearance((a) => a.readingFont)
  const setAppearance = useAppearance((a) => a.set)
  const r = useSkin()?.corner ?? 12

  // Plain functions, not components: a component defined in render remounts
  // its buttons on every change, which drops their press feedback.
  const label = (children: string, right?: string) => (
    <View style={styles.labelRow}>
      <Text style={[styles.section, { color: theme.fgFaint }, fonts?.meta]}>{children.toUpperCase()}</Text>
      {right ? <Text style={[styles.meta, { color: theme.fgDim }, fonts?.meta]}>{right}</Text> : null}
    </View>
  )
  const stepper = (value: string, onDec: () => void, onInc: () => void, icon: 'spacing' | 'margins' | 'type') => (
    <View style={[styles.stepper, { backgroundColor: theme.surfaceAlt, borderRadius: r }]}>
      <Pressable onPress={onDec} style={styles.stepBtn} hitSlop={4} accessibilityLabel="Less">
        <Text style={[styles.stepGlyph, { color: theme.fg }]}>−</Text>
      </Pressable>
      <View style={styles.stepMid}>
        <Icon name={icon} size={16} color={theme.fgFaint} />
        <Text style={[styles.stepValue, { color: theme.fg }, fonts?.meta]}>{value}</Text>
      </View>
      <Pressable onPress={onInc} style={styles.stepBtn} hitSlop={4} accessibilityLabel="More">
        <Text style={[styles.stepGlyph, { color: theme.fg }]}>+</Text>
      </Pressable>
    </View>
  )

  return (
    <SheetShell visible={visible} theme={theme} onClose={onClose}>
      <View style={styles.head}>
        <View style={styles.headRow}>
          <Text style={[styles.title, { color: theme.fg }, fonts?.title]}>Display</Text>
          <Pressable
            onPress={() => {
              s.reset()
              setAppearance('readingFont', 'default')
            }}
            hitSlop={8}
          >
            <Text style={[styles.reset, { color: theme.accent }, fonts?.body]}>Reset</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.display}>
        {label('Font')}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fontRow}>
          {READING_FONT_CHOICES.map((c) => {
            const sel = c.font === readingFont
            return (
              <Pressable
                key={c.font}
                onPress={() => setAppearance('readingFont', c.font)}
                style={[styles.fontChip, { backgroundColor: theme.surfaceAlt, borderColor: sel ? theme.accent : 'transparent', borderRadius: r }]}
                accessibilityState={{ selected: sel }}
              >
                <Text style={[styles.fontAa, { color: theme.fg }, c.preview ? face(c.preview) : null]}>Aa</Text>
                <Text style={[styles.fontName, { color: sel ? theme.accent : theme.fgDim }]}>{c.label}</Text>
              </Pressable>
            )
          })}
        </ScrollView>

        {label('Size')}
        {stepper(
          String(s.fontSize),
          () => s.set('fontSize', stepValue(s.fontSize, -1, FONT_SIZE_RANGE)),
          () => s.set('fontSize', stepValue(s.fontSize, 1, FONT_SIZE_RANGE)),
          'type',
        )}

        <View style={styles.twoCol}>
          <View style={styles.flex}>
            {label('Line spacing')}
            {stepper(
              s.lineHeight.toFixed(2).replace(/0$/, ''),
              () => s.set('lineHeight', stepValue(s.lineHeight, -1, LINE_HEIGHT_RANGE)),
              () => s.set('lineHeight', stepValue(s.lineHeight, 1, LINE_HEIGHT_RANGE)),
              'spacing',
            )}
          </View>
          <View style={styles.flex}>
            {label('Margins')}
            {stepper(
              String(s.margin),
              () => s.set('margin', stepValue(s.margin, -1, MARGIN_RANGE)),
              () => s.set('margin', stepValue(s.margin, 1, MARGIN_RANGE)),
              'margins',
            )}
          </View>
        </View>

        {label('Page')}
        <View style={styles.pages}>
          {PAGE_CHOICES.map(({ key, label }) => {
            const sel = key === s.theme
            const pal = key === 'system' ? null : READING_PALETTES[LOOK_PAGE[key]]
            return (
              <Pressable key={key} onPress={() => s.set('theme', key)} style={styles.page} accessibilityLabel={label} accessibilityState={{ selected: sel }}>
                <View
                  style={[
                    styles.pageDot,
                    { backgroundColor: pal ? pal.page : READING_PALETTES.Paper.page, borderColor: sel ? theme.accent : theme.border, borderWidth: sel ? 2.5 : 1 },
                  ]}
                >
                  {pal ? (
                    <Text style={[styles.pageA, { color: pal.ink }]}>A</Text>
                  ) : (
                    <View style={[styles.pageHalf, { backgroundColor: READING_PALETTES.Night.page }]} />
                  )}
                </View>
                <Text style={[styles.pageName, { color: sel ? theme.fg : theme.fgFaint }]}>{label}</Text>
              </Pressable>
            )
          })}
        </View>
        <Text style={[styles.note, { color: theme.fgFaint }, fonts?.body]}>
          Fonts and page colours apply to text documents; PDFs keep their own.
        </Text>
      </View>
    </SheetShell>
  )
}

// ------------------------------------------------------------------ search

/**
 * Library search for the optional looks: the same query, results and paging
 * as LibrarySearch, with results grouped under their group's colour and the
 * matched text highlighted. The field is drawn in the look's own style.
 */
export function LookSearch({ query, results, limit, theme, onQueryChange, onShowMore, onOpenFile }: LibrarySearchProps) {
  const fonts = useLookFonts()
  const skin = useSkin()
  const r = skin?.corner ?? 12
  const groups = useGroupsSorted()
  const fileCount = useFileCount()
  const searching = query.trim().length > 0
  const shown = results.files.slice(0, limit)
  const extra = results.total - shown.length
  const term = query.trim().split(/\s+/)[0]?.toLowerCase() ?? ''

  // Grouped in order of first appearance, so the best match still leads.
  const sections = useMemo(() => {
    const byGroup = new Map<string, FileEntry[]>()
    for (const f of shown) {
      const list = byGroup.get(f.groupId)
      if (list) list.push(f)
      else byGroup.set(f.groupId, [f])
    }
    return [...byGroup.entries()]
  }, [shown])

  const fieldStyle = [styles.field, { backgroundColor: theme.surfaceAlt, borderColor: searching ? theme.accent : 'transparent', borderRadius: r }]

  const highlight = (title: string) => {
    const i = term ? title.toLowerCase().indexOf(term) : -1
    if (i < 0) return title
    return (
      <>
        {title.slice(0, i)}
        <Text style={{ color: theme.accent }}>{title.slice(i, i + term.length)}</Text>
        {title.slice(i + term.length)}
      </>
    )
  }

  return (
    <View style={styles.searchWrap}>
      <View style={fieldStyle}>
        <Icon name="search" size={18} color={theme.fgFaint} />
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder={`Search ${fileCount} files`}
          placeholderTextColor={theme.fgFaint}
          style={[styles.searchInput, { color: theme.fg }, fonts?.body]}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          selectionColor={theme.accent}
        />
        {searching && (
          <Pressable onPress={() => onQueryChange('')} hitSlop={10} accessibilityLabel="Clear search">
            <Icon name="x" size={18} color={theme.fgFaint} />
          </Pressable>
        )}
      </View>

      {searching && (
        <View style={[styles.results, { backgroundColor: theme.surface, borderColor: theme.border, borderRadius: r }]}>
          <Text style={[styles.resultsHead, { color: theme.fgFaint }, fonts?.meta]}>
            {`${results.total} FILE${results.total === 1 ? '' : 'S'}${sections.length > 1 ? ` IN ${sections.length} GROUPS` : ''}`}
          </Text>
          {shown.length === 0 && <Text style={[styles.empty, { color: theme.fgFaint }, fonts?.body]}>No files match</Text>}
          {sections.map(([groupId, files]) => (
            <View key={groupId}>
              <View style={styles.resultGroup}>
                <View style={[styles.chipSmall, { backgroundColor: groupTint(theme, groupId) }]} />
                <Text numberOfLines={1} style={[styles.resultGroupName, { color: theme.fgDim }, fonts?.body]}>
                  {groups.find((g) => g.id === groupId)?.title ?? ''}
                </Text>
              </View>
              {files.map((f) => {
                const title = cleanTitle(f.name)
                return (
                  <Pressable key={f.id} onPress={() => onOpenFile(f)} android_ripple={{ color: theme.border }} style={styles.result}>
                    <View style={[styles.fmtTile, { backgroundColor: theme.surfaceAlt, borderRadius: Math.min(r, 8) }]}>
                      <Text style={[styles.fmt, { color: theme.fgDim }, fonts?.meta]}>{badgeOf(f.name).label}</Text>
                    </View>
                    <View style={styles.flex}>
                      <Text numberOfLines={1} style={[styles.label, { color: theme.fg }, fonts?.body]}>
                        {highlight(title)}
                      </Text>
                      {(
                        <Text numberOfLines={1} style={[styles.fileName, { color: theme.fgFaint }, fonts?.meta]}>
                          {f.name}
                        </Text>
                      )}
                    </View>
                  </Pressable>
                )
              })}
            </View>
          ))}
          {extra > 0 && (
            <Pressable onPress={onShowMore} android_ripple={{ color: theme.border }}>
              <Text style={[styles.more, { color: theme.accent }, fonts?.body]}>
                Showing {shown.length} of {results.total} — show more
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  )
}

/** The shared pieces, spread into every look's skin. */
export const SHARED_SHEETS = {
  Sheet: LookActionSheet,
  JumpSheet,
  GroupSheet,
  DisplaySheet,
  Search: LookSearch,
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  head: { paddingHorizontal: 20, paddingBottom: 10, gap: 3 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontSize: 19, fontWeight: '600', flexShrink: 1 },
  subtitle: { fontSize: 13 },
  reset: { fontSize: 14 },
  list: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, minHeight: 52, paddingVertical: 8 },
  rowTall: { minHeight: 68 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  tile: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 16 },
  detail: { fontSize: 13, lineHeight: 18 },
  meta: { fontSize: 12, fontVariant: ['tabular-nums'] },
  empty: { fontSize: 13, padding: 16, textAlign: 'center' },

  groupLine: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 20, marginTop: -4, marginBottom: 10 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  groupName: { fontSize: 13, flexShrink: 1 },
  filter: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 20, marginBottom: 8, height: 40, borderRadius: 10, paddingHorizontal: 12 },
  filterInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  fileRow: { minHeight: 50, paddingVertical: 0 },
  currentBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  no: { fontSize: 12, width: 26 },
  chip: { width: 12, height: 12, borderRadius: 3 },
  chipSmall: { width: 8, height: 8, borderRadius: 2 },

  display: { paddingHorizontal: 20, gap: 10, paddingBottom: 8 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  section: { fontSize: 11, letterSpacing: 1 },
  fontRow: { gap: 8 },
  fontChip: { width: 64, paddingVertical: 8, borderRadius: 12, alignItems: 'center', borderWidth: 2 },
  fontAa: { fontSize: 22, lineHeight: 28 },
  fontName: { fontSize: 10 },
  stepper: { flexDirection: 'row', alignItems: 'center', height: 44, borderRadius: 12, paddingHorizontal: 2 },
  stepBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  stepGlyph: { fontSize: 20 },
  stepMid: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  stepValue: { fontSize: 14 },
  twoCol: { flexDirection: 'row', gap: 12 },
  pages: { flexDirection: 'row', justifyContent: 'space-between' },
  page: { alignItems: 'center', gap: 6, width: 42 },
  pageDot: { width: 38, height: 38, borderRadius: 19, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  pageA: { fontSize: 14, fontWeight: '600' },
  pageHalf: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '50%' },
  pageName: { fontSize: 10 },
  note: { fontSize: 11, marginTop: 4 },

  searchWrap: { marginTop: 12, gap: 8 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 46, paddingHorizontal: 14, borderWidth: 1.5 },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  results: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', paddingBottom: 4 },
  resultsHead: { fontSize: 11, letterSpacing: 0.6, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 2 },
  resultGroup: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
  resultGroupName: { fontSize: 13, flexShrink: 1 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 8 },
  fmtTile: { width: 34, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  fmt: { fontSize: 9 },
  fileName: { fontSize: 11, marginTop: 2 },
  more: { fontSize: 12, paddingHorizontal: 14, paddingVertical: 10 },
})
