import { memo } from 'react'
import Svg, { Circle, Path, Rect } from 'react-native-svg'

/**
 * The redesign's icon set: 24dp grid, 1.75 stroke, round caps and joins.
 *
 * Generated from the same data the Figma sheet is built from
 * (design/redesign-plugin/src/00-helpers.js, `IC`), so the app and the design
 * cannot drift apart. Used by the optional looks only — Classic keeps its text
 * glyphs.
 *
 * Elements: p = stroked path, pf = filled + stroked path, c = stroked circle,
 * cf = filled dot, r = stroked rounded rect.
 */
type El =
  | readonly ['p' | 'pf', string]
  | readonly ['c' | 'cf', number, number, number]
  | readonly ['r', number, number, number, number, number]

const ICONS = {
  search: [['c', 11, 11, 6.5], ['p', 'M16 16l4.5 4.5']],
  more: [['cf', 5.5, 12, 1.6], ['cf', 12, 12, 1.6], ['cf', 18.5, 12, 1.6]],
  back: [['p', 'M14.5 5.5L8 12l6.5 6.5']],
  down: [['p', 'M7 10l5 5 5-5']],
  right: [['p', 'M10 7l5 5-5 5']],
  plus: [['p', 'M12 5.5v13M5.5 12h13']],
  x: [['p', 'M6.5 6.5l11 11M17.5 6.5l-11 11']],
  check: [['p', 'M5.5 12.5l4 4 9-9.5']],
  toc: [['p', 'M9 7h11M9 12h11M9 17h11'], ['cf', 4.75, 7, 1.1], ['cf', 4.75, 12, 1.1], ['cf', 4.75, 17, 1.1]],
  folder: [['p', 'M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z']],
  zip: [['p', 'M4.5 8.5h15v10a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5zM3.5 4.5h17v4h-17zM10 12h4']],
  file: [['p', 'M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z'], ['p', 'M14 3.5V8h4.5']],
  filePlus: [['p', 'M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z'], ['p', 'M14 3.5V8h4.5M12 11v6M9 14h6']],
  move: [['p', 'M5 8.5h13.5M15 5l3.5 3.5L15 12M19 15.5H5.5M9 12l-3.5 3.5L9 19']],
  trash: [['p', 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5']],
  open: [['p', 'M7 17L17 7M9 7h8v8']],
  contrast: [['c', 12, 12, 8.5], ['pf', 'M12 3.5a8.5 8.5 0 0 1 0 17z']],
  board: [['r', 4, 4.5, 16, 4.5, 1.5], ['r', 4, 11, 7, 8.5, 1.5], ['r', 13, 11, 7, 8.5, 1.5]],
  upload: [['p', 'M12 15.5V4.5M7.5 9L12 4.5 16.5 9M5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V15']],
  restore: [['p', 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4']],
  find: [['c', 10.5, 10.5, 5.5], ['p', 'M15 15l5 5M8 10.5h5']],
  bookmark: [['p', 'M7 4.5h10v15.5l-5-3.6-5 3.6z']],
  swipe: [['p', 'M4 12h16M15.5 7.5L20 12l-4.5 4.5M8.5 7.5L4 12l4.5 4.5']],
  arrowDown: [['p', 'M12 4.5v15M7 14.5l5 5 5-5']],
  sun: [['c', 12, 12, 3.75], ['p', 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4']],
  moon: [['p', 'M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z']],
  type: [['p', 'M3.5 18.5L8.5 5.5h1l5 13M5.3 14h7.4M15 18.5l2.9-7.5h.6l2.9 7.5M15.9 16h4.6']],
  spacing: [['p', 'M5 6.5h14M5 12h14M5 17.5h14']],
  margins: [['p', 'M4.5 4.5v15M19.5 4.5v15M8.5 8h7M8.5 12h7M8.5 16h4']],
  edit: [['p', 'M5 19h3.5L19 8.5 15.5 5 5 15.5z']],
  grid: [['r', 4.5, 4.5, 6, 6, 1.2], ['r', 13.5, 4.5, 6, 6, 1.2], ['r', 4.5, 13.5, 6, 6, 1.2], ['r', 13.5, 13.5, 6, 6, 1.2]],
  palette: [['p', 'M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-.9.7-1.6 1.7-1.6h2.2a3.8 3.8 0 0 0 3.8-3.8C20.5 6.9 16.7 3.5 12 3.5z'], ['cf', 7.8, 11, 1.1], ['cf', 10.5, 7.6, 1.1], ['cf', 14.8, 7.8, 1.1]],
} as const satisfies Record<string, readonly El[]>

export type IconName = keyof typeof ICONS

interface Props {
  name: IconName
  size?: number
  color: string
  strokeWidth?: number
}

function IconImpl({ name, size = 22, color, strokeWidth = 1.75 }: Props) {
  const els = ICONS[name] as readonly El[]
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {els.map((e, i) => {
        switch (e[0]) {
          case 'p':
          case 'pf':
            return (
              <Path
                key={i}
                d={e[1]}
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill={e[0] === 'pf' ? color : 'none'}
              />
            )
          case 'c':
            return <Circle key={i} cx={e[1]} cy={e[2]} r={e[3]} stroke={color} strokeWidth={strokeWidth} fill="none" />
          case 'cf':
            return <Circle key={i} cx={e[1]} cy={e[2]} r={e[3]} fill={color} />
          case 'r':
            return (
              <Rect key={i} x={e[1]} y={e[2]} width={e[3]} height={e[4]} rx={e[5]} stroke={color} strokeWidth={strokeWidth} fill="none" />
            )
        }
      })}
    </Svg>
  )
}

export const Icon = memo(IconImpl)
