// 分辨率适配的 Node 侧断言：不碰设备，0.3 秒跑完
//
// 适配算法只有两条验收标准：
//   1) 缩放后的虚拟画布两个方向都容得下 936×280 的设计稿 —— 这是 PStore 说的"显示不全"；
//   2) 至少贴住屏幕的一条边 —— 否则缩放比取小了，白白浪费屏幕。
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(path.join(here, '../src/lib/fit.js'), 'utf8').replace(/export /g, '')
const {
  DESIGN_W, DESIGN_H, landscape, fitScale, plan, layout,
  TOPBAR_H, FS_BAR_H, IMG_CHROME, RIGHT_W, LEFT_PAD,
} = new Function(
  src + '\nreturn { DESIGN_W, DESIGN_H, landscape, fitScale, plan, layout,' +
  ' TOPBAR_H, FS_BAR_H, IMG_CHROME, RIGHT_W, LEFT_PAD }'
)()

const FAIL = []
function check(name, ok, got) {
  if (!ok) FAIL.push(name)
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  got=' + JSON.stringify(got)))
}

console.log('== 尺寸解读（竖装横用，宽高顺序不可信） ==')
check('936×280 原样', (function () { const l = landscape(936, 280); return l && l.w === 936 && l.h === 280 })())
check('280×936 反过来识别', (function () { const l = landscape(280, 936); return l && l.w === 936 && l.h === 280 })())
check('字符串数字也认', (function () { const l = landscape('960', '266'); return l && l.w === 960 })())
check('0×0 视为没有数据', landscape(0, 0) === null)
check('undefined 视为没有数据', landscape(undefined, undefined) === null)
check('非数字不硬转', landscape('abc', 'def') === null)
check('正方形不算横屏', landscape(320, 320) === null)
check('离谱比例不认（50:1）', landscape(5000, 100) === null)

console.log('== 缩放比 ==')
check('设计尺寸 → 1.0', fitScale(936, 280) === 1, fitScale(936, 280))
check('960×266（PStore 提到的更扁屏）→ 0.95', fitScale(960, 266) === 0.95, fitScale(960, 266))
check('更窄的 800×280 → 由宽决定', fitScale(800, 280) === 0.855, fitScale(800, 280))
check('1024×300 → 由高决定', fitScale(1024, 300) === 1.071, fitScale(1024, 300))
check('大屏不会无限放大（4 倍封顶）', fitScale(4000, 1200) <= 4, fitScale(4000, 1200))

console.log('== 真机矩阵：不裁切 + 贴边 ==')
const SCREENS = [
  [936, 280], [960, 266], [1024, 300], [960, 280], [1024, 280],
  [800, 280], [800, 480], [640, 480], [400, 300], [280, 936],
  // 同比例但更小的屏：viewPort 仍是 936，但必须缩小，否则 936px 骨架撑爆屏幕
  [720, 215], [468, 140],
]
for (const [w, h] of SCREENS) {
  const l = landscape(w, h)
  const p = plan({ deviceWidth: w, deviceHeight: h })
  const tag = '(' + w + '×' + h + ')'
  check('算出方案 ' + tag, p.ok && p.scale > 0, p)
  // 1) 虚拟画布两个方向都装得下设计稿
  check('装得下设计稿 ' + tag + ' → ' + p.vw + '×' + p.vh,
    p.vw >= DESIGN_W && p.vh >= DESIGN_H, p)
  // 2) 虚拟画布不能大到离谱（否则等于白白缩小内容）
  check('不浪费屏幕 ' + tag,
    p.vw <= l.w / p.scale + 2 && p.vh <= l.h / p.scale + 2, p)
  // 3) 交出去的 viewPort 反算回来必须等于 scale（框架按 设备宽 / viewPort 缩放）
  const back = Math.round((l.w / p.viewPort) * 1000) / 1000
  check('viewPort 反算 == scale ' + tag + ' → ' + back, Math.abs(back - p.scale) <= 0.005, p)
}

console.log('== 设计尺寸不折腾 ==')
const base = plan({ deviceWidth: 936, deviceHeight: 280 })
check('936×280 不调 setViewPort', base.ok === true && base.apply === false, base)
check('936×280 虚拟画布仍是 936×280', base.vw === 936 && base.vh === 280, base)
const strEnv = plan({ deviceWidth: '936', deviceHeight: '280' })
check('字符串环境同解', strEnv.vw === 936, strEnv)

console.log('== 读不到尺寸时安全回退 ==')
const none = plan({})
check('空 env 不 ok', none.ok === false, none)
check('空 env 不 apply', none.apply === false, none)
check('空 env 保留设计尺寸', none.vw === 936 && none.vw >= DESIGN_W, none)
check('reason 有值', !!none.reason, none)
check('null 也不炸', plan(null).ok === false, null)

console.log('== 骨架尺寸：设计尺寸上零变化 ==')
const L0 = layout(null)
check('拿不到环境 → 936×280', L0.rootW === 936 && L0.rootH === 280, L0)
check('主体高 = 280 - 顶栏 44', L0.bodyH === 236, L0)
check('图片框 544×190', L0.imgW === 544 && L0.imgH === 190, L0)
check('右栏字段区 130', L0.fieldsH === 130, L0)
check('全屏舞台 936×244', L0.stageW === 936 && L0.stageH === 244, L0)
check('设计尺寸 factor = 1（拖动换算不变）', L0.factor === 1, L0)
check('字段区宽度不越界', RIGHT_W - LEFT_PAD === 360, RIGHT_W)

console.log('== 骨架尺寸：换机型后各段仍然闭合 ==')
for (const [w, h] of SCREENS) {
  const p = plan({ deviceWidth: w, deviceHeight: h })
  const L = layout(p)
  const tag = '(' + w + '×' + h + ')'
  check('整屏高度闭合 ' + tag, L.bodyH + TOPBAR_H === L.rootH, L)
  check('图片区不压到文字 ' + tag, L.imgH + IMG_CHROME <= L.bodyH, L)
  check('舞台 + 工具条 = 整屏 ' + tag, L.stageH + FS_BAR_H === L.rootH, L)
  check('画布不小于设计稿 ' + tag, L.rootW >= DESIGN_W && L.rootH >= DESIGN_H, L)
  // factor 是「真实像素 / 设计 px」，乘回去必须等于逻辑屏宽（误差来自取整）。
  // 用 plan 归一化后的 p.w：竖装横用的机器传进来的宽高顺序不可信。
  check('factor 反算回真实宽 ' + tag, Math.abs(L.rootW * L.factor - p.w) <= 2, L)
}

console.log('== 同比例小屏也要缩 ==')
for (const [w, h] of [[720, 215], [468, 140]]) {
  const p = plan({ deviceWidth: w, deviceHeight: h })
  check('同比例小屏 apply=true ' + w + '×' + h, p.ok && p.apply === true, p)
  check('同比例小屏 viewPort 取整后仍能反算 ' + w + '×' + h,
    Math.abs(p.viewPort - 936) <= 3, p)
}

console.log('== 缩放没生效时不许按虚拟画布排 ==')
const noApi = layout({ ok: 1, apply: 0, w: 960, h: 266, scale: 0.95, viewPort: 1011, vw: 1011, vh: 280, reason: 'no-api' })
check('setViewPort 没调 → 退回设计稿', noApi.rootW === 936 && noApi.rootH === 280, noApi)
check('退回时 factor 也是 1', noApi.factor === 1, noApi)
const designFit = layout(plan({ deviceWidth: 936, deviceHeight: 280 }))
check('设计尺寸机器 → 936×280', designFit.rootW === 936 && designFit.rootH === 280, designFit)
const flat = layout(plan({ deviceWidth: 960, deviceHeight: 266 }))
check('960×266 → 虚拟画布 ' + flat.rootW + '×' + flat.rootH, flat.rootW === 1011 && flat.rootH === 280, flat)
check('960×266 factor ≈ 0.95', flat.factor > 0.94 && flat.factor < 0.96, flat)

console.log('')
if (FAIL.length) {
  console.log(FAIL.length + ' 项失败：\n  - ' + FAIL.join('\n  - '))
  process.exit(1)
}
console.log('全部通过')
