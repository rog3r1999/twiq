// 自定义协议 hw://（规格第 14 节）。
// URL 路径 = 文件在磁盘上的绝对路径，页面里的 ../ 由浏览器按真实目录层级解析，
// 主进程据此判断是否越出资源根。
import path from 'node:path'
import fs from 'node:fs'

export const SCHEME = 'hw'

export function hostFor(tabId: string): string {
  return `t-${tabId}`
}

/** 绝对路径 → URL 路径（Windows 以盘符为第一段，如 /C/Users/…）。 */
export function fsToUrlPath(abs: string, win = process.platform === 'win32'): string {
  if (win) {
    const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(abs)
    const rest = m ? m[2].split(/[\\/]/) : abs.split(/[\\/]/)
    const segs = m ? [m[1].toUpperCase(), ...rest] : rest
    return '/' + segs.filter((s) => s !== '').map(encodeURIComponent).join('/')
  }
  return abs.split('/').map(encodeURIComponent).join('/')
}

export function entryUrl(tabId: string, entryPath: string): string {
  return `${SCHEME}://${hostFor(tabId)}${fsToUrlPath(entryPath)}`
}

/** URL 路径（已解码）→ 绝对路径；Windows 上首段不是盘符时返回 null。 */
export function urlPathToFs(urlPath: string, win = process.platform === 'win32'): string | null {
  if (win) {
    const m = /^\/([A-Za-z])(?:\/(.*))?$/.exec(urlPath)
    if (!m) return null
    return `${m[1].toUpperCase()}:\\${(m[2] ?? '').replace(/\//g, '\\')}`
  }
  return urlPath
}

export function decodeUrlPath(pathname: string): string {
  return pathname
    .split('/')
    .map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
    .join('/')
}

export interface ResolveDeps {
  win: boolean
  realpath(p: string): string | null
  isFile(p: string): boolean
}

export type Resolution =
  | { kind: 'entry' }
  | { kind: 'file'; path: string }
  | { kind: 'notFound'; outOfRootDir?: string }

function within(pathMod: typeof path.posix, root: string, p: string): boolean {
  const rel = pathMod.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel))
}

/** 解析一次请求（纯函数，依赖注入，便于单元测试 U-15）。 */
export function resolveRequest(urlPath: string, entryPath: string, root: string | null, deps: ResolveDeps): Resolution {
  const P = deps.win ? path.win32 : path.posix
  const abs = urlPathToFs(urlPath, deps.win)
  const norm = (p: string): string => (deps.win ? P.normalize(p).toLowerCase() : P.normalize(p))
  if (abs && norm(abs) === norm(entryPath)) return { kind: 'entry' }
  if (!root) return { kind: 'notFound' }
  const realRoot = deps.realpath(root) ?? root
  const candidates: string[] = []
  if (abs) candidates.push(abs)
  // 以 / 开头的根相对路径：再按「资源根 + 该路径」解析一次
  candidates.push(P.join(root, deps.win ? urlPath.replace(/\//g, '\\') : urlPath))
  for (const c of candidates) {
    const real = deps.realpath(c)
    if (real && deps.isFile(real) && within(P, realRoot, real)) return { kind: 'file', path: real }
  }
  // 页面确实引用了资源根之外存在的文件（../ 越界）：记录目录，供越界提示条使用
  if (abs && !within(P, P.normalize(root), P.normalize(abs))) {
    const real = deps.realpath(abs)
    if (real && deps.isFile(real)) return { kind: 'notFound', outOfRootDir: P.dirname(P.normalize(abs)) }
  }
  return { kind: 'notFound' }
}

export const nodeDeps: ResolveDeps = {
  win: process.platform === 'win32',
  realpath(p) {
    try {
      return fs.realpathSync.native(p)
    } catch {
      return null
    }
  },
  isFile(p) {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm'
}

export function mimeFor(p: string): string {
  return MIME[path.extname(p).toLowerCase()] ?? 'application/octet-stream'
}

export interface ProtocolTarget {
  entryPath(): string
  resourceRoot(): string | null
  annotated(): string
  onOutOfRoot(dir: string): void
}

/** 处理一次 hw:// 请求。 */
export async function handleRequest(req: Request, target: ProtocolTarget): Promise<Response> {
  const url = new URL(req.url)
  const res = resolveRequest(decodeUrlPath(url.pathname), target.entryPath(), target.resourceRoot(), nodeDeps)
  if (res.kind === 'entry') {
    return new Response(target.annotated(), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
  }
  if (res.kind === 'file') {
    try {
      const data = await fs.promises.readFile(res.path)
      return new Response(data, { headers: { 'content-type': mimeFor(res.path), 'cache-control': 'no-store' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }
  if (res.outOfRootDir) target.onOutOfRoot(res.outOfRootDir)
  return new Response('Not found', { status: 404 })
}
