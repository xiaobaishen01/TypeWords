import { useBaseStore } from '~/stores/base.ts'
import { useRuntimeStore } from '~/stores/runtime.ts'
import { useSettingStore } from '~/stores/setting.ts'
import { useUserStore } from '~/stores/user.ts'
import { syncSetting } from '~/apis'
import { get, set } from 'idb-keyval'
import { AppEnv, DictId } from '~/config/env.ts'
import {
  _getDictDataByUrl,
  checkAndUpgradeSaveDict,
  checkAndUpgradeSaveSetting,
  shakeCommonDict,
} from '@/utils/index.ts'
import { APP_VERSION, LOCAL_FILE_KEY, SAVE_DICT_KEY, SAVE_SETTING_KEY } from '@/config/env.ts'
import { Supabase } from '~/utils/supabase.ts'
import { compareTimestamps, parseTimestamp } from '@/utils/sync'
import type { Word } from '~/types/types.ts'
import { DictType } from '~/types/enum.ts'

let unsub = null
let unsub2 = null

type SyncType = 'setting' | 'dict'

type RemoteMetaRow = {
  type: SyncType
  updated_at?: string
  data_version?: number
}

type RemoteDataRow = RemoteMetaRow & {
  data: unknown
}

function hasMissingDataVersionColumn(error: { message?: string } | null): boolean {
  return !!error?.message?.includes('data_version')
}

function getDataVersion(type: SyncType): number {
  return type === 'dict' ? SAVE_DICT_KEY.version : SAVE_SETTING_KEY.version
}

function getLocalKey(type: SyncType): string {
  return type === 'dict' ? SAVE_DICT_KEY.key : SAVE_SETTING_KEY.key
}

function isCompatibleVersion(remoteVersion: number | undefined, currentVersion: number): boolean {
  return remoteVersion == null || remoteVersion <= currentVersion
}

async function getLocalPersistMeta(type: SyncType): Promise<{ updated_at?: string; version?: number }> {
  const raw = await get(getLocalKey(type))
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return {
      updated_at: typeof parsed?.updated_at === 'string' ? parsed.updated_at : undefined,
      version: typeof parsed?.version === 'number' ? parsed.version : undefined,
    }
  } catch {
    return {}
  }
}

async function persistLocalState(type: SyncType, val: unknown, updated_at?: string): Promise<void> {
  await set(
    getLocalKey(type),
    JSON.stringify({
      val,
      version: getDataVersion(type),
      updated_at,
    })
  )
}

async function fetchServerMeta(): Promise<RemoteMetaRow[]> {
  if (!Supabase.check()) return []
  const { data, error } = await Supabase.getInstance()
    .from('typewords_data')
    .select('type, updated_at, data_version')
    .in('type', ['setting', 'dict'])
  if (error && hasMissingDataVersionColumn(error)) {
    const { data: fallbackData } = await Supabase.getInstance()
      .from('typewords_data')
      .select('type, updated_at')
      .in('type', ['setting', 'dict'])
    return (fallbackData ?? []) as RemoteMetaRow[]
  }
  return (data ?? []) as RemoteMetaRow[]
}

async function fetchServerData(type: SyncType): Promise<RemoteDataRow | null> {
  if (!Supabase.check()) return null
  const { data, error } = await Supabase.getInstance()
    .from('typewords_data')
    .select('type, data, updated_at, data_version')
    .eq('type', type)
    .maybeSingle()
  if (error && hasMissingDataVersionColumn(error)) {
    const { data: fallbackData } = await Supabase.getInstance()
      .from('typewords_data')
      .select('type, data, updated_at')
      .eq('type', type)
      .maybeSingle()
    return (fallbackData ?? null) as RemoteDataRow | null
  }
  return data as RemoteDataRow | null
}

async function upsertServerData(type: SyncType, data: unknown, updated_at: string): Promise<void> {
  if (!Supabase.check()) return
  const data_version = getDataVersion(type)
  const { error } = await Supabase.getInstance()
    .from('typewords_data')
    .upsert({ type, data, updated_at, data_version }, { onConflict: 'type' })
  if (error && hasMissingDataVersionColumn(error)) {
    await Supabase.getInstance().from('typewords_data').upsert({ type, data, updated_at }, { onConflict: 'type' })
  }
}

function applyDictData(store: ReturnType<typeof useBaseStore>, data: unknown) {
  store.setState(data as any)
  //todo 这里想办法优化，会重复加载
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

async function getServerData() {
  const store = useBaseStore()
  const settingStore = useSettingStore()

  const remoteMetas = await fetchServerMeta()
  const remoteMetaMap = new Map(remoteMetas.map(item => [item.type, item]))
  const syncTypes: SyncType[] = ['setting', 'dict']

  for (const type of syncTypes) {
    const remoteMeta = remoteMetaMap.get(type)
    const currentVersion = getDataVersion(type)
    const localMeta = await getLocalPersistMeta(type)
    const compareResult = compareTimestamps(localMeta.updated_at, remoteMeta?.updated_at)

    if (!remoteMeta) {
      const updated_at = localMeta.updated_at ?? new Date().toISOString()
      if (type === 'setting') {
        void persistLocalState('setting', settingStore.$state, updated_at)
        void upsertServerData('setting', settingStore.$state, updated_at)
      } else {
        const data = shakeCommonDict(store.$state)
        void persistLocalState('dict', data, updated_at)
        void upsertServerData('dict', data, updated_at)
      }
      continue
    }

    if (isCompatibleVersion(remoteMeta.data_version, currentVersion)) {
      const shouldFetchRemote
        = (!localMeta.updated_at && parseTimestamp(remoteMeta.updated_at) != null)
          || compareResult === 'remote_newer'

      if (shouldFetchRemote) {
        const remoteData = await fetchServerData(type)
        if (!remoteData) continue

        if (type === 'setting') {
          const normalized = checkAndUpgradeSaveSetting({
            val: remoteData.data,
            version: remoteData.data_version ?? currentVersion,
          })
          settingStore.setState(normalized)
          await persistLocalState('setting', normalized, remoteData.updated_at)
        } else {
          const normalized = checkAndUpgradeSaveDict({
            val: remoteData.data,
            version: remoteData.data_version ?? currentVersion,
          })
          applyDictData(store, normalized)
          await persistLocalState('dict', normalized, remoteData.updated_at)
        }
        continue
      }
    }

    if (compareResult === 'equal' || compareResult === 'unknown') {
      continue
    }

    if (localMeta.updated_at && compareResult === 'local_newer') {
      if (type === 'setting') {
        void upsertServerData('setting', settingStore.$state, localMeta.updated_at)
      } else {
        void upsertServerData('dict', shakeCommonDict(store.$state), localMeta.updated_at)
      }
    }
  }
}

export function useInit() {
  const store = useBaseStore()
  const settingStore = useSettingStore()
  const runtimeStore = useRuntimeStore()
  const userStore = useUserStore()
  let isInitializing = true // 标记是否正在初始化

  const onvisibilitychange = async () => {
    //如果标签页失活了就不保存数据了
    if (document.hidden) {
      isInitializing = true
    } else {
      //当激活时，要先获取数据，以保证本地是最新的，以免本地老数据上传到后端覆盖新数据
      isInitializing = true
      await getServerData()
      isInitializing = false
    }
  }

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onvisibilitychange)
  })

  //init 有可能重复执行，因为从老网站导了数据之后需要 init
  async function init() {
    let lastAudioFileIdList = []

    document.removeEventListener('visibilitychange', onvisibilitychange)
    document.addEventListener('visibilitychange', onvisibilitychange)

    unsub?.()
    //用 $subscribe 替代 watch
    unsub = store.$subscribe(
      debounce((mutation, n) => {
        // 如果正在初始化，不保存数据，避免覆盖
        if (isInitializing) return
        // console.log('store.$subscribe', mutation, n)
        let data = shakeCommonDict(n)
        const updated_at = new Date().toISOString()
        void persistLocalState('dict', data, updated_at)
        void upsertServerData('dict', data, updated_at)

        //筛选自定义和收藏
        let bookList = data.article.bookList.filter(v => v.custom || [DictId.articleCollect].includes(v.id))
        let audioFileIdList = []
        bookList.forEach(v => {
          //筛选 audioFileId 字体有值的
          v.articles
            .filter(s => !s.audioSrc && s.audioFileId)
            .forEach(a => {
              //所有 id 存起来，下次直接判断字符串是否相等，因为这个watch会频繁调用
              audioFileIdList.push(a.audioFileId)
            })
        })
        if (audioFileIdList.toString() !== lastAudioFileIdList.toString()) {
          let result = []
          //删除未使用到的文件
          get(LOCAL_FILE_KEY).then((fileList: Array<{ id: string; file: Blob }>) => {
            if (fileList && fileList.length > 0) {
              audioFileIdList.forEach(a => {
                let item = fileList.find(b => b.id === a)
                item && result.push(item)
              })
              set(LOCAL_FILE_KEY, result)
              lastAudioFileIdList = audioFileIdList
            }
          })
        }
      }, 500)
    )

    unsub2?.()
    unsub2 = settingStore.$subscribe(
      debounce((mutation, state) => {
        if (isInitializing) return
        // console.log('settingStore.$subscribe', mutation, state, isInitializing)

        const updated_at = new Date().toISOString()
        void persistLocalState('setting', state, updated_at)
        void upsertServerData('setting', state, updated_at)
        if (AppEnv.CAN_REQUEST) {
          syncSetting(null, settingStore.$state)
        }
      }, 500)
    )

    await userStore.init()
    await store.init()
    await settingStore.init()
    await getServerData()

    store.load = true
    isInitializing = false // 初始化完成，允许保存数据

    if (settingStore.first) {
      set(APP_VERSION.key, APP_VERSION.version)
    } else {
      get(APP_VERSION.key).then(r => {
        runtimeStore.isNew = r ? APP_VERSION.version > Number(r) : true
      })
    }
    window.umami?.track('host', { host: window.location.host })
  }

  return init
}
