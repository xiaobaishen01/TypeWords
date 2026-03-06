import type { PracticeData, TaskWords } from '@/types/types.ts'
import type { PracticeState } from '@/stores/practice.ts'

type CacheConfig = { key: string; version: number }

export const PRACTICE_WORD_CACHE: CacheConfig = {
  key: 'PracticeSaveWord',
  version: 1,
}
export const PRACTICE_ARTICLE_CACHE: CacheConfig = {
  key: 'PracticeSaveArticle',
  version: 1,
}

export type PracticeWordCache = {
  taskWords: TaskWords
  practiceData: PracticeData
  statStoreData: PracticeState
}

export type PracticeWordTaskWordsStr = {
  new: string[]
  review: string[]
}

export type PracticeWordDataCompact = Omit<PracticeData, 'words' | 'wrongWords'> & {
  wordsStr: string[]
  wrongWordsStr: string[]
}

export type PracticeWordCacheCompact = {
  taskWordsStr: PracticeWordTaskWordsStr
  practiceData: PracticeWordDataCompact
  statStoreData: PracticeState
}

export type PracticeWordCacheStored = PracticeWordCache | PracticeWordCacheCompact

export type PracticeArticleCache = {
  practiceData: {
    sectionIndex: number
    sentenceIndex: number
    wordIndex: number
  }
  statStoreData: PracticeState
}

export type LocalCacheResult<T> = { val: T; updated_at?: string }

function getLocal<T>(config: CacheConfig): T | null {
  const result = getLocalWithMeta<T>(config)
  return result?.val ?? null
}

/** 返回带 updated_at 的本地缓存，供同步时比较时间戳用；无数据或解析失败返回 null */
function getLocalWithMeta<T>(config: CacheConfig): LocalCacheResult<T> | null {
  const d = localStorage.getItem(config.key)
  if (!d) return null
  try {
    const obj = JSON.parse(d)
    if (obj.version !== config.version) throw new Error('version mismatch')
    return {
      val: obj.val as T,
      updated_at: typeof obj.updated_at === 'string' ? obj.updated_at : undefined,
    }
  } catch {
    localStorage.removeItem(config.key)
    return null
  }
}

function setLocal<T>(config: CacheConfig, val: T | null, updated_at?: string): void {
  if (val != null) {
    const payload: { version: number; val: T; updated_at?: string } = {
      version: config.version,
      val,
    }
    if (updated_at) payload.updated_at = updated_at
    localStorage.setItem(config.key, JSON.stringify(payload))
  } else {
    localStorage.removeItem(config.key)
  }
}

export function getPracticeWordCacheLocal(): PracticeWordCacheStored | null {
  return getLocal<PracticeWordCacheStored>(PRACTICE_WORD_CACHE)
}

export function getPracticeWordCacheLocalWithMeta(): LocalCacheResult<PracticeWordCacheStored> | null {
  return getLocalWithMeta<PracticeWordCacheStored>(PRACTICE_WORD_CACHE)
}

export function setPracticeWordCacheLocal(cache: PracticeWordCacheStored | null, updated_at?: string): void {
  setLocal(PRACTICE_WORD_CACHE, cache, updated_at)
}

export function getPracticeArticleCacheLocal(): PracticeArticleCache | null {
  return getLocal<PracticeArticleCache>(PRACTICE_ARTICLE_CACHE)
}

export function getPracticeArticleCacheLocalWithMeta(): LocalCacheResult<PracticeArticleCache> | null {
  return getLocalWithMeta<PracticeArticleCache>(PRACTICE_ARTICLE_CACHE)
}

export function setPracticeArticleCacheLocal(cache: PracticeArticleCache | null, updated_at?: string): void {
  setLocal(PRACTICE_ARTICLE_CACHE, cache, updated_at)
}

/** @deprecated 使用 usePracticePersistence('word') 的 load/save/clear；兼容用 */
export function getPracticeWordCache(): PracticeWordCacheStored | null {
  return getPracticeWordCacheLocal()
}

/** @deprecated 使用 usePracticePersistence('word') 的 save/clear；兼容用 */
export function setPracticeWordCache(cache: PracticeWordCacheStored | null): void {
  setPracticeWordCacheLocal(cache)
}

/** @deprecated 使用 usePracticePersistence('article') 的 load/save/clear；兼容用 */
export function getPracticeArticleCache(): PracticeArticleCache | null {
  return getPracticeArticleCacheLocal()
}

/** @deprecated 使用 usePracticePersistence('article') 的 save/clear；兼容用 */
export function setPracticeArticleCache(cache: PracticeArticleCache | null): void {
  setPracticeArticleCacheLocal(cache)
}
