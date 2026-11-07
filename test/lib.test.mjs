// Node 侧纯函数单测（零平台依赖）
import assert from 'node:assert'
import {
  SOURCE_IDS, getSource, sourceFields, defaultConfig, isInputField, fieldOptions,
} from '../src/lib/sources.js'
import {
  buildUrl, extractImageUrl, buildFilename, guessExt, sanitizeConfig, sourceName,
  makeImageName, proxyResizeUrl, pixivSmallUrl, mixR18,
  ICATW_UPSTREAM, ICATW_KEYS,
} from '../src/lib/config.js'

import {
  b64enc, normPath, parentOf, shellQuote, shellWriteCmds,
  mergeCfgText, pickCfg, saveVerdict,
} from '../src/lib/persist.js'

let pass = 0, fail = 0
function check(name, ok, got) {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + '  got=' + JSON.stringify(got)) }
}

// ===== 源定义 =====
check('四个源都存在', SOURCE_IDS.length === 4)
check('lolicon 在源列表里可选中', SOURCE_IDS.indexOf('lolicon') >= 0)
check('yuki 字段数=3', sourceFields('yuki').length === 3)
check('icatw 字段数=1（只剩图片来源）', sourceFields('icatw').length === 1)
check('setu 字段数=5', sourceFields('setu').length === 5)
check('lolicon 字段数=3', sourceFields('lolicon').length === 3)
check('getSource 空 id 返回 null', getSource('nope') === null)

// ===== 默认配置 =====
check('yuki 默认 proxy', defaultConfig('yuki').proxy === 'i.pixiv.re')
check('yuki 默认 type', defaultConfig('yuki').type === 'json')
check('setu 默认 r18', defaultConfig('setu').r18 === '0')
check('icatw 默认自动轮换', defaultConfig('icatw').source === '')
check('lolicon 默认全年龄', defaultConfig('lolicon').r18 === '0')
check('lolicon 默认 regular', defaultConfig('lolicon').size === 'regular')
check('lolicon 默认无标签', defaultConfig('lolicon').tag === '')

// ===== 字段类型判断 =====
check('yuki proxy 是 input', isInputField('yuki', 'proxy') === true)
check('yuki type 不是 input', isInputField('yuki', 'type') === false)
check('setu tag 是 input', isInputField('setu', 'tag') === true)
check('setu r18 不是 input', isInputField('setu', 'r18') === false)

// ===== 预选项 =====
check('setu r18 有 3 个选项', fieldOptions('setu', 'r18').length === 3)
check('yuki size 有 3 个选项', fieldOptions('yuki', 'size').length === 3)

// ===== URL 构建 =====
let u = buildUrl('yuki', { type: 'json', size: 'original', proxy: 'i.pixiv.re' })
check('yuki json url 含 type/size/proxy', u.includes('type=json') && u.includes('size=original') && u.includes('proxy=i.pixiv.re'), u)

u = buildUrl('yuki', { type: 'img', size: 'original', proxy: 'i.pixiv.re' })
check('yuki 直出不带 type 参数', !u.includes('type='), u)

u = buildUrl('setu', { apikey: '', r18: '0', num: '1', tag: '猫娘|女仆装', keyword: '' })
check('setu tag 中文编码', u.includes(encodeURIComponent('猫娘|女仆装')), u)
check('setu 空 apikey/keyword 跳过', !u.includes('apikey=') && !u.includes('keyword='), u)

u = buildUrl('setu', { apikey: 'abc123', r18: '0', num: '1', tag: '', keyword: '' })
check('setu 带 apikey 透传', u.includes('apikey=abc123'), u)

// icatw 改成直连上游：URL 就是图片本身，每个站一点都不同
u = buildUrl('icatw', { source: 'alcy-moe' })
check('icatw alcy-moe 直连', u.indexOf('https://t.alcy.cc/moe') === 0, u)
check('icatw alcy-moe 带破缓存参数', u.includes('_t='), u)

u = buildUrl('icatw', { source: 'xjh-acg' })
check('icatw xjh 直连', u.indexOf('https://img.xjh.me/random_img.php') === 0, u)
check('icatw xjh 用 & 接参数', u.includes('&_t='), u)

check('icatw loliapi 走竖屏入口', buildUrl('icatw', { source: 'loliapi' }).indexOf('https://www.loliapi.com/acg/pe/') === 0)
check('icatw paugram 直连', buildUrl('icatw', { source: 'paugram' }).indexOf('https://api.paugram.com/wallpaper/') === 0)

// 空值/未知值 = 自动轮换：必须落在 5 个站里，且多次调用会换站
{
  const hosts = new Set()
  for (let i = 0; i < 40; i += 1) {
    const uu = buildUrl('icatw', { source: '' })
    const m = /^https?:\/\/([^/]+)\//.exec(uu)
    hosts.add(m ? m[1] : 'bad')
  }
  check('icatw 自动轮换会换站', hosts.size >= 2 && [...hosts].every((h) => h !== 'bad'), [...hosts].join(','))
  // loliapi 竖屏 + 约 30% 404，只作手动选项，不进自动池
  check('icatw 自动轮换不含 loliapi', !hosts.has('www.loliapi.com'), [...hosts].join(','))
  check('icatw 自动池=4 个横屏站', ICATW_KEYS.length === 4 && !ICATW_KEYS.includes('loliapi'), ICATW_KEYS.join(','))
  const unknown = buildUrl('icatw', { source: '__nope__' })
  check('icatw 未知取值回落自动', ICATW_KEYS.some((k) => unknown.indexOf(ICATW_UPSTREAM[k].slice(0, 24)) === 0), unknown)
}

// 网关选项保留：回到 api.icatw.site（有 5 分钟缓存，仅供对比）
u = buildUrl('icatw', { source: 'gateway' })
check('icatw gateway 仍可用', u.indexOf('https://api.icatw.site/api/v1/images/random') === 0, u)
check('icatw gateway 带 refresh', u.includes('refresh='), u)
check('icatw gateway 不再带被忽略的 category=girl', !u.includes('girl'), u)

{
  const opts = sourceFields('icatw').find((f) => f.key === 'source').options.map((o) => o.value)
  check('icatw 图片来源共 7 项', opts.length === 7, opts.join(','))
  check('icatw 有自动轮换空值', opts.includes(''), opts.join(','))
  check('icatw 五个直连站齐全',
    ['alcy-pc', 'alcy-moe', 'xjh-acg', 'paugram', 'loliapi'].every((v) => opts.includes(v)), opts.join(','))
  check('icatw 保留 gateway 选项', opts.includes('gateway'), opts.join(','))
  check('icatw 图片来源是下拉', sourceFields('icatw').find((f) => f.key === 'source').type === 'select')
  check('icatw 标了 direct', getSource('icatw').direct === true)
}

// 修复：yuki/setu 加 _t 时间戳破坏缓存
u = buildUrl('yuki', { type: 'json', size: 'regular', proxy: 'i.pixiv.re' })
check('yuki 带 _t 破坏缓存', u.includes('_t='), u)
u = buildUrl('setu', { apikey: '', r18: '0', num: '1', tag: '', keyword: '' })
check('setu 带 _t 破坏缓存', u.includes('_t='), u)

// ===== lolicon 第四图源 =====
u = buildUrl('lolicon', { tag: '白丝|猫耳', r18: '0', size: 'regular' })
check('lolicon 端点正确', u.indexOf('https://api.lolicon.app/setu/v2?') === 0, u)
check('lolicon tag 编码含 |（OR 语法）', u.includes(encodeURIComponent('白丝|猫耳')), u)
check('lolicon 带 r18/size', u.includes('r18=0') && u.includes('size=regular'), u)
// 服务端每次随机抽取，URL 固定也返回不同图，不该多带无意义的时间戳参数
check('lolicon 不带 _t', !u.includes('_t='), u)

u = buildUrl('lolicon', { tag: '', r18: '0', size: 'regular' })
check('lolicon 空标签跳过 tag 参数', !u.includes('tag='), u)
check('lolicon 空标签仍带 r18/size', u.includes('r18=0') && u.includes('size=regular'), u)

// ===== 图片 URL 提取 =====
check('yuki urls.original', extractImageUrl('yuki', { success: true, data: { id: '1', title: 'T', urls: { original: 'https://x/o.jpg' }, user: { name: 'A' } } }).url === 'https://x/o.jpg')
check('yuki 尊重 sizeHint 取 regular', extractImageUrl('yuki', { data: { urls: { original: 'https://x/o.jpg', regular: 'https://x/r.jpg' } } }, 'regular').url === 'https://x/r.jpg')
check('yuki sizeHint 缺失回退 original', extractImageUrl('yuki', { data: { urls: { original: 'https://x/o.jpg' } } }, 'regular').url === 'https://x/o.jpg')
check('yuki meta 作者', extractImageUrl('yuki', { data: { urls: { regular: 'https://x/r.jpg' }, user: { name: '作者名' } } }).meta.author === '作者名')
check('yuki 无 url 返回 null', extractImageUrl('yuki', {}) === null)
check('yuki 无 urls 返回 null', extractImageUrl('yuki', { data: { title: 'T' } }) === null)

check('icatw data.url', extractImageUrl('icatw', { success: true, data: { url: 'https://x/i.jpg', source: 'xjh-acg' } }).url === 'https://x/i.jpg')
check('icatw 无 data 返回 null', extractImageUrl('icatw', {}) === null)
// 提速：有 proxyUrl 时优先用代理下载（实测比原站快 3 倍），并保留原站地址备查
{
  const r = extractImageUrl('icatw', { data: { url: 'https://img.xjh.me/a.jpg', proxyUrl: 'https://api.icatw.site/p/1', id: '1' } })
  check('icatw 优先用 proxyUrl 下载', r.url === 'https://api.icatw.site/p/1', r.url)
  check('icatw 保留原站地址', r.origin === 'https://img.xjh.me/a.jpg', r.origin)
  const r2 = extractImageUrl('icatw', { data: { url: 'https://img.xjh.me/a.jpg' } })
  check('icatw 无 proxyUrl 回退原站', r2.url === 'https://img.xjh.me/a.jpg', r2.url)
}

check('setu 取第一张 original', extractImageUrl('setu', { data: [{ urls: { original: 'https://x/o.png' }, title: 'T', author: 'A' }] }).url === 'https://x/o.png')
check('setu 空列表返回 null', extractImageUrl('setu', { data: [] }) === null)
check('setu 无 urls 返回 null', extractImageUrl('setu', { data: [{ title: 'T' }] }) === null)

// lolicon：服务端只回「请求的那一档」，urls 里只有一个键
{
  const r = extractImageUrl('lolicon', {
    error: '',
    data: [{
      pid: 115217740, title: '莱伊', author: '阿戈魔AGM', r18: false,
      tags: ['女の子', '女孩子', '欧派', 'Oppai', '明日方舟', 'Arknights', '壁纸'],
      urls: { regular: 'https://i.pixiv.re/img-master/x_p0_master1200.jpg' },
    }],
  }, 'regular')
  check('lolicon 取 urls.regular', r && r.url === 'https://i.pixiv.re/img-master/x_p0_master1200.jpg', r && r.url)
  check('lolicon meta 作者', r && r.meta.author === '阿戈魔AGM', r && r.meta.author)
  check('lolicon meta pid', r && r.meta.pid === 115217740, r && r.meta.pid)
  check('lolicon 标签最多 5 个', r && r.meta.tags.split(',').length === 5, r && r.meta.tags)

  // 只有 small 一档时也要能取到（不能因缺 regular 就失败）
  const s = extractImageUrl('lolicon', { data: [{ urls: { small: 'https://i.pixiv.re/c/540x540/x.jpg' } }] }, 'small')
  check('lolicon 取 urls.small', s && s.url === 'https://i.pixiv.re/c/540x540/x.jpg', s && s.url)

  // sizeHint 与返回档位不一致时回退到任意可用档位
  const f = extractImageUrl('lolicon', { data: [{ urls: { regular: 'https://x/r.jpg' } }] }, 'original')
  check('lolicon 档位缺失回退', f && f.url === 'https://x/r.jpg', f && f.url)

  check('lolicon 空 data 返回 null', extractImageUrl('lolicon', { error: '', data: [] }) === null)
  check('lolicon 无 data 返回 null', extractImageUrl('lolicon', {}) === null)
  check('lolicon 无 urls 返回 null', extractImageUrl('lolicon', { data: [{ title: 'T' }] }) === null)

  // 大图失败时的降级档位：同一作品的小图
  const withSmall = extractImageUrl('lolicon', {
    data: [{ urls: { regular: 'https://x/r.jpg', small: 'https://x/s.jpg' } }],
  }, 'regular')
  check('lolicon 记录小图降级档', withSmall.fallbackUrl === 'https://x/s.jpg', withSmall.fallbackUrl)
  const onlyRegular = extractImageUrl('lolicon', { data: [{ urls: { regular: 'https://x/r.jpg' } }] }, 'regular')
  check('lolicon 无小图时降级档为空', onlyRegular.fallbackUrl === '', onlyRegular.fallbackUrl)
  check('lolicon 降级档不与主档重复', withSmall.fallbackUrl !== withSmall.url)

  // 只返回一档时，用 pixiv 规则拼出小图地址做降级（实测可用：382x540 / 30KB）
  const pixivOnly = extractImageUrl('lolicon', {
    data: [{ urls: { regular: 'https://i.pixiv.re/img-master/img/x_p0_master1200.jpg' } }],
  }, 'regular')
  check('lolicon 规则拼小图', pixivOnly.fallbackUrl.indexOf('/c/540x540_70/img-master/') > 0, pixivOnly.fallbackUrl)
  check('pixivSmallUrl 转换正确', pixivSmallUrl('https://i.pixiv.re/img-master/img/a_p0.jpg') === 'https://i.pixiv.re/c/540x540_70/img-master/img/a_p0.jpg')
  check('pixivSmallUrl 非 pixiv 返回空', pixivSmallUrl('https://x.com/a.jpg') === '')
  check('pixivSmallUrl 已是小图不重复套', pixivSmallUrl('https://i.pixiv.re/c/540x540_70/img-master/img/a.jpg') === '')
}

// ===== 扩展名 =====
check('guessExt png', guessExt('https://x/a.png') === 'png')
check('guessExt jpeg→jpg', guessExt('https://x/a.jpeg') === 'jpg')
check('guessExt 无扩展默认 jpg', guessExt('https://x/abc') === 'jpg')

// ===== 服务端转码兜底（本地 ffmpeg 解不了时用）=====
{
  const src = 'https://i.pixiv.re/img-master/a_p0.jpg'
  const p = proxyResizeUrl(src)
  check('转码代理走 wsrv', p.indexOf('https://wsrv.nl/?url=') === 0, p)
  check('转码代理对原图 URL 做了编码', p.indexOf(encodeURIComponent(src)) > 0, p)
  check('转码代理输出 jpg', p.indexOf('output=jpg') > 0, p)
  check('转码代理带上目标尺寸', p.indexOf('w=960') > 0 && p.indexOf('h=900') > 0, p)
  check('转码代理不重复套娃', proxyResizeUrl(p) === p, p)
  check('转码代理空 URL 返回空串', proxyResizeUrl('') === '')
  check('转码代理支持自定义尺寸', proxyResizeUrl(src, 480, 480).indexOf('w=480') > 0)
}

// ===== 文件名 =====
check('buildFilename 含源 id', buildFilename('yuki', 'jpg').startsWith('yuki_'))
check('buildFilename 含扩展', buildFilename('yuki', 'png').endsWith('.png'))

// ===== 配置清洗 =====
const sc = sanitizeConfig('setu', { r18: '1', tag: '猫娘' })
check('sanitize 补齐缺失字段', sc.num === '1' && sc.r18 === '1' && sc.tag === '猫娘')
check('sanitize 空对象回退默认', sanitizeConfig('yuki', {}).type === 'json')

// ===== 源名 =====
check('sourceName 已知', sourceName('yuki') === 'Pixiv Yuki')
check('sourceName 未知回退 id', sourceName('xxx') === 'xxx')

// ===== 本地缓存图片命名（唯一性决定 <image> 会不会重新加载）=====
{
  const a = makeImageName('1730000000000' + '1')
  const b = makeImageName('1730000000000' + '2')
  check('图片名以 .jpg 结尾', a.endsWith('.jpg'), a)
  check('图片名带 rp_ 前缀', a.startsWith('rp_'), a)
  check('不同种子生成不同文件名', a !== b, [a, b])
  check('同名种子结果稳定', makeImageName('42') === makeImageName('42'))
  check('文件名不含路径分隔符', !a.includes('/') && !a.includes('\\'), a)
  check('文件名不含空格等非法字符', /^[A-Za-z0-9_.]+$/.test(a), a)
  check('空种子也返回合法文件名', /^rp_[A-Za-z0-9]+\.jpg$/.test(makeImageName('')), makeImageName(''))
  check('种子里的路径字符被清掉', makeImageName('../../etc/passwd') === 'rp_etcpasswd.jpg', makeImageName('../../etc/passwd'))
}


// ===== lolicon 分级：混合模式客户端交替 =====
{
  const mixed = { tag: '', r18: '2', size: 'regular' }
  // 首轮给 R18：从「全年龄」切到「混合」第一张就能看出变化
  check('混合首轮 r18=1（先给 R18）', mixR18(mixed, 0).r18 === '1')
  check('混合次轮 r18=0', mixR18(mixed, 1).r18 === '0')
  check('混合轮次循环 2→1、3→0', mixR18(mixed, 2).r18 === '1' && mixR18(mixed, 3).r18 === '0')
  check('混合不改原对象', mixed.r18 === '2')
  const sfw = { tag: '', r18: '0', size: 'regular' }
  check('全年龄不受 mixR18 影响', mixR18(sfw, 3).r18 === '0')
  const r18only = { tag: '', r18: '1', size: 'regular' }
  check('仅R18 不受 mixR18 影响', mixR18(r18only, 0).r18 === '1')
  check('mixR18 容忍空配置', mixR18(null, 1) === null)
  // 交替后构建出的 URL 必须真的换了取值
  const u0 = buildUrl('lolicon', mixR18(mixed, 0))
  const u1 = buildUrl('lolicon', mixR18(mixed, 1))
  check('混合两轮 URL 取值不同', u0.includes('r18=1') && u1.includes('r18=0'), u0 + ' / ' + u1)
}

// ===== lolicon 回传的分级字段（用来做角标 / 校验模式）=====
{
  const ex = extractImageUrl('lolicon', {
    data: [{
      pid: 1, title: 't', author: 'a', tags: ['x'], r18: true,
      urls: { regular: 'https://i.pixiv.re/img-master/img/a_p0_master1200.jpg' },
    }],
  }, 'regular')
  check('lolicon meta 带 r18=true', ex && ex.meta.r18 === true)

  const ex2 = extractImageUrl('lolicon', {
    data: [{
      pid: 2, title: 't', author: 'a', tags: ['x'], r18: false,
      urls: { regular: 'https://i.pixiv.re/img-master/img/b_p0_master1200.jpg' },
    }],
  }, 'regular')
  check('lolicon meta 带 r18=false', ex2 && ex2.meta.r18 === false)

  const ex3 = extractImageUrl('lolicon', {
    data: [{
      pid: 3, title: 't', author: 'a', tags: ['x'],
      urls: { regular: 'https://i.pixiv.re/img-master/img/c_p0_master1200.jpg' },
    }],
  }, 'regular')
  check('缺失 r18 字段按全年龄处理', ex3 && ex3.meta.r18 === false)
}


// ===== setu 缺 Key 的说明文案（图片区展示）=====
{
  const st = getSource('setu')
  check('setu 带说明文案', Array.isArray(st.notice) && st.notice.length >= 2)
  check('setu 说明含站点链接', st.notice.join(' ').indexOf('https://cloud.yukiryou.icu/') >= 0)
  check('setu 说明点明缺 Key', st.notice.join(' ').indexOf('API Key') >= 0)
  for (const id of ['yuki', 'icatw', 'lolicon']) {
    check(id + ' 没有说明文案', !getSource(id).notice)
  }
}

// ===== 落盘纯函数（persist.js）=====
{
  // base64 必须自己算（QuickJS 没有保证有 btoa），中文/emoji 都要能正确往返
  const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64')
  for (const s of ['', 'abc', '随机图片', '{"a":1}', 'emoji 🎨 ok', 'a'.repeat(5000)]) {
    check('b64enc 与标准实现一致 len=' + s.length, b64enc(s) === b64(s), b64enc(s).slice(0, 20))
  }

  // 分段：每段必须是 4 的倍数，拼回去要等于整段
  const body = 'x'.repeat(9000)
  const cmds = shellWriteCmds('/userdisk/a.json', body, 6000)
  const parts = cmds.map((c) => (/printf '%s' '([^']*)'/.exec(c) || [])[1] || '')
  check('分段数量正确', parts.length === Math.ceil(b64(body).length / 6000), parts.length)
  check('每段长度是 4 的倍数', parts.every((p) => p.length % 4 === 0), parts.map((p) => p.length))
  check('首段覆盖写、后续追加', cmds[0].indexOf(' > ') > 0 && cmds[1].indexOf(' >> ') > 0)
  check('b64 拼接还原内容', Buffer.from(parts.join(''), 'base64').toString('utf8') === body)

  check('空内容走 : > 截断', shellWriteCmds('/tmp/a', '', 6000)[0] === ": > '/tmp/a'")
  check('路径含单引号要转义', shellQuote("a'b").indexOf("'\\''") > 0)

  // 路径归一化：$dataDir 见过双斜杠
  check('normPath 合并双斜杠', normPath('/a//b//c/') === '/a/b/c')
  check('normPath 保留根', normPath('/') === '/')
  check('parentOf 正常', parentOf('/a/b/c.json') === '/a/b')
  check('parentOf 一层', parentOf('/a') === '/')

  // 配置合并：关键 bug —— 读失败不能把整份配置清空
  const old = '{"cfg_yuki":{"proxy":"i.pixiv.re"},"save_dir":"favorite"}'
  const merged = mergeCfgText(old, 'cfg_icatw', { source: '' })
  const mo = JSON.parse(merged)
  check('合并保留原有键', mo.cfg_yuki && mo.cfg_yuki.proxy === 'i.pixiv.re')
  check('合并保留 save_dir', mo.save_dir === 'favorite')
  check('合并写入新键', !!mo.cfg_icatw)

  // 坏文件（旧版本写了一半）不能让合并崩掉，仍要产出合法 JSON
  const bad = mergeCfgText('{"cfg_yuki":', 'save_dir', 'picture')
  check('坏 JSON 仍产出合法结果', (() => { try { JSON.parse(bad); return true } catch (e) { return false } })())
  check('坏 JSON 后仍写入新键', JSON.parse(bad).save_dir === 'picture')

  check('pickCfg 取到值', pickCfg(old, 'save_dir').value === 'favorite')
  check('pickCfg 缺键返回 found=false', pickCfg(old, 'nope').found === false)
  check('pickCfg 坏 JSON 不抛', pickCfg('{oops', 'a').found === false)

  // 保存判据：文件写成功才算真的成功
  check('文件成功即成功', saveVerdict(true, false).ok === true)
  check('只有镜像不算文件成功', saveVerdict(false, true).why === '仅镜像')
  check('都失败要报失败', saveVerdict(false, false).ok === false)
}

console.log('\n%d 通过, %d 失败', pass, fail)
process.exit(fail ? 1 : 0)


