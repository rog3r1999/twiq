// 文件监听（规格 13.10 第 1 条）：写入稳定 200ms 后才触发。
import { watch, type FSWatcher } from 'chokidar'

export type WatchEvent = 'change' | 'unlink'

const watchers = new Map<string, FSWatcher>()

export function watchFile(key: string, file: string, onEvent: (e: WatchEvent) => void): void {
  unwatchFile(key)
  const w = watch(file, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    // 原子写入（先写临时文件再重命名）会产生 unlink + add，统一按变更处理
    atomic: 150
  })
  w.on('change', () => onEvent('change'))
  w.on('add', () => onEvent('change'))
  w.on('unlink', () => onEvent('unlink'))
  w.on('error', (err) => console.error('[twiq] watcher error', err))
  watchers.set(key, w)
}

export function unwatchFile(key: string): void {
  const w = watchers.get(key)
  if (w) {
    void w.close()
    watchers.delete(key)
  }
}

export function unwatchAll(): void {
  for (const key of [...watchers.keys()]) unwatchFile(key)
}
