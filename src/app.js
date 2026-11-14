import { BasePage } from './base-page.js'
import { plan, DESIGN_W } from './lib/fit.js'
class App extends $falcon.App {
  /**
   * 构造函数,应用生命周期内只构造一次
   */
  constructor() {
    super()
  }

  /**
   * 应用生命周期:应用启动. 初始化完成时回调,全局只触发一次.
   * @param {Object} options 启动参数
   */
  onLaunch(options) {
    super.onLaunch(options)
    // 屏幕分辨率适配机制:
    // 当 viewPort 设置750时, 所有元素尺寸可按照设计稿为 750px 宽度标准编写,
    // 最后系统会动态计算屏幕实际尺寸并显示.
    // this.setViewPort(750)

    // 屏幕分辨率适配：按真机宽高算出「两边都不溢出」的缩放比再交给 setViewPort。
    // 设计尺寸的机器（936×280）算出来就是 936，不调用，老设备零变化。
    this.applyViewport()

    // 设置页面基类,应用全局的$falcon.Page将被替换成此处指定的BasePage.
    // 继承自$falcon.Page的页面将继承自改基类.
    // 如页面未指定js,直接指向.vue文件,页面创建时会默认创建该类的实例
    $falcon.useDefaultBasePageClass(BasePage)
  }

  /**
   * 一次性分辨率适配：算缩放比 → 交给 setViewPort。
   * 任何一步拿不到可信数据都退回「不缩放」，绝不让 UI 压扁或放大到不可用。
   * 结果挂到 globalThis 上，页面里读它算全屏舞台尺寸。
   */
  applyViewport() {
    const info = { ok: 0, apply: 0, w: 0, h: 0, scale: 1, viewPort: 0, vw: 0, vh: 0, reason: '' }
    try {
      let env = null
      try {
        env = (typeof $falcon !== 'undefined' && $falcon.env) || null
      } catch (e) {
        env = null
      }
      const p = plan(env || {})
      info.ok = p.ok ? 1 : 0
      info.w = p.w
      info.h = p.h
      info.scale = p.scale
      info.viewPort = p.viewPort
      info.vw = p.vw
      info.vh = p.vh
      if (!p.ok) {
        info.reason = p.reason || 'no-screen'
      } else if (!p.apply) {
        // 1:1 的机器（936×280）：不调 setViewPort，虚拟画布就是真实屏幕
        info.reason = 'design-size'
      } else if (typeof this.setViewPort !== 'function') {
        info.reason = 'no-api'
      } else {
        try {
          this.setViewPort(p.viewPort)
          info.apply = 1
        } catch (e2) {
          info.reason = 'set-viewport-throw'
        }
      }
      // 该缩放却没缩成（没这个 API / 调用抛错）：虚拟画布退回设计稿，
      // 否则页面会拿 1010px 的骨架去排 960px 的屏，比不适配还糟。
      if (!p.ok || (p.apply && !info.apply)) {
        info.vw = DESIGN_W
        info.vh = DESIGN_H
      }
    } catch (e) {
      info.reason = 'throw:' + (e && e.message ? e.message : e)
      info.ok = 0
      info.vw = DESIGN_W
      info.vh = DESIGN_H
    }
    try {
      globalThis['$rpFit'] = info
    } catch (e) {}
    try {
      // 只有 console.warn 会落盘（需先 debugApp），且只打一行
      console.warn('[RP] layout ' + JSON.stringify(info))
    } catch (e) {}
    return info
  }

  /**
   * 应用生命周期,应用启动或应用从后台切换到前台时触发
   */
  onShow() {
    super.onShow()
  }

  /**
   * 应用生命周期:应用退出前或者应用从前台切换到后台时触发
   */
  onHide() {
    super.onHide()
  }

  /**
   * 应用生命周期:应用销毁前触发
   */
  onDestroy() {
    super.onDestroy()
  }
}

try {
  globalThis['window'] = {
    requestAnimationFrame,
    cancelAnimationFrame
  }
} catch (err) {
  console.log(err)
}

try {
  globalThis['process'] = {
    env: {
      NODE_ENV: 'production'
    }
  }
} catch (err) {
  console.log(err)
}

export default App
