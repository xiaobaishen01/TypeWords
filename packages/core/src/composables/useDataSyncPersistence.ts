import {
  checkAndUpgradeSaveDict,
  checkAndUpgradeSaveSetting,
  shakeCommonDict,
  _getDictDataByUrl,
  shouldFetchRemote,
} from '../utils'
import {
  getPracticeArticleCacheLocal,
  getPracticeArticleCacheLocalWithMeta,
  getPracticeWordCacheLocal,
  getPracticeWordCacheLocalWithMeta,
  PRACTICE_ARTICLE_CACHE,
  PRACTICE_WORD_CACHE,
  setPracticeArticleCacheLocal,
  setPracticeWordCacheLocal,
  type PracticeArticleCache,
  type PracticeWordCacheStored,
} from '../utils/cache'
import { SAVE_DICT_KEY, SAVE_SETTING_KEY } from '../config/env'
import { useBaseStore } from '../stores/base'
import { useSettingStore } from '../stores/setting'
import { DictType, CompareResult, SaveData, BackupData } from '../types'
import { Supabase } from '../utils/supabase'
import { get, set } from 'idb-keyval'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useRuntimeStore } from '../stores/runtime'

export type SyncType = 'dict' | 'setting' | 'practice_word' | 'practice_article'

type RemoteMetaRow = {
  type: SyncType
  updated_at?: string
  data_version?: number
}

type RemoteDataRow = RemoteMetaRow & {
  data: any
}

type LocalPersistMeta = {
  updated_at?: string
  version?: number
}

type SaveLocalAndSyncOptions = {
  client?: SupabaseClient | null
  pullWhenRemoteNewer?: boolean
}

const ALL_SYNC_TYPES: SyncType[] = ['dict', 'setting', 'practice_word', 'practice_article']

function getDataVersion(type: SyncType): number {
  switch (type) {
    case 'dict':
      return SAVE_DICT_KEY.version
    case 'setting':
      return SAVE_SETTING_KEY.version
    case 'practice_word':
      return PRACTICE_WORD_CACHE.version
    case 'practice_article':
      return PRACTICE_ARTICLE_CACHE.version
  }
}

function getPersistKey(type: SyncType): string {
  return type === 'dict' ? SAVE_DICT_KEY.key : SAVE_SETTING_KEY.key
}

function getSyncClient(client?: SupabaseClient | null): SupabaseClient | null {
  if (client) return client
  if (!Supabase.check()) return null
  return Supabase.getInstance() as SupabaseClient
}

async function getLocalPersistMeta(type: SyncType): Promise<LocalPersistMeta | null> {
  if (type === 'practice_word') {
    return getPracticeWordCacheLocalWithMeta()
  }
  if (type === 'practice_article') {
    return getPracticeArticleCacheLocalWithMeta()
  }
  const raw = await get(getPersistKey(type))
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function persistLocalState(type: SyncType, val: unknown, updated_at?: string): Promise<void> {
  if (type === 'practice_word') {
    setPracticeWordCacheLocal(val as PracticeWordCacheStored, updated_at)
    return
  }
  if (type === 'practice_article') {
    setPracticeArticleCacheLocal(val as PracticeArticleCache, updated_at)
    return
  }
  await set(
    getPersistKey(type),
    JSON.stringify({
      val,
      version: getDataVersion(type),
      updated_at,
    })
  )
}

function applyDictData(store: ReturnType<typeof useBaseStore>, data: unknown) {
  store.setState(data as any)
  if (store.word.studyIndex >= 3) {
    if (!store.sdict.custom && !store.sdict.words.length) {
      _getDictDataByUrl(store.sdict).then(r => {
        store.word.bookList[store.word.studyIndex] = r
      })
    }
  }
  if (store.article.studyIndex >= 1) {
    if (!store.sbook.custom && !store.sbook.articles.length) {
      _getDictDataByUrl(store.sbook, DictType.article).then(r => {
        store.article.bookList[store.article.studyIndex] = r
      })
    }
  }
}

async function fetchServerMeta(types: SyncType[], client?: SupabaseClient | null): Promise<RemoteMetaRow[] | null> {
  const sb = getSyncClient(client)
  if (!sb) return null
  try {
    const { data, error } = await sb.from('typewords_data').select('type, updated_at, data_version').in('type', types)
    if (error) {
      Supabase.setStatus('error', error?.message ?? String(error))
      return null
    }
    return (data ?? []) as RemoteMetaRow[]
  } catch (error) {
    Supabase.setStatus('error', error?.message ?? String(error))
    return null
  }
}

async function fetchServerData(type: SyncType, client?: SupabaseClient | null): Promise<RemoteDataRow | null> {
  const sb = getSyncClient(client)
  if (!sb) return null
  try {
    const { data, error } = await sb
      .from('typewords_data')
      .select('type, data, updated_at, data_version')
      .eq('type', type)
      .maybeSingle()
    if (error) {
      Supabase.setStatus('error', error?.message ?? String(error))
      return null
    }
    return data as RemoteDataRow | null
  } catch (error) {
    Supabase.setStatus('error', error?.message ?? String(error))
  }
}

async function compareResultByType(
  type: SyncType,
  remoteMetaMap: Map<SyncType, RemoteMetaRow>
): Promise<CompareResult> {
  const remoteMeta = remoteMetaMap.get(type)
  if (!remoteMeta) return CompareResult.NoRemote
  const localMeta = await getLocalPersistMeta(type)
  if (!localMeta) {
    if (remoteMeta.data_version == null) {
      return CompareResult.NoRemote
    } else {
      //如果本地没数据，但远程有版本号，则远程新
      return CompareResult.RemoteNewer
    }
  }
  //如果本地没有更新日期，那必定是刚更新版本，updated_at和sb 一起上线，这里特殊处理即可
  if (!localMeta?.updated_at) return CompareResult.LocalNewer
  const currentVersion = getDataVersion(type)
  return shouldFetchRemote(localMeta.updated_at, remoteMeta.updated_at, remoteMeta.data_version, currentVersion)
}

async function upsertServerData(
  type: SyncType,
  data: unknown,
  updated_at: string,
  client?: SupabaseClient | null
): Promise<boolean> {
  const sb = getSyncClient(client)
  if (!sb) return false
  const data_version = getDataVersion(type)
  try {
    const { error } = await (sb as any)
      .from('typewords_data')
      .upsert({ type, data, updated_at, data_version }, { onConflict: 'type' })
    if (error) {
      Supabase.setStatus('error', error?.message ?? String(error))
      return false
    }
    return true
  } catch (e) {
    Supabase.setStatus('error', (e as Error)?.message ?? String(e))
    return false
  }
}

async function applyRemoteDataByType(
  type: SyncType,
  row: RemoteDataRow,
  store: ReturnType<typeof useBaseStore>,
  settingStore: ReturnType<typeof useSettingStore>
): Promise<void> {
  if (!row) return
  const now = new Date().toISOString()
  if (type === 'setting') {
    const normalized = await checkAndUpgradeSaveSetting({
      val: row.data,
      version: row.data_version,
    })
    settingStore.setState(normalized)
    await persistLocalState('setting', normalized, row.updated_at ?? now)
    return
  }
  if (type === 'dict') {
    const normalized = checkAndUpgradeSaveDict({
      val: row.data,
      version: row.data_version,
    })
    applyDictData(store, normalized)
    await persistLocalState('dict', normalized, row.updated_at ?? now)
    return
  }
  await persistLocalState(type, row.data, row.updated_at ?? now)
}

export function useDataSyncPersistence() {
  const store = useBaseStore()
  const settingStore = useSettingStore()
  const runtimeStore = useRuntimeStore()

  async function pullIfRemoteNewer(type: SyncType, client?: SupabaseClient | null): Promise<RemoteDataRow | null> {
    const remoteMetas = await fetchServerMeta([type], client)
    if (!remoteMetas) return null
    const remoteMetaMap = new Map(remoteMetas.map(item => [item.type, item]))
    const compareResult = await compareResultByType(type, remoteMetaMap)
    console.log('pullIfRemoteNewer-compareResult', CompareResult[compareResult], type)
    if (compareResult === CompareResult.RemoteNewer) {
      const remoteData = await fetchServerData(type, client)
      if (remoteData) {
        await applyRemoteDataByType(type, remoteData, store, settingStore)
        return remoteData
      }
    }
    return null
  }

  async function pullRemoteIfNewer(
    types: SyncType[] = ['setting', 'dict'],
    client?: SupabaseClient | null
  ): Promise<void> {
    if (runtimeStore.globalLoading) return
    for (const type of types) {
      await pullIfRemoteNewer(type, client)
    }
  }

  async function saveLocalAndSync(
    type: SyncType,
    data: unknown,
    options?: SaveLocalAndSyncOptions
  ): Promise<CompareResult> {
    const updated_at = new Date().toISOString()
    const pullWhenRemoteNewer = options?.pullWhenRemoteNewer !== false
    const remoteMetas = await fetchServerMeta([type], options?.client)
    if (!remoteMetas) {
      await persistLocalState(type, data, updated_at)
      return CompareResult.NoRemote
    }
    const remoteMetaMap = new Map(remoteMetas.map(item => [item.type, item]))
    const compareResult = await compareResultByType(type, remoteMetaMap)
    console.log('saveLocalAndSync-compareResult', CompareResult[compareResult], type)
    if (compareResult === CompareResult.RemoteNewer) {
      if (pullWhenRemoteNewer) {
        const remoteData = await fetchServerData(type, options?.client)
        if (remoteData) {
          await applyRemoteDataByType(type, remoteData, store, settingStore)
        }
      }
      return compareResult
    }
    await persistLocalState(type, data, updated_at)
    await upsertServerData(type, data, updated_at, options?.client)
    if (Supabase.getStatus().status !== 'error') {
      Supabase.setStatus('success')
    }
    return compareResult
  }

  async function forcePushLocalDataToRemote(data: BackupData['val'],client?: SupabaseClient | null): Promise<boolean> {
    let syncResult = true
    const updated_at = new Date().toISOString()
    const sb = getSyncClient(client)
    if (sb) {
      const rows: Array<{ type: SyncType; data: unknown; data_version: number; updated_at: string }> = [
        { type: 'dict', data: data.dict.val, data_version: SAVE_DICT_KEY.version, updated_at },
        { type: 'setting', data: data.setting.val, data_version: SAVE_SETTING_KEY.version, updated_at },
        {
          type: 'practice_word',
          data: data?.[PRACTICE_WORD_CACHE.key]?.val ?? null,
          data_version: PRACTICE_WORD_CACHE.version,
          updated_at,
        },
        {
          type: 'practice_article',
          data: data?.[PRACTICE_ARTICLE_CACHE.key]?.val ?? null,
          data_version: PRACTICE_ARTICLE_CACHE.version,
          updated_at,
        },
      ]
      try {
        const { error } = await (sb as any).from('typewords_data').upsert(rows, { onConflict: 'type' })
        if (error) {
          syncResult = false
          Supabase.setStatus('error', error?.message ?? String(error))
        }
      } catch (error) {
        syncResult = false
        Supabase.setStatus('error', error?.message ?? String(error))
      }
    } else {
      syncResult = false
    }
    await persistLocalState('dict', data.dict.val, updated_at)
    await persistLocalState('setting', data.setting.val, updated_at)
    await persistLocalState('practice_word', data?.[PRACTICE_WORD_CACHE.key]?.val ?? null, updated_at)
    await persistLocalState('practice_article', data?.[PRACTICE_ARTICLE_CACHE.key]?.val ?? null, updated_at)
    return syncResult
  }

  async function pullAllRemoteToLocal(client?: SupabaseClient | null): Promise<boolean> {
    const sb = getSyncClient(client)
    if (!sb) return false
    try {
      const { data, error } = await (sb as any)
        .from('typewords_data')
        .select('type, data, updated_at, data_version')
        .in('type', ALL_SYNC_TYPES)
        .not('data_version', 'is', null)
      if (error) {
        Supabase.setStatus('error', error?.message ?? String(error))
        return false
      }
      const rows = (data ?? []) as RemoteDataRow[]
      const map = new Map(rows.map(item => [item.type, item]))
      for (const type of ALL_SYNC_TYPES) {
        await applyRemoteDataByType(type, map.get(type) ?? null, store, settingStore)
      }
      Supabase.setStatus('success')
      return true
    } catch (error) {
      Supabase.setStatus('error', error?.message ?? String(error))
      return false
    }
  }

  function getLocalCompactDataByType(type: SyncType): unknown {
    if (type === 'practice_word') return getPracticeWordCacheLocal()
    if (type === 'practice_article') return getPracticeArticleCacheLocal()
    if (type === 'dict') return shakeCommonDict(store.$state)
    return settingStore.$state
  }

  return {
    pullIfRemoteNewer,
    pullRemoteIfNewer,
    saveLocalAndSync,
    forcePushLocalDataToRemote,
    pullAllRemoteToLocal,
    getLocalCompactDataByType,
  }
}
