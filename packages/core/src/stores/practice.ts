import { defineStore } from 'pinia'
import { useSettingStore } from './setting'
import { WordPracticeStage } from '../types'
import { WordPracticeModeStageMap, WordPracticeStageNameMap } from '../config/env'

export type TimerPauseReason = null | 'manual' | 'auto_visibility' | 'auto_idle'

export interface PracticeState {
  stage: WordPracticeStage
  startDate: number
  spend: number
  total: number
  newWordNumber: number
  reviewWordNumber: number
  inputWordNumber: number //当前总输入了多少个单词（不包含跳过）
  wrong: number
  /** 学习计时是否暂停（单词练习页 interval 不累计 spend） */
  timerPaused: boolean
  /** 暂停原因：手动 / 切走标签 / 长时间无键盘操作 */
  timerPauseReason: TimerPauseReason
}

export const usePracticeStore = defineStore('practice', {
  state: (): PracticeState => {
    return {
      stage: WordPracticeStage.FollowWriteNewWord,
      spend: 0,
      startDate: Date.now(),
      total: 0,
      newWordNumber: 0,
      reviewWordNumber: 0,
      inputWordNumber: 0,
      wrong: 0,
      timerPaused: false,
      timerPauseReason: null,
    }
  },
  getters: {
    getStageName: state => {
      return WordPracticeStageNameMap[state.stage]
    },
    nextStage: state => {
      const settingStore = useSettingStore()
      const stages = WordPracticeModeStageMap[settingStore.wordPracticeMode]
      const index = stages.findIndex(v => v === state.stage)
      return stages[index + 1]
    },
  },
  actions: {
    pauseTimerManual() {
      if (!this.timerPaused) {
        this.timerPaused = true
        this.timerPauseReason = 'manual'
      }
    },
    pauseTimerAuto(reason: 'auto_visibility' | 'auto_idle') {
      if (!this.timerPaused) {
        this.timerPaused = true
        this.timerPauseReason = reason
      }
    },
    resumeTimer() {
      this.timerPaused = false
      this.timerPauseReason = null
    },
    resetTimerPause() {
      this.timerPaused = false
      this.timerPauseReason = null
    },
  },
})
