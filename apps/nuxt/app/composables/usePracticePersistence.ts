import { useBaseStore } from '@/stores/base.ts'
import type { PracticeData, TaskWords, Word } from '@/types/types.ts'
import type {
  PracticeArticleCache,
  PracticeWordCache,
  PracticeWordCacheCompact,
  PracticeWordCacheStored,
} from '@/utils/cache'
import {
  PRACTICE_ARTICLE_CACHE,
  PRACTICE_WORD_CACHE,
  getPracticeArticleCacheLocal,
  getPracticeArticleCacheLocalWithMeta,
  getPracticeWordCacheLocal,
  getPracticeWordCacheLocalWithMeta,
  setPracticeArticleCacheLocal,
  setPracticeWordCacheLocal,
} from '@/utils/cache'
import { Supabase } from '@/utils/supabase'
import { compareTimestamps, parseTimestamp } from '@/utils/sync'

const PRACTICE_TYPE_WORD = 'practice_word'
const PRACTICE_TYPE_ARTICLE = 'practice_article'

type PracticeKind = 'word' | 'article'

type RemoteRow = {
  data: PracticeWordCacheStored | PracticeArticleCache | null
  updated_at?: string
  data_version?: number
}

type RemoteMetaRow = {
  updated_at?: string
  data_version?: number
}

function getType(kind: PracticeKind): string {
  return kind === 'word' ? PRACTICE_TYPE_WORD : PRACTICE_TYPE_ARTICLE
}

function getVersion(kind: PracticeKind): number {
  return kind === 'word' ? PRACTICE_WORD_CACHE.version : PRACTICE_ARTICLE_CACHE.version
}

function isCompatibleVersion(remoteVersion: number | undefined, currentVersion: number): boolean {
  return remoteVersion == null || remoteVersion <= currentVersion
}

function hasMissingDataVersionColumn(error: { message?: string } | null): boolean {
  return !!error?.message?.includes('data_version')
}

async function fetchMetaFromSupabase(kind: PracticeKind): Promise<RemoteMetaRow | null> {
  if (!Supabase.check()) return null
  const typeName = getType(kind)
  const { data, error } = await Supabase.getInstance()
    .from('typewords_data')
    .select('updated_at, data_version')
    .eq('type', typeName)
    .maybeSingle()
  if (error && hasMissingDataVersionColumn(error)) {
    const { data: fallbackData } = await Supabase.getInstance()
      .from('typewords_data')
      .select('updated_at')
      .eq('type', typeName)
      .maybeSingle()
    return (fallbackData ?? null) as RemoteMetaRow | null
  }
  return data as RemoteMetaRow | null
}

async function fetchFromSupabase(kind: PracticeKind): Promise<RemoteRow | null> {
  if (!Supabase.check()) return null
  const typeName = getType(kind)
  const { data, error } = await Supabase.getInstance()
    .from('typewords_data')
    .select('data, updated_at, data_version')
    .eq('type', typeName)
    .maybeSingle()
  if (error && hasMissingDataVersionColumn(error)) {
    const { data: fallbackData } = await Supabase.getInstance()
      .from('typewords_data')
      .select('data, updated_at')
      .eq('type', typeName)
      .maybeSingle()
    return (fallbackData ?? null) as RemoteRow | null
  }
  return data as RemoteRow | null
}

async function upsertPracticeData(
  kind: PracticeKind,
  data: PracticeWordCacheStored | PracticeArticleCache | null,
  updated_at: string
): Promise<void> {
  if (!Supabase.check()) return
  const type = getType(kind)
  const data_version = getVersion(kind)
  const { error } = await Supabase.getInstance()
    .from('typewords_data')
    .upsert({ type, data, updated_at, data_version }, { onConflict: 'type' })
  if (error && hasMissingDataVersionColumn(error)) {
    await Supabase.getInstance()
      .from('typewords_data')
      .upsert({ type, data, updated_at }, { onConflict: 'type' })
  }
}

function isCompactPracticeWordCache(data: PracticeWordCacheStored | null): data is PracticeWordCacheCompact {
  return !!data && 'taskWordsStr' in data
}

function createWordMap(): Map<string, Word> {
  const store = useBaseStore()
  return new Map(store.sdict.words.map(word => [word.word, word]))
}

function restoreWords(words: string[], wordMap: Map<string, Word>): Word[] {
  return words.map(word => wordMap.get(word)).filter((word): word is Word => !!word)
}

function serializePracticeWordCache(data: PracticeWordCache | null): PracticeWordCacheStored | null {
  if (!data) return null
  const { words, wrongWords, ...practiceDataRest } = data.practiceData
  return {
    taskWordsStr: {
      new: data.taskWords.new.map(v => v.word),
      review: data.taskWords.review.map(v => v.word),
    },
    practiceData: {
      ...practiceDataRest,
      wordsStr: words.map(v => v.word),
      wrongWordsStr: wrongWords.map(v => v.word),
    },
    statStoreData: data.statStoreData,
  }
}

function restorePracticeWordCache(data: PracticeWordCacheStored | null): PracticeWordCache | null {
  if (!data) return null
  if (!isCompactPracticeWordCache(data)) return data

  const wordMap = createWordMap()
  const taskWords: TaskWords = {
    new: restoreWords(data.taskWordsStr.new, wordMap),
    review: restoreWords(data.taskWordsStr.review, wordMap),
  }
  const words = restoreWords(data.practiceData?.wordsStr??[], wordMap)
  const wrongWords = restoreWords(data.practiceData?.wrongWordsStr??[], wordMap)
  const index = words.length ? Math.min(data.practiceData.index, words.length - 1) : 0

  const practiceData: PracticeData = {
    ...data.practiceData,
    index,
    words,
    wrongWords,
  }
  return {
    taskWords,
    practiceData,
    statStoreData: data.statStoreData,
  }
}

export function usePracticeWordPersistence() {
  async function load(): Promise<PracticeWordCache | null> {
    const remoteMeta = await fetchMetaFromSupabase('word')
    const localMeta = getPracticeWordCacheLocalWithMeta()
    const currentVersion = PRACTICE_WORD_CACHE.version
    const compareResult = compareTimestamps(localMeta?.updated_at, remoteMeta?.updated_at)

    if (remoteMeta && isCompatibleVersion(remoteMeta.data_version, currentVersion)) {
      const shouldFetchRemote
        = (!localMeta?.updated_at && parseTimestamp(remoteMeta.updated_at) != null)
          || compareResult === 'remote_newer'
      if (shouldFetchRemote) {
        const remote = await fetchFromSupabase('word')
        const remoteData = remote?.data != null && typeof remote.data === 'object' ? (remote.data as PracticeWordCacheStored) : null
        setPracticeWordCacheLocal(remoteData, remote?.updated_at)
        return restorePracticeWordCache(remoteData)
      }
    }

    if (localMeta?.val) {
      if (compareResult === 'local_newer') {
        void upsertPracticeData('word', localMeta.val, localMeta.updated_at ?? new Date().toISOString())
      }
      return restorePracticeWordCache(localMeta.val)
    }

    return restorePracticeWordCache(getPracticeWordCacheLocal())
  }

  function save(data: PracticeWordCache | null): void {
    const updated_at = new Date().toISOString()
    const compactData = serializePracticeWordCache(data)
    setPracticeWordCacheLocal(compactData, updated_at)
    void upsertPracticeData('word', compactData, updated_at)
  }

  function clear(): void {
    setPracticeWordCacheLocal(null)
    const updated_at = new Date().toISOString()
    void upsertPracticeData('word', null, updated_at)
  }

  async function refreshFromRemote(): Promise<PracticeWordCache | null> {
    return load()
  }

  return { load, save, clear, refreshFromRemote }
}

export function usePracticeArticlePersistence() {
  async function load(): Promise<PracticeArticleCache | null> {
    const remoteMeta = await fetchMetaFromSupabase('article')
    const localMeta = getPracticeArticleCacheLocalWithMeta()
    const currentVersion = PRACTICE_ARTICLE_CACHE.version
    const compareResult = compareTimestamps(localMeta?.updated_at, remoteMeta?.updated_at)

    if (remoteMeta && isCompatibleVersion(remoteMeta.data_version, currentVersion)) {
      const shouldFetchRemote
        = (!localMeta?.updated_at && parseTimestamp(remoteMeta.updated_at) != null)
          || compareResult === 'remote_newer'
      if (shouldFetchRemote) {
        const remote = await fetchFromSupabase('article')
        const remoteData = remote?.data != null && typeof remote.data === 'object' ? (remote.data as PracticeArticleCache) : null
        setPracticeArticleCacheLocal(remoteData, remote?.updated_at)
        return remoteData
      }
    }

    if (localMeta?.val) {
      if (compareResult === 'local_newer') {
        void upsertPracticeData('article', localMeta.val, localMeta.updated_at ?? new Date().toISOString())
      }
      return localMeta.val
    }

    return getPracticeArticleCacheLocal()
  }

  function save(data: PracticeArticleCache | null): void {
    const updated_at = new Date().toISOString()
    setPracticeArticleCacheLocal(data, updated_at)
    void upsertPracticeData('article', data ?? null, updated_at)
  }

  function clear(): void {
    setPracticeArticleCacheLocal(null)
    const updated_at = new Date().toISOString()
    void upsertPracticeData('article', null, updated_at)
  }

  async function refreshFromRemote(): Promise<PracticeArticleCache | null> {
    return load()
  }

  return { load, save, clear, refreshFromRemote }
}
