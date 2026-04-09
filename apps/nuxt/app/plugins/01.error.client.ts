export default defineNuxtPlugin(nuxtApp => {
  // 1. JS 同步错误
  window.onerror = function (msg, url, line, col, err) {
    reportError({ type: 'js', msg, url, line, col, err })
  }

  // 2. Promise 错误
  window.addEventListener('unhandledrejection', e => {
    reportError({ type: 'promise', err: e.reason })
  })

  // 3. 资源加载错误
  window.addEventListener(
    'error',
    e => {
      if (e.target !== window) {
        reportError({ type: 'resource', src: e?.target?.src })
      }
    },
    true
  )

  // 4. vue错误
  nuxtApp.vueApp.config.errorHandler = (err, instance, info) => {
    console.log('Vue错误:', err, info)
    reportError({ type: 'vue', err, info })
  }
})

function reportError(data) {
  console.log('统一上报:', data)
  window?.umami?.track('global-error', data)
}
