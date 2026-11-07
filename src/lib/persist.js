// 落盘相关的纯函数（零平台依赖，可 Node 单测）
// 平台事实：写文件有三条通道，逐固件不同 —— fs.writeFile 可能根本不存在，
// 也可能「返回成功但不落盘」；只有 shell base64 是保底可用的那条。
// 这里只负责「把内容变成命令 / 把 JSON 合并正确」，真正的探测与重试在 native.js。

const B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// 纯 JS base64：QuickJS 不保证有 btoa / TextEncoder。
// 必须自己处理 UTF-8（中文、emoji 代理对），否则配置里的中文标签会写坏。
export function b64enc(str) {
  const s = str == null ? '' : String(str)
  const bytes = []
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < 0x80) {
      bytes.push(c)
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    } else {
      const c2 = s.charCodeAt(i + 1)
      i += 1
      const cp = 0x10000 + ((c - 0xd800) << 10) + ((c2 || 0) - 0xdc00)
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      )
    }
  }
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1
    out += B64C.charAt(b0 >> 2)
      + B64C.charAt(((b0 & 3) << 4) | ((b1 < 0 ? 0 : b1) >> 4))
      + (b1 < 0 ? '=' : B64C.charAt(((b1 & 15) << 2) | ((b2 < 0 ? 0 : b2) >> 6)))
      + (b2 < 0 ? '=' : B64C.charAt(b2 & 63))
  }
  return out
}

// 路径归一化：$dataDir 见过带双斜杠（<appid>//data/），
// 不归一化会让 a//b 与 a/b 被当成两个目录，前缀判断和缓存 key 全错。
export function normPath(p) {
  let s = String(p == null ? '' : p)
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1) s = s.replace(/\/+$/, '')
  return s
}

// 父目录（'/' 的父目录仍是 '/'）
export function parentOf(p) {
  const s = normPath(p)
  const i = s.lastIndexOf('/')
  if (i <= 0) return i === 0 ? '/' : ''
  return s.slice(0, i)
}

export function shellQuote(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'"
}

// 把一段文本写成「若干条 shell 命令」。
// 分段长度必须是 4 的倍数：base64 每 4 个字符对应 3 字节，
// 边界不落在 4 的倍数上会导致跨段拼出来的尾部字节错误。
export function shellWriteCmds(path, text, chunk) {
  const p = shellQuote(normPath(path))
  const body = text == null ? '' : String(text)
  const size = Number(chunk) || 6000
  if (!body.length) return [': > ' + p]
  const b = b64enc(body)
  const cmds = []
  for (let i = 0; i < b.length; i += size) {
    cmds.push("printf '%s' '" + b.slice(i, i + size) + "' | base64 -d " +
      (i ? '>>' : '>') + ' ' + p + ' 2>/dev/null')
  }
  return cmds
}

// 先写临时文件再 mv：中途掉电/被杀进程时，旧文件仍然完整。
// 直接原地覆盖一旦写了一半，JSON 就解析失败 —— 用户所有设置一次性丢光。
export function shellCommitCmds(path, tmpPath) {
  const p = shellQuote(normPath(path))
  const t = shellQuote(normPath(tmpPath))
  return ['mv -f ' + t + ' ' + p]
}

// 合并配置 JSON：以磁盘上现有内容为基底，只替换这一项。
// 绝对不能「读失败就当空对象」——那样每存一个键都会把其它键抹掉。
export function mergeCfgText(text, key, value) {
  let all = {}
  try {
    const o = JSON.parse(String(text == null ? '' : text))
    if (o && typeof o === 'object' && !Array.isArray(o)) all = o
  } catch (e) { all = {} }
  all[key] = value
  return JSON.stringify(all)
}

// 从 JSON 文本里取一个键；解析失败返回 { found:false }
export function pickCfg(text, key) {
  try {
    const o = JSON.parse(String(text == null ? '' : text))
    if (o && typeof o === 'object' && o[key] !== undefined) {
      return { found: true, value: o[key] }
    }
  } catch (e) { /* ignore */ }
  return { found: false, value: null }
}

// 配置项是否「本次可以视为保存成功」：文件通道成功，或镜像通道读回一致。
export function saveVerdict(fileOk, mirrorOk) {
  if (fileOk) return { ok: true, why: '' }
  if (mirrorOk) return { ok: true, why: '仅镜像' }
  return { ok: false, why: '写入失败' }
}
