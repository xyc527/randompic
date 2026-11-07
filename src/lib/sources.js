// 三个图片源的 API 定义（零平台依赖的纯数据 + 纯函数）
// 每个源：id / 名称 / 端点 / 字段列表
// 字段分两类：select（预选下拉）与 input（需拉起输入法输入）

export const SOURCE_IDS = ['yuki', 'icatw', 'setu', 'lolicon']

// 字段类型：select 有 options 数组；input 有 placeholder 与 hint
export const SOURCES = {
  yuki: {
    id: 'yuki',
    name: 'Pixiv Yuki',
    desc: '随机 Pixiv 插画（含作品信息）',
    endpoint: 'https://pixiv.yuki.sh/api/recommend',
    fields: [
      {
        key: 'type',
        label: '返回类型',
        type: 'select',
        options: [
          { label: 'JSON 数据', value: 'json' },
          { label: '图片直出', value: 'img' },
        ],
        default: 'json',
      },
      {
        key: 'size',
        label: '图片尺寸',
        type: 'select',
        options: [
          { label: '常规 regular', value: 'regular' },
          { label: '小图 small', value: 'small' },
          { label: '原图 original', value: 'original' },
        ],
        default: 'regular',
      },
      {
        key: 'proxy',
        label: '代理域名',
        type: 'input',
        placeholder: '如 i.pixiv.re',
        hint: '图片代理域名',
        default: 'i.pixiv.re',
      },
    ],
  },

  // icatw：原「网关 API」实测三处硬伤（2026-11-01 复核）
  //  1) 注册表里 4 个源全部 category=anime，没有 girl 源 → category=girl 直接 503 NO_IMAGE_AVAILABLE
  //  2) 4 个源里 2 个 landscape、2 个 any，没有任何 portrait 源 → 选竖屏只会回落到 any 源（还是横图）
  //  3) 服务端对「category+orientation」组合做 5 分钟缓存（响应 cached:true + expiresAt），
  //     refresh/nocache/t/page/seed 等参数与 Cache-Control 头全部无效 → 5 分钟内连点只会拿到同一张
  // 因此改成**直连上游图站**：每次请求都是新图，且笔上实测比网关快得多。
  // （网关本身保留成最后一个选项，想对比行为可以切过去）
  icatw: {
    id: 'icatw',
    name: 'Anime Gateway',
    desc: 'ACG 壁纸直连（每次都是新图）',
    endpoint: 'https://t.alcy.cc/pc',
    // 直连源：选中的上游 URL 本身就是图片（服务端 302 到随机图），不必先请求一次 JSON
    direct: true,
    fields: [
      {
        key: 'source',
        label: '图片来源',
        type: 'select',
        options: [
          { label: '自动轮换', value: '' },
          { label: 'alcy 壁纸', value: 'alcy-pc' },
          { label: 'alcy 二次元', value: 'alcy-moe' },
          { label: 'xjh ACG', value: 'xjh-acg' },
          { label: 'paugram', value: 'paugram' },
          { label: 'loliapi 竖屏', value: 'loliapi' },
          { label: '网关 API', value: 'gateway' },
        ],
        default: '',
        hint: '前 5 个是直连，竖屏请选 loliapi；网关 API 有 5 分钟缓存',
      },
    ],
  },

  setu: {
    id: 'setu',
    name: '雪涼 Setu',
    desc: '按标签/关键词筛选（全年龄默认）',
    endpoint: 'https://api.yukiryou.icu/setu/v2',
    // 这个源现在必须要 API Key 才能用，而 Key 的申请入口在站内控制台。
    // 与其让人对着 401 猜，不如在图片区把话说清楚（含站点地址）。
    notice: [
      '我也不知道去哪获取 API Key，所以这个源用不了',
      '有兴趣可以去看看：',
      'https://cloud.yukiryou.icu/',
    ],
    fields: [
      {
        key: 'apikey',
        label: 'API Key',
        type: 'input',
        placeholder: '服务已加鉴权，需填 Key',
        hint: '留空可能返回 401',
        default: '',
      },
      {
        key: 'r18',
        label: '分级',
        type: 'select',
        options: [
          { label: '全年龄', value: '0' },
          { label: 'R18', value: '1' },
          { label: '混合', value: '2' },
        ],
        default: '0',
      },
      {
        key: 'num',
        label: '返回数量',
        type: 'select',
        options: [
          { label: '1 张', value: '1' },
          { label: '3 张', value: '3' },
          { label: '5 张', value: '5' },
          { label: '10 张', value: '10' },
        ],
        default: '1',
      },
      {
        key: 'tag',
        label: '标签筛选',
        type: 'input',
        placeholder: '如 猫娘|女仆装',
        hint: '同参数内 | 表示 OR',
        default: '',
      },
      {
        key: 'keyword',
        label: '关键词',
        type: 'input',
        placeholder: '如 白发',
        hint: '按关键词检索',
        default: '',
      },
    ],
  },

  // lolicon：Pixiv 随机插画，支持任意 tag / keyword 检索（设备实测可用，约 120KB/s）
  // 说明：服务端每次随机抽取，URL 固定也返回不同图，所以不需要加时间戳破缓存。
  // 分级做成可选：默认全年龄，用户可自行切换，不在客户端做额外内容过滤。
  lolicon: {
    id: 'lolicon',
    name: 'Lolicon',
    desc: 'Pixiv 随机插画（可按标签筛选）',
    endpoint: 'https://api.lolicon.app/setu/v2',
    fields: [
      {
        key: 'tag',
        label: '标签筛选',
        type: 'input',
        placeholder: '留空=全随机，如 白丝|猫耳',
        hint: '同参数内 | 表示 OR',
        default: '',
      },
      {
        key: 'r18',
        label: '分级',
        type: 'select',
        options: [
          { label: '全年龄', value: '0' },
          { label: '混合', value: '2' },
          { label: '仅 R18', value: '1' },
        ],
        default: '0',
      },
      {
        key: 'size',
        label: '图片尺寸',
        type: 'select',
        options: [
          { label: '常规 regular', value: 'regular' },
          { label: '小图 small', value: 'small' },
          { label: '原图 original', value: 'original' },
        ],
        default: 'regular',
      },
    ],
  },
}

// 取某个源
export function getSource(id) {
  return SOURCES[id] || null
}

// 该源的所有字段
export function sourceFields(id) {
  const s = getSource(id)
  return s ? s.fields : []
}

// 该源的默认配置（用于首次进入 / 重置）
export function defaultConfig(id) {
  const s = getSource(id)
  const cfg = {}
  if (s) {
    for (const f of s.fields) {
      cfg[f.key] = f.default
    }
  }
  return cfg
}

// 判断某字段是否需要用输入法输入
export function isInputField(id, key) {
  const s = getSource(id)
  if (!s) return false
  const f = s.fields.find((x) => x.key === key)
  return !!f && f.type === 'input'
}

// 判断某字段是否有预选项
export function fieldOptions(id, key) {
  const s = getSource(id)
  if (!s) return []
  const f = s.fields.find((x) => x.key === key)
  return f && f.options ? f.options : []
}
