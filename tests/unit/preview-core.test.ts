import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { annotate, stripAnnotations } from '../../src/main/annotate'
import { parseSource } from '../../src/main/parse'
import { fsToUrlPath, resolveRequest, urlPathToFs, type ResolveDeps } from '../../src/main/protocol'
import { place, PAD } from '../../src/shared/position'

describe('U-12 带标注副本', () => {
  const ann = (src: string) => annotate(src, parseSource(src).elements)
  it('属性插在标签名之后', () => {
    expect(ann('<p class="a">x<b>y</b></p>')).toBe('<p data-hw=0 class="a">x<b data-hw=1>y</b></p>')
  })
  it('大小写混用与自闭合标签不受影响', () => {
    expect(ann('<DIV>a<BR/>b<br />c<img src=x></DIV>')).toBe('<DIV data-hw=0>a<BR data-hw=1 />b<br data-hw=2 />c<img data-hw=3 src=x></DIV>')
  })
  it('浏览器按同样的方式读取 data-hw（自闭合不吞掉 /）', () => {
    const out = ann('<p>a<br/>b</p>')
    const els = parseSource(out).elements
    expect(els[1].tag).toBe('br')
    expect(out).toContain('<br data-hw=1 />')
  })
  it('隐含元素不插入；去掉所有 data-hw 后与原文逐字节相同', () => {
    const src = '<!doctype html>\n<title>T</title>\n<table><tr><td>x</td></tr></table>\n<svg><path d="M0 0"/></svg>\n<P>中文 😀 &amp;</P>'
    const out = ann(src)
    expect(out).not.toContain('<html data-hw')
    expect(stripAnnotations(out)).toBe(src)
  })
})

describe('U-15 路径解析与资源根', () => {
  // 一个虚拟文件系统：/proj/pages/index.html、/proj/css/a.css、/proj/pages/img/x.png、
  // /proj/pages/link → /etc（符号链接指向资源根外）、/secret.txt
  const files = new Set(['/proj/pages/index.html', '/proj/css/a.css', '/proj/pages/img/x.png', '/etc/passwd', '/secret.txt', '/proj/pages/css/a.css'])
  const links: Record<string, string> = { '/proj/pages/link': '/etc' }
  const deps: ResolveDeps = {
    win: false,
    realpath(p) {
      let q = path.posix.normalize(p)
      for (const [from, to] of Object.entries(links)) if (q === from || q.startsWith(from + '/')) q = to + q.slice(from.length)
      if (files.has(q) || ['/proj', '/proj/pages', '/proj/css', '/etc'].includes(q)) return q
      return null
    },
    isFile: (p) => files.has(p)
  }
  const entry = '/proj/pages/index.html'
  it('入口返回带标注副本', () => {
    expect(resolveRequest('/proj/pages/index.html', entry, '/proj/pages', deps)).toEqual({ kind: 'entry' })
  })
  it('资源根内的相对资源', () => {
    expect(resolveRequest('/proj/pages/img/x.png', entry, '/proj/pages', deps)).toEqual({ kind: 'file', path: '/proj/pages/img/x.png' })
  })
  it('../ 越界：404 并记录目录；不会加载到目录内的同名文件', () => {
    // 浏览器把 ../css/a.css 解析为 /proj/css/a.css；/proj/pages/css/a.css 虽然存在，也不能被拿来顶替
    expect(resolveRequest('/proj/css/a.css', entry, '/proj/pages', deps)).toEqual({ kind: 'notFound', outOfRootDir: '/proj/css' })
  })
  it('授权上级目录后，原越界请求可以加载', () => {
    expect(resolveRequest('/proj/css/a.css', entry, '/proj', deps)).toEqual({ kind: 'file', path: '/proj/css/a.css' })
  })
  it('符号链接指向资源根外：404，不记录越界', () => {
    expect(resolveRequest('/proj/pages/link/passwd', entry, '/proj/pages', deps)).toEqual({ kind: 'notFound' })
  })
  it('根相对路径按资源根解析', () => {
    expect(resolveRequest('/img/x.png', entry, '/proj/pages', deps)).toEqual({ kind: 'file', path: '/proj/pages/img/x.png' })
  })
  it('资源根之外始终 404', () => {
    expect(resolveRequest('/secret.txt', entry, '/proj', deps)).toEqual({ kind: 'notFound', outOfRootDir: '/' })
    expect(resolveRequest('/etc/passwd', entry, '/proj', deps).kind).toBe('notFound')
  })
  it('Windows 盘符路径映射', () => {
    expect(fsToUrlPath('C:\\Users\\王\\a b.html', true)).toBe('/C/Users/%E7%8E%8B/a%20b.html')
    expect(urlPathToFs('/C/Users/王/a b.html', true)).toBe('C:\\Users\\王\\a b.html')
    expect(urlPathToFs('/css/a.css', true)).toBeNull()
    const wdeps: ResolveDeps = { win: true, realpath: (p) => (p.toLowerCase() === 'c:\\proj\\a.css' ? 'C:\\proj\\a.css' : null), isFile: () => true }
    expect(resolveRequest('/C/proj/a.css', 'C:\\proj\\index.html', 'C:\\proj', wdeps)).toEqual({ kind: 'file', path: 'C:\\proj\\a.css' })
    expect(resolveRequest('/c/proj/index.html', 'C:\\proj\\index.html', 'C:\\proj', wdeps)).toEqual({ kind: 'entry' })
  })
})

describe('U-13 定位算法', () => {
  const W = 1000
  const H = 600
  const inView = (p: { x: number; y: number }, w: number, h: number) =>
    p.x >= PAD && p.y >= PAD && p.x + w <= W - PAD && p.y + h <= H - PAD
  it('工具条优先放元素上方', () => {
    const p = place('toolbar', { left: 100, top: 200, right: 400, bottom: 260 }, W, H, 120, 32)
    expect(p).toEqual({ x: 100, y: 200 - 32 - 8 })
  })
  it('元素在视口顶部：工具条放可见顶边内侧', () => {
    const p = place('toolbar', { left: 100, top: 10, right: 400, bottom: 60 }, W, H, 120, 32)
    expect(p.y).toBe(18)
  })
  it('元素高度超过一屏：内侧也放不下时放可见底边上方或贴边', () => {
    const tall = place('toolbar', { left: 100, top: -500, right: 400, bottom: 2000 }, W, H, 120, 32)
    expect(inView(tall, 120, 32)).toBe(true)
    expect(tall.y).toBe(8) // 可见顶边 0 的内侧
    const p = place('toolbar', { left: 0, top: -100, right: 300, bottom: 30 }, W, 40, 120, 32)
    expect(p.y).toBe(PAD)
  })
  it('右侧边缘：x 夹紧在视口内', () => {
    const p = place('toolbar', { left: 950, top: 300, right: 990, bottom: 320 }, W, H, 120, 32)
    expect(p.x).toBe(W - 120 - PAD)
  })
  it('气泡优先放下方，靠近底部时放上方', () => {
    expect(place('bubble', { left: 10, top: 100, right: 200, bottom: 120 }, W, H, 300, 60).y).toBe(128)
    expect(place('bubble', { left: 10, top: 540, right: 200, bottom: 560 }, W, H, 300, 60).y).toBe(540 - 60 - 8)
  })
  it('浮层比视口宽：x = pad，最大宽度 = W − 2 × pad', () => {
    const p = place('bubble', { left: 10, top: 100, right: 200, bottom: 120 }, 300, H, 320, 60)
    expect(p).toMatchObject({ x: PAD, maxWidth: 300 - 2 * PAD })
  })
  it('元素在视口底部以下：结果仍在视口内', () => {
    const p = place('toolbar', { left: 10, top: 800, right: 200, bottom: 900 }, W, H, 120, 32)
    expect(inView(p, 120, 32)).toBe(true)
  })
})
