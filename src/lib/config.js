// 配置与请求的纯逻辑（不 import 平台 API，可 Node 单测）
// 职责：URL 构建、图片 URL 提取、下载文件名生成

import { getSource, SOURCES } from './sources.js'

// 构建请求 URL：把字段值拼成 query string
// - select 字段：值直接作为参数（空值跳过）
// - input 字段：值直接作为参数（空值跳过）
// 特殊处理：
//   yuki 的 type=img → 走直出重定向（不带 type 参数）
//   setu 的 tag 支持 | 直接透传
// icatw 直连的上游图站（笔上实测：alcy 0.2~0.5s，xjh 2~4s，paugram 3~4s，loliapi 0.3~1s）
// 全部是「请求即 302 到一张随机图」，所以每次都是新图，也不需要任何筛选参数。
export const ICATW_UPSTREAM = {
  'alcy-pc': 'https://t.alcy.cc/pc',
  'alcy-moe': 'https://t.alcy.cc/moe',
  'xjh-acg': 'https://img.xjh.me/random_img.php?type=bg&ctype=acg&return=302',
  paugram: 'https://api.paugram.com/wallpaper/',
  loliapi: 'https://www.loliapi.com/acg/pe/',
}
// 自动轮换只在这 4 个「横屏 + 稳定」的站里挑：
// loliapi 是竖屏且实测约 30% 概率返回 404，只保留为手动选项，免得拖慢自动模式
export const ICATW_KEYS = ['alcy-pc', 'alcy-moe', 'xjh-acg', 'paugram']

// 原网关接口。两个 query 都是常量：服务端会把 category/orientation/source 全部忽略，
// 唯一能选的只有「哪个组合缓存槽」，而且 5 分钟才换一次图。
export const ICATW_GATEWAY = 'https://api.icatw.site/api/v1/images/random?category=anime&orientation=any'

export function buildUrl(id, cfg) {
  const s = getSource(id)
  if (!s) return ''
  const parts = []

  // icatw：默认直连上游（每次新图）。选「网关 API」才回到 api.icatw.site。
  if (id === 'icatw') {
    const pick = cfg && cfg.source ? String(cfg.source) : ''
    if (pick === 'gateway') return ICATW_GATEWAY + '&refresh=' + String(Date.now() % 100000)
    // 空值 = 自动轮换：每次随机换一个站，跨站拿图，进一步降低撞图概率
    const key = ICATW_UPSTREAM[pick]
      ? pick
      : ICATW_KEYS[Math.floor(Math.random() * ICATW_KEYS.length)]
    const u = ICATW_UPSTREAM[key]
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + '_t=' + String(Date.now())
  }

  for (const f of s.fields) {
    const v = cfg ? cfg[f.key] : undefined
    if (v === undefined || v === null || v === '') continue
    // yuki 直出：type=img 时不带 type 参数（默认重定向到图）
    if (id === 'yuki' && f.key === 'type' && v === 'img') continue
    parts.push(encodeURIComponent(f.key) + '=' + encodeURIComponent(String(v)))
  }

  // yuki / setu：URL 固定时服务端/代理可能缓存响应导致同一张图，加时间戳参数破坏缓存
  // （实测这两个 API 容忍额外 query 参数，返回不受影响）
  if (id === 'yuki' || id === 'setu') {
    parts.push('_t=' + String(Date.now()))
  }

  return s.endpoint + (parts.length ? '?' + parts.join('&') : '')
}

// 从响应 JSON 提取图片 URL（各源结构不同）
// 返回 { url, meta } 或 null
// sizeHint：yuki 源用户选的尺寸（regular/small/original），优先取对应档位，避免总是下原图
export function extractImageUrl(id, data, sizeHint) {
  if (!data) return null

  if (id === 'yuki') {
    // 实际结构：{ success, data: { id, title, urls: { mini/thumb/small/regular/original }, user: { name }, tags } }
    const d = data && data.data ? data.data : data
    const urls = (d && d.urls) || {}
    // 尊重用户选的尺寸；找不到该档位再逐级回退
    const url =
      (d && d.url) ||
      (sizeHint && urls[sizeHint]) ||
      urls.original || urls.regular || urls.small || urls.thumb ||
      (d && d.original_url) ||
      null
    if (!url) return null
    const user = (d && d.user) || {}
    const tags = Array.isArray(d && d.tags) ? d.tags.slice(0, 5).join(',') : ''
    return {
      url,
      fallbackUrl: pixivSmallUrl(url),
      meta: {
        title: (d && d.title) || '',
        author: user.name || user.account || '',
        pid: (d && d.id) || (d && d.pid) || '',
        tags: tags,
      },
    }
  }

  if (id === 'icatw') {
    const d = data && data.data ? data.data : data
    if (!d || !d.url) return null
    // 优先走 API 自带的 CDN 代理：实测同一张 210KB 的图，
    // 原站 img.xjh.me 只有 25KB/s（8.3s），代理 87KB/s（2.4s），快 3 倍以上。
    const dlUrl = d.proxyUrl || d.url
    return {
      url: dlUrl,
      origin: d.url,
      meta: {
        title: d.title || '',
        author: d.source || '',
        pid: d.id || '',
        tags: Array.isArray(d.tags) ? d.tags.join(',') : '',
      },
    }
  }

  if (id === 'setu') {
    const list = data && data.data
    if (!Array.isArray(list) || list.length === 0) return null
    const item = list[0]
    const urls = item.urls || {}
    const url = urls.original || urls.regular || urls.small || null
    if (!url) return null
    return {
      url,
      fallbackUrl: pixivSmallUrl(url),
      meta: {
        title: item.title || '',
        author: item.author || '',
        pid: item.pid || '',
        tags: Array.isArray(item.tags) ? item.tags.join(',') : '',
      },
    }
  }

  if (id === 'lolicon') {
    // 结构：{ error: "", data: [ { pid, title, author, tags, urls: { regular } } ] }
    // 标签无结果时返回 { error: "", data: [] }，不是报错，按「没抽到」处理
    const list = data && data.data
    if (!Array.isArray(list) || list.length === 0) return null
    const item = list[0]
    const urls = item.urls || {}
    // 关键：lolicon 只返回「请求的那一档」——size=regular 时 urls 里只有 regular 一个键。
    // 所以必须先按用户选的尺寸取，再逐级回退，不能像 setu 那样写死 original 优先。
    const url =
      (sizeHint && urls[sizeHint]) ||
      urls.regular || urls.original || urls.small || urls.thumb || urls.mini ||
      null
    if (!url) return null
    // 降级档：大图在慢速边缘节点上经常超时，失败时换同一作品的小图再试一次
    let fallbackUrl = ''
    for (const k of ['small', 'thumb', 'mini']) {
      if (urls[k] && urls[k] !== url) { fallbackUrl = urls[k]; break }
    }
    if (!fallbackUrl) fallbackUrl = pixivSmallUrl(url)
    return {
      url,
      fallbackUrl,
      meta: {
        title: item.title || '',
        author: item.author || '',
        pid: item.pid || '',
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 5).join(',') : '',
        // 服务端明确回传了这张图是不是 R18：拿来做「分级」角标，
        // 也让「仅R18」模式能校验服务端有没有真的按模式给图
        r18: item.r18 === true,
      },
    }
  }

  return null
}

// lolicon 混合模式：服务端按「池子权重」抽，全年龄池远大于 R18 池，
// 抽出来几乎全是全年龄 —— 这就是「混合」和「全年龄」看起来没差别的原因。
// 改成客户端交替请求：偶数轮 r18=1、奇数轮 r18=0，命中比例才是真的 1:1。
// 首轮故意给 R18：从「全年龄」切到「混合」后第一张就能看出变化，
// 否则第一张仍是全年龄，用户会以为切换没生效。
// 非混合模式（'0' / '1'）原样返回，不受影响。
export function mixR18(cfg, round) {
  if (!cfg || cfg.r18 !== '2') return cfg
  const flip = Math.abs(Number(round) || 0) % 2 === 1
  return Object.assign({}, cfg, { r18: flip ? '0' : '1' })
}

// 生成下载文件名（含时间戳，避免覆盖）
export function buildFilename(id, ext) {
  const d = new Date()
  const pad = (n) => (n < 10 ? '0' + n : '' + n)
  const ts =
    d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
    '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds())
  return id + '_' + ts + '.' + (ext || 'jpg')
}

// 生成本地缓存图片的文件名（每次获取都不同）
// 为什么要唯一：<image> 的 src 不变时，框架不会重新加载，
// 会继续显示上一次的位图（表现为「总是同一张图」）；原地覆盖同名文件时，
// 还可能读到写了一半的数据（表现为「上半正常、下半全绿」）。
export function makeImageName(seed) {
  const s = String(seed === undefined || seed === null ? '' : seed)
    .replace(/[^0-9a-zA-Z]/g, '')
  return 'rp_' + (s || '0') + '.jpg'
}

// 从 URL 猜测扩展名（默认 jpg）
export function guessExt(url) {
  if (!url) return 'jpg'
  const m = /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.exec(url)
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg'
}

// 构造「服务端转码 / 缩放」代理地址（wsrv.nl，Cloudflare 边缘节点，免费）
// 用途：本地 ffmpeg 万一解不了某种编码（个别 webp/超大图）时的最后兜底，
// 由服务端转成标准 jpg，并可先缩到目标尺寸，下载体积更小。
// 注意：冷缓存时它要自己去拉原图，实测首张要 33s；命中缓存约 1.6s。
// 所以只在本地转码失败时用，不作为默认下载通道。
export function proxyResizeUrl(url, w, h) {
  if (!url) return ''
  // 已经是代理地址就不重复套（避免套娃）
  if (url.indexOf('wsrv.nl') >= 0 || url.indexOf('images.weserv.nl') >= 0) return url
  const W = w || 960
  const H = h || 900
  return 'https://wsrv.nl/?url=' + encodeURIComponent(url) +
    '&w=' + W + '&h=' + H + '&fit=inside&output=jpg&q=85&we=1'
}

// pixiv 代理的小图规则：/img-master/<path> → /c/540x540_70/img-master/<path>
// 用途：大图在慢速边缘节点上下不完时，换同一作品的小图先显示（约 1/10 体积）。
// 实测：规则拼出的地址返回 200，382x540、30KB。
export function pixivSmallUrl(url) {
  const m = /^(https?:\/\/[^/]+\/)(img-master\/.+)$/.exec(String(url || ''))
  if (!m) return ''
  return m[1] + 'c/540x540_70/' + m[2]
}

// 校验一个配置对象是否合法（键都在源字段里）
export function sanitizeConfig(id, cfg) {
  const s = getSource(id)
  if (!s) return {}
  const out = {}
  for (const f of s.fields) {
    let v = cfg ? cfg[f.key] : undefined
    if (v === undefined || v === null) v = f.default
    out[f.key] = String(v)
  }
  return out
}

// 三个源的显示名映射（给标题栏用）
export function sourceName(id) {
  const s = getSource(id)
  return s ? s.name : id
}

export { SOURCES }
