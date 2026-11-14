// 分辨率适配：设计稿 936×280 → 任意屏幕「等比缩放、整屏可见」
//
// 背景：PStore 已把应用上架到全部机型，同一份代码会跑在逻辑分辨率不同的屏幕上
// （本机 936×280；官方 review 提到的 960×266 比例 3.61 > 3.34，底部会被切掉）。
// 界面是按 936×280 写死的 px，所以只有两条路：
//   1) 把整张样式表改成 vw/vh —— Weex 没有 calc()/min()，而「宽高都不溢出」要求
//      取两个方向缩放比的较小值，纯样式表表达不出来（用 vw 会裁底部，用 vh 会裁左右）；
//   2) 用平台官方通道 setViewPort(V)：设置后所有 px 按「设备宽 / V」等比放大，
//      等价于整张设计稿缩放。把 s = min(W/936, H/280) 解成 V = W / s 交给它即可。
//
// 这里选 2)。本模块只做算术，不碰任何平台 API，可在 Node 里直接断言
// （见 test/fit.test.mjs）。

export const DESIGN_W = 936
export const DESIGN_H = 280

// 页面里写死的那几个骨架尺寸（设计稿值）。layout() 只在这个基础上按屏幕增减，
// 设计尺寸的机器算出来与写死值完全相等 —— 老设备零变化。
export const TOPBAR_H = 44 // 顶栏
export const FS_BAR_H = 36 // 全屏工具条
export const RIGHT_W = 376 // 右栏固定宽
export const LEFT_PAD = 16 // 左栏左右 padding 之和
export const IMG_CHROME = 46 // 左栏 img-box 之外：上下 padding 16 + 元信息行 24 + 余量 6
export const FIELDS_H = 130 // 右栏字段滚动区
export const BODY_H = DESIGN_H - TOPBAR_H

const MIN_SIDE = 100 // 小于这个值基本是「还没初始化」的假数据
const MIN_RATIO = 1.1 // 横屏至少横过 1.1:1
const MAX_RATIO = 12 // 超过 12:1 不像任何一块屏
const MIN_SCALE = 0.2
const MAX_SCALE = 4
// 与设计宽相差不到这个值时不动：本机（936 宽的 X7 Pro）保持现状，不引入任何全局缩放
const SAME_EPS = 0.5

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return typeof n === 'number' && isFinite(n) ? n : 0
}

// 面板是竖装横用（direction: 270），env 给的宽高到底是 936×280 还是 280×936
// 官方没写清，所以统一「大的当宽、小的当高」。
export function landscape(w, h) {
  const a = num(w)
  const b = num(h)
  if (a < MIN_SIDE || b < MIN_SIDE) return null
  const W = Math.round(Math.max(a, b))
  const H = Math.round(Math.min(a, b))
  const r = W / H
  if (!isFinite(r) || r < MIN_RATIO || r > MAX_RATIO) return null
  return { w: W, h: H }
}

// 等比缩放比：两边都不许溢出 → 取较小的那个
export function fitScale(w, h) {
  const s = Math.min(w / DESIGN_W, h / DESIGN_H)
  if (!isFinite(s) || s <= 0) return MIN_SCALE
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
  return Math.round(clamped * 1000) / 1000
}

// 适配方案：{ ok, w, h, scale, viewPort, vw, vh, apply, reason }
//   viewPort  传给 setViewPort 的值（虚拟宽）
//   vw / vh   缩放后的虚拟画布尺寸（设计 px，页面根容器/全屏舞台按它排）
//   apply=false 表示这台机器就是设计尺寸（或算不出可信尺寸），保持原样不动最安全
export function plan(env) {
  const e = env || {}
  const l =
    landscape(e.deviceWidth, e.deviceHeight) ||
    landscape(e.screenWidth, e.screenHeight) ||
    landscape(e.width, e.height)
  if (!l) {
    return {
      ok: false, apply: false, w: 0, h: 0, scale: 1,
      viewPort: DESIGN_W, vw: DESIGN_W, vh: DESIGN_H, reason: 'no-screen',
    }
  }
  const scale = fitScale(l.w, l.h)
  // setViewPort 的入参按文档是整数，这里直接取整；取整带来的比例误差 < 0.1%
  const viewPort = Math.round(l.w / scale)
  // 虚拟画布高 = 设备高 / (设备宽 / viewPort)。向下取整：宁可少 1px 也不能比屏幕高
  const vh = Math.floor((l.h * viewPort) / l.w)
  return {
    ok: true,
    // 只要不是 1:1（设计尺寸）就得调 setViewPort。
    // 注意别拿 viewPort 和 DESIGN_W 比：720×215 这种「同比例更小的屏」算出来的
    // viewPort 也是 936，但照样需要缩到 0.77，否则 936px 的骨架会撑爆 720px 的屏。
    apply: Math.abs(scale - 1) > 0.0005,
    w: l.w,
    h: l.h,
    scale,
    viewPort,
    vw: viewPort,
    vh: Math.max(DESIGN_H, vh),
    reason: '',
  }
}

// 骨架尺寸表：页面里所有"跟屏幕大小有关"的 px 都从这里取，模板一律内联 :style 注入。
// 入参就是 app.js 挂到 globalThis['$rpFit'] 的那个对象（含 vw/vh/w/viewPort）。
// 传 null / 缺字段一律回落到设计稿，保证拿不到环境信息时和改造前完全一致。
export function layout(fit) {
  const f = fit || {}
  // vw/vh 已经是「这台机器的虚拟画布」：调了 setViewPort 就是缩放后的画布，
  // 没调（1:1）时虚拟画布恰好等于真实屏幕。拿不到 env / 调用失败时 app.js 会把
  // vw/vh 改回设计稿，所以这里只需兜一层「别小于设计稿」。
  const vwRaw = num(f.vw)
  const vhRaw = num(f.vh)
  // reason 里带 no-api / throw 的，说明该缩放却没缩成，app.js 已把 vw/vh 改回设计稿；
  // 这里再判一次，防止别处构造的 fit 对象漏改。
  const reason = typeof f.reason === 'string' ? f.reason : ''
  const failed = reason === 'no-api' || reason.indexOf('throw') === 0 || reason === 'no-screen'
  const usable = !!f.ok && !failed &&
    vwRaw >= DESIGN_W - SAME_EPS && vhRaw >= DESIGN_H - SAME_EPS
  const vw = usable ? vwRaw : DESIGN_W
  const vh = usable ? vhRaw : DESIGN_H
  const rootW = Math.max(DESIGN_W, Math.round(vw))
  const rootH = Math.max(DESIGN_H, Math.round(vh))
  const bodyH = rootH - TOPBAR_H
  const realW = num(f.w)
  const viewPort = num(f.viewPort)
  // 真实像素 / 设计 px：触摸事件给的是真实像素，位移要除以它才能落到设计坐标里
  const factor = (usable && realW > 0 && viewPort > 0) ? (realW / viewPort) : 1
  return {
    rootW,
    rootH,
    bodyH,
    imgW: rootW - RIGHT_W - LEFT_PAD,
    imgH: Math.max(120, bodyH - IMG_CHROME),
    fieldsH: Math.max(80, FIELDS_H + (bodyH - BODY_H)),
    stageW: rootW,
    stageH: Math.max(60, rootH - FS_BAR_H),
    factor: Math.round(factor * 1000) / 1000,
  }
}
