// SVG 可编辑内容（v0.7）：哪些元素、哪些属性在面板里以表单形式出现。
// 原则：只给能看懂、改错也不会弄坏图形的东西——文字、位置、大小、颜色；路径数据、变换等藏在源码里。
import { localized } from './i18n'

/** 面板里列出的 SVG 元素与显示名（v0.10 中英两份） */
export const SVG_KINDS = localized<Record<string, string>>(
  { text: '文字', tspan: '文字片段', rect: '矩形', circle: '圆形', ellipse: '椭圆', line: '线段', polyline: '折线', polygon: '多边形', path: '路径', image: '图片', use: '引用' },
  { text: 'Text', tspan: 'Text span', rect: 'Rectangle', circle: 'Circle', ellipse: 'Ellipse', line: 'Line', polyline: 'Polyline', polygon: 'Polygon', path: 'Path', image: 'Image', use: 'Use' }
)

/** 按元素种类可改的属性：geo 为位置与大小（数字），look 为外观 */
export function svgFields(tag: string): { geo: string[]; look: string[] } {
  const paint = ['fill', 'stroke', 'stroke-width', 'opacity']
  switch (tag) {
    case 'svg':
      return { geo: ['width', 'height'], look: [] }
    case 'rect':
      return { geo: ['x', 'y', 'width', 'height', 'rx'], look: paint }
    case 'circle':
      return { geo: ['cx', 'cy', 'r'], look: paint }
    case 'ellipse':
      return { geo: ['cx', 'cy', 'rx', 'ry'], look: paint }
    case 'line':
      return { geo: ['x1', 'y1', 'x2', 'y2'], look: ['stroke', 'stroke-width', 'opacity'] }
    case 'text':
    case 'tspan':
      return { geo: ['x', 'y'], look: ['font-size', 'fill', 'text-anchor', 'opacity'] }
    case 'image':
    case 'use':
      return { geo: ['x', 'y', 'width', 'height'], look: ['opacity'] }
    default:
      return { geo: [], look: paint }
  }
}

/** 属性面板里可改的全部 SVG 属性（选中 SVG 元素时，preload 读这些属性的当前值） */
export function svgAttrNames(tag: string): string[] {
  const f = svgFields(tag)
  const adv = tag === 'svg' ? ['viewBox'] : ['transform']
  if (tag === 'path') adv.push('d')
  if (tag === 'polygon' || tag === 'polyline') adv.push('points')
  return [...f.geo, ...f.look, ...adv]
}

/** 纯数字（可带小数、负号）：用数字输入框；带单位或百分比的值用文本框 */
export function isPlainNumber(v: string): boolean {
  return /^\s*-?(\d+\.?\d*|\.\d+)\s*$/.test(v)
}

/** 一段 SVG 里的一个可编辑元素 */
export interface SvgItem {
  eid: number
  tag: string
  /** 嵌套深度（svg 的直接子元素为 0） */
  depth: number
  /** 源码里的 id，没有时为空串 */
  id: string
  /** svgFields 列出的属性的源码值；源码里没有时为空串 */
  attrs: Record<string, string>
  /** 文字元素：可改的那个槽（文字最多的槽）与它的文字 */
  text?: { slot: number; value: string }
}

export interface SvgModel {
  eid: number
  /** 元素总数超过上限时被省略的个数 */
  more: number
  items: SvgItem[]
}

/** 面板最多列出的元素个数：图表里成百上千的形状不适合逐个列出 */
export const SVG_ITEMS_MAX = 120
