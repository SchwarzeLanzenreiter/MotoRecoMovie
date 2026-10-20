import type { FileReader } from './mp4'

/** Random access to local files via preload */
export async function openLocal(path: string): Promise<FileReader & { id: number; path: string; close(): Promise<void> }> {
  const { id, size } = await window.api.open(path, 'r')
  return {
    id,
    path,
    size,
    read: (offset, length) => window.api.read(id, offset, length),
    close: () => window.api.close(id)
  }
}
