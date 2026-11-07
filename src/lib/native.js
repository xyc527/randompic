// 平台能力桥接（唯一的平台依赖层，页面只调这里）
// 封装：写通道探测、storage 读写（jsapi 镜像 + fs/shell 落盘）、curl 发请求、输入法

import fs from 'fs'
import globalModule from 'global'
import {
  normPath, parentOf, shellQuote, shellWriteCmds,
} from './persist.js'

const G = new globalModule.Global()

// ==========================================================================
// 写通道：探针 + 双通道（fs 优先，shell base64 兜底）+ 写后读回
// --------------------------------------------------------------------------
// 平台事实（逐固件不同，必须探针）：
//  · 有的 4.x 固件根本没有 fs.writeFile —— 调用即 TypeError；
//  · 有的存在但「返回成功却不落盘」；
//  · 枚举 fs 的属性没用（Proxy 不可枚举）。
// 唯一判据是「真写一次 + 读回比对」。
// 这条链路不只影响配置：下载用的 shell 脚本也走同一条写通道，
// 写不下去时 setsid sh 会静默什么都不做 → 最终表现成「网络请求超时/连接异常」。
// ==========================================================================

let writeChannel = 'unknown'   // 'fs' | 'shell' | 'none'
let fsWriteErr = ''
let shWriteFail = ''
const dirsEnsured = {}

export function writeDiag() {
  return { channel: writeChannel, fsErr: fsWriteErr, shFail: shWriteFail }
}

function sh(cmd) {
  try { return G.execShell(cmd) } catch (e) { return false }
}

// fs.readFile 是异步的；null = 读不到（区别于读到空文件）
export async function readFileOrNull(path) {
  try {
    const t = await fs.readFile(path)
    return t === null || t === undefined ? '' : String(t)
  } catch (e) { return null }
}

// 关键读要给足重试：冷启动那一瞬间文件常常「还没就绪」，
// 读不到就回退旧镜像 = 重启后配置倒退。
export async function readFileRetry(path, times, gap) {
  const n = Number(times) || 3
  const g = Number(gap) || 150
  for (let i = 0; i < n; i += 1) {
    const t = await readFileOrNull(path)
    if (t !== null) return t
    await new Promise((resolve) => setTimeout(resolve, g))
  }
  return null
}

function ensureDirCached(dir) {
  const d = normPath(dir)
  if (!d || d === '/' || dirsEnsured[d]) return
  sh('mkdir -p ' + shellQuote(d) + ' 2>/dev/null')
  dirsEnsured[d] = 1
}

// shell 通道写：每段 6000 字符（4 的倍数 → 边界一定落在 3 字节整数倍上）
function shWriteFile(path, body) {
  const cmds = shellWriteCmds(path, body, 6000)
  let ok = true
  for (let i = 0; i < cmds.length; i += 1) {
    if (!sh(cmds[i])) { ok = false; break }
  }
  if (!ok && !shWriteFail) shWriteFail = String(body || '').length + 'B 分段写入返回失败'
  return ok
}

// 同步写：调用方（启动脚本、转码脚本）不能 await，所以做成同步的。
// 通道由探针决定；探针还没跑过时先试 fs，抛错立刻切 shell。
export function writeFileSync(path, data) {
  const p = normPath(path)
  const body = data == null ? '' : String(data)
  ensureDirCached(parentOf(p))
  if (writeChannel === 'shell' || writeChannel === 'none') return shWriteFile(p, body)
  try {
    fs.writeFile(p, body)
    return true
  } catch (e) {
    if (!fsWriteErr) {
      fsWriteErr = String((e && e.message) || e).slice(0, 120)
    }
    writeChannel = 'shell'
    console.warn('[RP] fs.writeFile 不可用 -> shell 通道：' + fsWriteErr)
    return shWriteFile(p, body)
  }
}

// 串行队列：同一个文件不允许并发写 + 校验，否则校验永远在比别人的内容
let writeChain = Promise.resolve()
function serial(fn) {
  const run = writeChain.then(fn, fn)
  writeChain = run.then(() => null, () => null)
  return run
}

// 写 + 读回比对（关键数据专用）
export function writeFileVerified(path, data) {
  const p = normPath(path)
  const want = data == null ? '' : String(data)
  return serial(async () => {
    if (!writeFileSync(p, want)) return { ok: false, why: '写入命令失败' }
    const got = await readFileRetry(p, 4, 150)
    if (got === null) return { ok: false, why: '写后读不到' }
    if (got === want) return { ok: true, why: '' }
    return { ok: false, why: '读回不一致(' + want.length + '/' + got.length + ')' }
  })
}

// 开工探针：只写一个小文件并读回。结果决定后续所有写入走哪条通道。
let probePromise = null
export function probeWrite() {
  if (probePromise) return probePromise
  probePromise = (async () => {
    const p = '/tmp/rp_probe_w.txt'
    const want = 'rp-probe-' + Date.now()
    // 诊断开关：/userdisk/randompic_force_shell 存在时强制走 shell 通道。
    // 用途：在「怀疑这台机器的 fs.writeFile 不可信」时一键自证（不用改代码重打包）。
    let forceShell = false
    try {
      sh('rm -f /tmp/rp_fs_flag.txt; [ -f /userdisk/randompic_force_shell ] && echo 1 > /tmp/rp_fs_flag.txt')
      forceShell = trim(await readFileRetry('/tmp/rp_fs_flag.txt', 2, 100)) === '1'
    } catch (e) { forceShell = false }
    if (forceShell) {
      fsWriteErr = '被 force_shell 开关强制跳过'
      console.warn('[RP] force shell channel by /userdisk/randompic_force_shell')
    }
    const hasWrite = !forceShell && typeof fs.writeFile === 'function'
    if (hasWrite) {
      try {
        fs.writeFile(p, want)
        const got = await readFileRetry(p, 3, 120)
        if (got === want) {
          writeChannel = 'fs'
        } else if (!fsWriteErr) {
          fsWriteErr = got === null ? '写入后读不到' : '写入内容不一致'
        }
      } catch (e) {
        fsWriteErr = String((e && e.message) || e).slice(0, 120)
      }
    } else if (!forceShell) {
      fsWriteErr = '该固件没有 fs.writeFile'
    }
    if (writeChannel !== 'fs') {
      const ok = shWriteFile('/tmp/rp_probe_s.txt', want)
      writeChannel = ok ? 'shell' : 'none'
    }
    console.warn('[RP] write channel=' + writeChannel +
      (fsWriteErr ? ' fsErr=' + fsWriteErr : '') +
      (shWriteFail ? ' shFail=' + shWriteFail : ''))
    return writeDiag()
  })()
  return probePromise
}

// ---- 常量 ----
// 保存目录：Picture / Favorite 都是系统本来就有的根目录，**不能重复创建**。
//  · Picture ：直接存进去，不再套子文件夹
//  · Favorite：系统收藏目录，里面再建一个 randompic 子文件夹放本应用的图
// 根目录名在各固件上大小写不一致（见过 Pictures / Picture），所以运行时按「已存在的那个」取，
// 都按候选顺序探测 —— 否则会凭空多造一个大小写不同的空目录，用户在图库/收藏里看不到图。
const PICTURE_ROOTS = ['/userdisk/Picture', '/userdisk/Pictures', '/userdisk/picture']
const FAVORITE_ROOTS = ['/userdisk/Favorite', '/userdisk/favorite']
const SAVE_SUBDIR = 'randompic'

// 目录是否存在。沿用本文件的「写标记文件再读回」模式：execShell 的返回值不可靠，
// 而且标记文件刚写完可能还读不到 —— 用重试而不是固定 sleep 猜。
export async function dirExists(path) {
  const mark = '/tmp/rp_direxist.txt'
  execShell('rm -f ' + mark + '; [ -d ' + sq(path) + ' ] && echo yes > ' + mark)
  const v = await readFileRetry(mark, 3, 120)
  return trim(v) === 'yes'
}

const ROOT_CACHE = {}

// 解析实际保存目录（带缓存，避免每次保存都探一遍文件系统）
export async function resolveSaveRoot(kind) {
  const k = kind === 'favorite' ? 'favorite' : 'picture'
  if (ROOT_CACHE[k]) return ROOT_CACHE[k]
  const roots = k === 'favorite' ? FAVORITE_ROOTS : PICTURE_ROOTS
  let picked = ''
  for (const root of roots) {
    if (await dirExists(root)) { picked = root; break }
  }
  if (picked) {
    if (k === 'favorite') {
      // Favorite 里要建子文件夹；Picture 不再建子目录
      const sub = picked + '/' + SAVE_SUBDIR
      ensureDir(sub)
      ROOT_CACHE[k] = sub
    } else {
      ROOT_CACHE[k] = picked
    }
  } else {
    // 一个都不存在（异常情况：系统目录被清过）→ 建首选路径
    const fallback = k === 'favorite'
      ? FAVORITE_ROOTS[0] + '/' + SAVE_SUBDIR
      : PICTURE_ROOTS[0]
    ensureDir(fallback)
    ROOT_CACHE[k] = fallback
  }
  console.warn('[RP] save root ' + k + ' = ' + ROOT_CACHE[k])
  return ROOT_CACHE[k]
}

// 应用工作目录（图片缓存放这里，和 app_icon.png 同级，<image> 才能用相对路径加载）
// 注意：$dataDir 指向 .../<appid>//data/（错位），$workspace 才是 .../<appid>/a/ 或 b/
export function getWorkspace() {
  try { return $workspace } catch (e) { return '/tmp/' }
}

// 应用数据目录
export function getDataDir() {
  try { return $dataDir } catch (e) { return '/tmp/' }
}

// ---- 配置持久化 ----
// 落盘文件是唯一的权威来源；jsapi storage 只做镜像（本机见过写进去读不回来）。
//
// 旧实现有三个会把配置「越存越少」的坑，全部修掉：
//  1) saveConfig 用同步思维调 fs.readFile（其实是异步）→ JSON.parse(Promise) 必然抛错
//     → 每次保存都从空对象开始 → 整个文件只剩最后写入的那个键。
//     实测笔上 /userdisk/randompic_cfg.json 只剩 {"save_dir":"picture"}，其它源配置全没了。
//  2) 写失败被 catch 掉 → 界面显示已保存，重启全丢。
//  3) 原地覆盖写，写一半掉电/被杀 → JSON 损坏，所有设置一次清零。
// 现在：内存快照 + 整份重写 + 先写 .tmp 再原子 mv + 写后读回比对，失败一路冒到界面。
// 文件名带 appid：同一台设备上装了两个版本（完整版 / 和谐版）时，
// 共用一个路径会让后装的那个读到前一个的设置 —— 实测和谐版一启动就显示
// 完整版选的「小图」，源列表却只有两个，状态是矛盾的。
const APPID_TAG = (function () {
  try { return String($appid || '').replace(/[^0-9a-zA-Z]/g, '') } catch (e) { return '' }
})()
const CFG_BASE = '/userdisk/randompic_cfg' + (APPID_TAG ? '_' + APPID_TAG : '') + '.json'
const CFG_FILE = CFG_BASE
const CFG_TMP = CFG_BASE + '.tmp'

let cfgAll = null          // 内存快照（只存已加载/已写入的键）
let cfgFileCorrupt = false // 读到的文件解析不了（旧版本写坏的）
let lastCfgSave = { ok: true, why: '' }

export function cfgDiag() {
  const d = writeDiag()
  return {
    file: CFG_FILE,
    corrupt: cfgFileCorrupt,
    keys: cfgAll ? Object.keys(cfgAll) : [],
    lastSave: lastCfgSave.ok ? 'ok' : lastCfgSave.why,
    channel: d.channel,
    fsErr: d.fsErr,
  }
}

// ---- storage（镜像，仅作辅助）----
export function storageSet(key, data) {
  try {
    if ($falcon && $falcon.jsapi && $falcon.jsapi.storage) {
      $falcon.jsapi.storage.setStorage({ key, data })
      return true
    }
  } catch (e) { /* ignore */ }
  return false
}

export function storageGet(key) {
  try {
    if ($falcon && $falcon.jsapi && $falcon.jsapi.storage) {
      const r = $falcon.jsapi.storage.getStorage({ key })
      if (r && r.data !== undefined && !r.error) return r.data
    }
  } catch (e) { /* ignore */ }
  return null
}

// 镜像也要读回校验：setStorage 返回正常不代表读得出来（已实测过这个分支）
function storageVerified(key, value) {
  const want = JSON.stringify(value)
  if (!storageSet(key, want)) return false
  const got = storageGet(key)
  if (got === null || got === undefined) return false
  try {
    const norm = typeof got === 'string' ? JSON.parse(got) : got
    return JSON.stringify(norm) === want
  } catch (e) { return false }
}

// 启动时整份读一次（6×250ms：冷启动那一瞬间文件常常还没就绪，
// 读不到就回退镜像会让设置倒退）。文件里没有的键才用镜像补。
export async function loadAllConfig(keys) {
  const txt = await readFileRetry(CFG_FILE, 6, 250)
  const all = {}
  if (txt !== null && txt !== '') {
    try {
      const o = JSON.parse(txt)
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const k of Object.keys(o)) all[k] = o[k]
      } else {
        cfgFileCorrupt = true
      }
    } catch (e) {
      // 旧版本留下的坏文件：保留现场不动，改用镜像/默认值，等下一次保存再覆盖
      cfgFileCorrupt = true
      console.warn('[RP] cfg 文件损坏，本次以镜像为准：' + String(e && e.message || e).slice(0, 80))
    }
  }
  let fromMirror = 0
  for (const k of keys || []) {
    if (all[k] !== undefined) continue
    const v = storageGet(k)
    if (v === null || v === undefined) continue
    try { all[k] = JSON.parse(v); fromMirror += 1 } catch (e) { /* ignore */ }
  }
  cfgAll = all
  console.warn('[RP] cfg load keys=' + Object.keys(all).length +
    ' mirror=' + fromMirror + ' corrupt=' + (cfgFileCorrupt ? 1 : 0) +
    ' file=' + (txt === null ? 'unreadable' : txt.length + 'B'))
  return all
}

// 兼容旧调用：单键读取（优先整份快照）
export async function loadConfig(key, fallback) {
  if (!cfgAll) await loadAllConfig([key])
  if (cfgAll && cfgAll[key] !== undefined) return cfgAll[key]
  return fallback
}

// 写整份配置：.tmp → mv 原子替换 → 读回比对
function writeCfgFile(text) {
  if (!writeFileSync(CFG_TMP, text)) return { ok: false, why: '写入命令失败' }
  // 同目录 rename 是原子的：要么旧文件完整，要么新文件完整，不存在「写了一半」
  const moved = execShell('mv -f ' + shellQuote(CFG_TMP) + ' ' + shellQuote(CFG_FILE))
  if (!moved) {
    // mv 不可用时退回直接写（至少不会丢已有配置）
    if (!writeFileSync(CFG_FILE, text)) return { ok: false, why: 'mv/写入均失败' }
  }
  return readFileRetry(CFG_FILE, 4, 150).then((got) => {
    if (got === null) return { ok: false, why: '写后读不到' }
    if (got === text) return { ok: true, why: '' }
    return { ok: false, why: '读回不一致(' + text.length + '/' + got.length + ')' }
  })
}

// 保存一项配置。返回 Promise<{ok, why}>：调用方必须把 false 冒到界面上。
export function saveConfig(key, value) {
  if (!cfgAll) cfgAll = {}
  cfgAll[key] = value
  const text = JSON.stringify(cfgAll)
  const mirrorOk = storageVerified(key, value)
  return serial(() => writeCfgFile(text)).then((r) => {
    const res = r.ok ? r : { ok: false, why: mirrorOk ? '' : (r.why || '写入失败') }
    // 镜像能读回时至少说明「本次会话内不会丢」，但仍要如实告诉调用方文件没写成
    lastCfgSave = { ok: r.ok, why: r.ok ? '' : (mirrorOk ? '文件未写入' : (r.why || '写入失败')) }
    if (!r.ok) {
      console.warn('[RP] cfg save FAIL key=' + key + ' why=' + lastCfgSave.why +
        ' mirror=' + (mirrorOk ? 'ok' : 'fail') + ' diag=' + JSON.stringify(writeDiag()))
    }
    return res
  })
}

// 等所有排队中的配置写入落地（页面销毁 / 退出前用）
export function flushConfig() {
  return writeChain
}

// ---- execShell ----
// 注意：这是同步阻塞调用，命令跑多久就卡多久主线程；
// 长任务必须走下面的 launch() 后台化。
export function execShell(cmd) {
  try { return G.execShell(cmd) } catch (e) { return false }
}

// 兼容旧调用：读不到返回 ''（需要区分「读不到」与「空文件」时用 readFileOrNull）
export async function readFile(path) {
  const t = await readFileOrNull(path)
  return t === null ? '' : t
}


// ---- 输入法 ----
let curUuid = null
let curOnDone = null

// 拉起输入法；onDone(text) 在用户点「完成」后回调
export function openInput(placeholder, prefill, onDone) {
  curOnDone = onDone
  curUuid = G.startTextEdit(JSON.stringify({
    inputType: 'ZhCnPreferred',
    text: prefill || '',
    placeholder: placeholder || '',
    maxlength: 200,
    enterButtonText: '完成',
  }))
  return curUuid
}

// 在 onLaunch/onLoad 时调用一次，注册回传
export function registerTextEdit() {
  try {
    G.textEditFinished.on(function (uuid, json) {
      if (uuid !== curUuid) return
      try {
        const o = JSON.parse(json)
        if (o.editConfirmed === false) return
        if (curOnDone) { const cb = curOnDone; curOnDone = null; cb(o.text || '') }
      } catch (e) { /* ignore */ }
    })
  } catch (e) { /* ignore */ }
}

// ==========================================================================
// 后台任务框架
// --------------------------------------------------------------------------
// 重要平台事实（实测）：Global.execShell 是【同步阻塞】调用，命令跑多久它就
// 卡多久主线程（日志里 `CpuProf JSAPI 25041ms: proto Global.execShell`）。
// 之前「下载期间应用卡死」就是它导致的：一次 25s 的 curl 让整个 UI 冻结 25s。
//
// 解法：把真正干活的命令写成一个 shell 脚本，用 `setsid sh ... &` 丢到后台，
// execShell 只负责「点火」立刻返回（实测 <1s），JS 侧再用异步 fs.readFile
// 轮询完成标记。这样下载 75s 期间 UI 仍然可响应、状态栏还能刷新进度。
// ==========================================================================

// 后台任务编号：每次任务用一套独立的标记文件，
// 否则「上一次任务留下的 done 标记」会让下一次任务瞬间返回旧结果
// （表现为：还没下载完就显示成功、或拿到上一张图）。
let taskSeq = 0
function nextTaskKey() {
  taskSeq += 1
  return String(Date.now()) + String(taskSeq)
}

// 把 URL / 路径塞进单引号参数（单引号本身转义为 '\''）
function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// 点火：后台执行脚本，立即返回。args 会作为位置参数传给脚本。
// 返回 false = 脚本没写下去（写通道坏了）。此时 setsid sh 会静默什么都不做，
// 调用方若还傻等完成标记，最终只会超时并报成「网络异常」—— 所以必须在这里拦住。
function launch(scriptPath, scriptBody, args) {
  if (!writeFileSync(scriptPath, scriptBody)) {
    console.warn('[RP] launch write-fail ' + scriptPath + ' diag=' + JSON.stringify(writeDiag()))
    return false
  }
  const cmd =
    'chmod 755 ' + sq(scriptPath) + '; ' +
    'setsid sh ' + sq(scriptPath) + ' ' + args.join(' ') +
    ' </dev/null >/dev/null 2>&1 &'
  const ok = execShell(cmd)
  if (!ok) console.warn('[RP] launch exec-fail ' + scriptPath)
  return !!ok
}

// 去掉首尾空白
function trim(s) {
  return String(s || '').replace(/^\s+|\s+$/g, '')
}

// ---- HTTP：curl 拿 JSON ----
// 返回 { code, body, size }；失败 code 为 '000'；本地写不了脚本时 code 为 'write-fail'
export function curlGetJson(url, timeoutMs) {
  const tm = timeoutMs || 20
  const key = nextTaskKey()
  const bodyFile = '/tmp/rp_body_' + key + '.json'
  const resFile = '/tmp/rp_res_' + key + '.txt'
  const doneFile = '/tmp/rp_done_' + key + '.txt'
  const script = [
    '#!/bin/sh',
    'URL="$1"; TM="$2"; BODY="$3"; RES="$4"; DONE="$5"',
    'CODE=$(curl -s -L -m "$TM" -D /tmp/rp_hdr.txt -o "$BODY" -w \'%{http_code}\' "$URL")',
    'SZ=$(stat -c %s "$BODY" 2>/dev/null || echo 0)',
    'echo "http=$CODE size=$SZ" > "$RES"',
    'echo done > "$DONE"',
  ].join('\n')

  console.warn('[RP] fetch url=' + url)
  const started = launch('/tmp/rp_json.sh', script, [sq(url), sq(String(tm)), sq(bodyFile), sq(resFile), sq(doneFile)])
  if (!started) {
    // 立刻返回，别让用户对着「请求中」等 28 秒再看到一句「请检查网络」
    return Promise.resolve({ code: 'write-fail', size: 0, body: '' })
  }

  const maxWait = tm * 1000 + 8000
  return new Promise((resolve) => {
    const t0 = Date.now()
    const poll = async () => {
      const done = trim(await readFile(doneFile))
      if (done === 'done') {
        const res = trim(await readFile(resFile))
        const mc = /http=(\d+)/.exec(res)
        const ms = /size=(\d+)/.exec(res)
        const body = String(await readFile(bodyFile) || '')
        resolve({
          code: mc ? mc[1] : '000',
          size: ms ? Number(ms[1]) : 0,
          body,
        })
        return
      }
      if (Date.now() - t0 >= maxWait) {
        resolve({ code: '000', size: 0, body: '' })
        return
      }
      setTimeout(poll, 300)
    }
    poll()
  })
}

// ---- 原生下载（首选通道）----
// 平台提供了 $falcon.jsapi.http.downloadFile({ url, savePath })：
//   · savePath 是「目录」，落盘文件名是该 URL 的 md5（没有扩展名）
//   · 返回 { result: '<目录>/<md5>' }
//   · 同一 URL 会命中它自己的缓存（第二次 1ms 返回）
// 实测价值极大：同一张图 curl 在应用上下文只有 ~16KB/s（后台进程被平台限速），
// 原生下载 700KB 只要 3.7s（~190KB/s），快约 10 倍。
// 注意：原生下载不做任何完整性校验，所以仍然要过同一套「严格解码 + EOI」闸门。
// 结果文件、脚本文件都带 key，因为对冲请求会同时跑多路，共用一个路径会互相覆盖。
const CONV_SCRIPT = [
  '#!/bin/sh',
  '# $1=src $2=dir $3=name $4=res',
  'SRC="$1"; DIR="$2"; NAME="$3"; RES="$4"',
  'BASE="${DIR%/}/${NAME%.*}"',
  'TMPJ="$BASE.tmp.jpg"; FINAL="$BASE.jpg"',
  'rm -f "$TMPJ"',
  'if ! /bin/ffmpeg -v error -err_detect explode -i "$SRC" \\',
  '      -vf "scale=w=\'min(iw,960)\':h=\'min(ih,900)\':force_original_aspect_ratio=decrease" \\',
  '      -y "$TMPJ" >/dev/null 2>&1; then',
  '  echo "fail decode" > "$RES"; exit 0',
  'fi',
  'if [ ! -s "$TMPJ" ]; then echo "fail noout" > "$RES"; exit 0; fi',
  'TAIL=$(tail -c 2 "$TMPJ" | od -An -tx1 | tr -d " \\n")',
  'if [ "$TAIL" != "ffd9" ]; then echo "fail eoi=$TAIL" > "$RES"; exit 0; fi',
  'mv -f "$TMPJ" "$FINAL"',
  'echo "ok 200 $(stat -c %s "$FINAL")" > "$RES"',
].join('\n')

// 返回 { ok, relName, path, size, reason }；平台没有该能力时返回 null（调用方退回 curl）
// key：本次尝试的标识，用于隔离脚本/结果文件（对冲请求会并发跑多路）
export async function downloadImageNative(url, dir, name, timeoutMs, key) {
  let api = null
  try {
    if (typeof $falcon !== 'undefined' && $falcon && $falcon.jsapi) {
      api = $falcon.jsapi.http || null
    }
  } catch (e) { api = null }
  if (!api || !api.downloadFile) return null

  const k = String(key || 'c0').replace(/[^0-9a-zA-Z]/g, '')
  const resFile = '/tmp/rp_conv_' + k + '.txt'
  const scriptFile = '/tmp/rp_conv_' + k + '.sh'
  const tmpDir = '/tmp/rp_native'
  try { execShell('mkdir -p ' + sq(tmpDir)) } catch (e) { /* ignore */ }

  // 【实测 1.3.5】downloadFileNoCache 的参数不叫 savePath —— 传 savePath 会立刻返回
  // {"error":3,"result":{"errorMessage":"savePath is empty!"}}，等于白跑一趟。
  // 所以继续用 downloadFile，改由「先量落盘文件」来判断到底有没有下成功。
  const callDl = api.downloadFile

  const tm = timeoutMs || 120000
  let picked = ''
  let raw = ''
  let errMsg = ''
  const t0 = Date.now()
  try {
    // 原生下载没有超时参数，用 Promise.race 兜一层，避免极端情况下一直等
    const r = await Promise.race([
      callDl.call(api, { url: url, savePath: tmpDir }),
      new Promise((resolve) => setTimeout(() => resolve(null), tm)),
    ])
    try { raw = r === null || r === undefined ? String(r) : JSON.stringify(r) } catch (e) { raw = String(r) }
    // ⚠️ result 不一定是路径字符串：失败时它是 { errorMessage: '...' }。
    // 旧代码直接 String() 会得到 "[object Object]" 当路径去解码 —— 这正是
    // 日志里「dl=1ms + fail decode」的来源（1ms 是因为文件根本不存在）。
    if (r && typeof r.result === 'string') {
      picked = r.result
    } else if (r && r.result && typeof r.result === 'object') {
      errMsg = String(r.result.errorMessage || r.result.message || '')
    }
    if (r && r.error !== undefined && r.error !== 0) {
      errMsg = errMsg || ('error=' + r.error)
    }
  } catch (e) {
    errMsg = 'throw:' + (e && e.message ? e.message : String(e))
    picked = ''
  }
  const dlMs = Date.now() - t0
  if (!picked) {
    console.warn('[RP] native ' + k + ' no-path in ' + dlMs + 'ms err=' + (errMsg || '-') +
      ' raw=' + String(raw).slice(0, 120))
    return null
  }

  // 【关键】先量文件再解码。
  // 平台在「下载失败」时同样会把 result 回给我们（指向它打算写、实际没写的路径），
  // 直接丢给 ffmpeg 只会得到 "fail decode" —— 和「编码不支持」长得一模一样，
  // 于是一次纯网络失败会被误判成需要服务端转码，白等一轮 wsrv（用户看到的就是
  // 「下载 → 转码重试 → 再下载 → 又转码」的来回跳）。
  const szFile = '/tmp/rp_nsz_' + k + '.txt'
  try {
    execShell('[ -s ' + sq(picked) + ' ] && stat -c %s ' + sq(picked) + ' > ' + szFile +
      ' || echo 0 > ' + szFile)
  } catch (e) { /* ignore */ }
  // fs.readFile 是异步的，stat 刚写完可能还没读到；多试两次，免得把「读不到」当成「没下到」
  let gotBytes = 0
  for (let i = 0; i < 3; i += 1) {
    const v = trim(await readFile(szFile))
    if (v !== '') { gotBytes = Number(v) || 0; break }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  console.warn('[RP] native ' + k + ' ret=' + dlMs + 'ms file=' + gotBytes + 'B' +
    (errMsg ? ' err=' + errMsg : '') + ' raw=' + String(raw).slice(0, 100))

  if (gotBytes < 512) {
    // 没拿到东西 ≠ 解不了码。清理掉残件，让调用方换个地址重试，别去触发转码兜底。
    try { execShell('rm -f ' + sq(picked)) } catch (e) { /* ignore */ }
    const finalName0 = String(name).replace(/\.\w+$/, '') + '.jpg'
    return {
      ok: false,
      relName: finalName0,
      path: String(dir).replace(/\/+$/, '') + '/' + finalName0,
      size: 0,
      reason: 'dl-fail ' + gotBytes + 'B/' + dlMs + 'ms' + (errMsg ? ' ' + errMsg : ''),
    }
  }

  if (!writeFileSync(scriptFile, CONV_SCRIPT)) {
    // 转码脚本写不下去：别再往下走（否则 res 永远为空，又被当成解码失败）
    const finalNameW = String(name).replace(/\.\w+$/, '') + '.jpg'
    return {
      ok: false,
      relName: finalNameW,
      path: String(dir).replace(/\/+$/, '') + '/' + finalNameW,
      size: 0,
      reason: 'write-fail',
    }
  }
  try {
    execShell('rm -f ' + resFile + '; sh ' + scriptFile + ' ' +
      sq(picked) + ' ' + sq(dir) + ' ' + sq(name) + ' ' + sq(resFile))
  } catch (e) { /* ignore */ }

  // execShell 是同步的，命令返回时结果文件已写好；仍给两次重试吸收 fs 缓存延迟
  const res = trim(await readFileRetry(resFile, 2, 120))

  const ok = /^ok\s/.test(res)
  const ms = /^ok\s+\d+\s+(\d+)/.exec(res)
  // 清掉临时下载文件（缓存目录会越来越大）
  try { execShell('rm -f ' + sq(picked)) } catch (e) { /* ignore */ }
  console.warn('[RP] native ' + k + ' ok=' + ok + ' dl=' + dlMs + 'ms size=' +
    (ms ? ms[1] : 0) + (ok ? '' : (' reason=' + res)))

  const finalName = String(name).replace(/\.\w+$/, '') + '.jpg'
  return {
    ok,
    relName: finalName,
    path: String(dir).replace(/\/+$/, '') + '/' + finalName,
    size: ms ? Number(ms[1]) : 0,
    reason: ok ? '' : (res || 'native-fail'),
  }
}

// ---- 图片下载 ----
// 一次调用完成「下载 → 完整性校验 → 缩放转码 → 原子发布」，只有全部通过才落最终文件。
//
// 为什么必须这么严（都是实测出来的）：
//  1) 部分图源很慢：dmoe 的 1920×1080 图约 1.25MB，本机只有 ~17KB/s，需要 ~75s。
//     旧代码 `-m 25` 必然在中途掐断，curl 却仍返回 200 + 非空文件。
//  2) 把截断的 JPEG 交给 ffmpeg 转码，缺失的下半部分色度会被填 0，
//     YUV(128,0,0) → RGB(0,255,0) —— 这就是「上半正常、下半全绿」的由来。
//  3) 旧代码用固定文件名 rp_img.jpg 原地覆盖，渲染器可能读到写了一半的文件。
//
// 因此：
//  - 严格解码：`-err_detect explode` 让 ffmpeg 对截断输入返回非 0（实测 69），
//    宁可报错也不把半张图发出去。
//  - 长度校验：curl 的 Content-Length 与实际落盘字节数必须一致。
//  - 原子发布：先写 .part/.tmp.jpg，全部校验通过后 `mv` 到最终名（同目录 rename 原子）。
//  - 唯一文件名：每次换名字，<image> 的 src 必然变化，不会命中上一次的位图缓存。
// 图片文件名由 config.js 的 makeImageName 生成（纯函数，可单测）
const IMG_SCRIPT = [
  '#!/bin/sh',
  '# $1=url $2=dir $3=name $4=timeout $5=res $6=done $7=prog',
  'URL="$1"; DIR="$2"; NAME="$3"; TM="${4:-90}"',
  'RES="$5"; DONE="$6"; PROG="$7"',
  'BASE="${DIR%/}/${NAME%.*}"',
  'PART="$BASE.part"',
  'TMPJ="$BASE.tmp.jpg"',
  'FINAL="$BASE.jpg"',
  'HDR="/tmp/rp_dlhdr_$$.txt"',
  'N=6',
  '# 进度守护：每秒把已下载字节数写出去，JS 侧轮询显示「已下载 xxx KB」',
  '# 分段下载时 PART 还不存在，改统计各分段之和，进度条才不会一直卡在 0',
  '( while [ ! -f "$DONE" ]; do',
  '    S=$(stat -c %s "$PART" 2>/dev/null || echo 0)',
  '    if [ "$S" = "0" ]; then S=$(cat /tmp/rp_pp_*.bin 2>/dev/null | wc -c); fi',
  '    echo "$S" > "$PROG"',
  '    sleep 1',
  '  done ) &',
  'i=0',
  'NOPAR=0',
  'while [ $i -lt 2 ]; do',
  '  i=$((i+1))',
  '  rm -f "$PART" "$TMPJ" /tmp/rp_pp_*.bin /tmp/rp_probe.bin',
  '  CL=""',
  '  GOT=0',
  '  # ---- 自适应分段下载 ----',
  '  # 实测（同一台设备、同一个 CDN，反复跑）：',
  '  #   连接快时并发反而更慢：单路 6.8s / 6 路 33s —— 分段要等最慢的那一段；',
  '  #   连接慢时并发明显更快：单路 12~15s / 6 路 5s。',
  '  # 所以先花 64KB 探一下当前边缘节点的真实速率：慢才分段，快就老实单连接续传。',
  '  # 另外必须先确认服务端支持 Range：dmoe 会忽略 Range 直接回 200 全量，',
  '  # 不探测就并发会把同一张图重复下 N 份。',
  '  CL=$(curl -sIL -m 12 "$URL" 2>/dev/null | grep -i "^content-length:" | tail -1 | tr -dc 0-9)',
  '  if [ -n "$CL" ] && [ "$CL" -ge 400000 ]; then',
  '    S0=$(date +%s)',
  '    PC=$(timeout -s KILL 25 curl -s -L -m 20 --speed-limit 3000 --speed-time 12 -r 0-65535 -o "$PART" -w \'%{http_code}\' "$URL" 2>/dev/null)',
  '    S1=$(date +%s)',
  '    PS=$(stat -c %s "$PART" 2>/dev/null || echo 0)',
  '    if [ "$PC" = "206" ] && [ "$PS" = "65536" ]; then',
  '      DT=$((S1 - S0)); [ "$DT" -lt 1 ] && DT=1',
  '      RATE=$((65536 / DT))',
  '      if [ "$RATE" -lt 60000 ] && [ "$NOPAR" = "0" ]; then',
  '        # 慢连接：剩余部分切 N 段并发；分开写再按序拼接（并发 append 会串字节）',
  '        SZ=$(((CL - 65536) / N))',
  '        PIDS=""',
  '        j=0',
  '        while [ $j -lt $N ]; do',
  '          S=$((65536 + j * SZ)); E=$((S + SZ - 1))',
  '          [ $j -eq $((N - 1)) ] && E=$((CL - 1))',
  '          ( timeout -s KILL $((TM + 15)) curl -s -L -m "$TM" --speed-limit 3000 --speed-time 15 -r $S-$E -o /tmp/rp_pp_$j.bin "$URL" ) &',
  '          PIDS="$PIDS $!"',
  '          j=$((j+1))',
  '        done',
  '        # 只等这些下载进程：直接 `wait` 会把进度守护进程一起等住（它要等 DONE 才退，必然死锁）',
  '        for p in $PIDS; do wait $p; done',
  '        # 任一段大小不符就整体作废、退回单连接：宁慢勿错',
  '        OK=1; j=0',
  '        while [ $j -lt $N ]; do',
  '          S=$((65536 + j * SZ)); E=$((S + SZ - 1))',
  '          [ $j -eq $((N - 1)) ] && E=$((CL - 1))',
  '          EXP=$((E - S + 1))',
  '          GS=$(stat -c %s /tmp/rp_pp_$j.bin 2>/dev/null || echo 0)',
  '          [ "$GS" = "$EXP" ] || OK=0',
  '          j=$((j+1))',
  '        done',
  '        if [ "$OK" = "1" ]; then',
  '          cat /tmp/rp_pp_0.bin /tmp/rp_pp_1.bin /tmp/rp_pp_2.bin /tmp/rp_pp_3.bin /tmp/rp_pp_4.bin /tmp/rp_pp_5.bin >> "$PART" 2>/dev/null',
  '          GOT=1; CODE=206',
  '        else',
  '          # 并发不可靠，第二次尝试直接走单连接，避免最坏情况把超时叠满',
  '          NOPAR=1',
  '        fi',
  '      else',
  '        # 快连接：直接续传剩下的部分，已下的 64KB 不浪费',
  '        timeout -s KILL $((TM + 15)) curl -s -L -m "$TM" --speed-limit 3000 --speed-time 15 -r 65536- "$URL" >> "$PART" 2>/dev/null',
  '        S3=$(stat -c %s "$PART" 2>/dev/null || echo 0)',
  '        if [ "$S3" -gt 65536 ]; then GOT=1; CODE=206; fi',
  '      fi',
  '    fi',
  '  fi',
  '  if [ "$GOT" != "1" ]; then',
  '    CODE=$(timeout -s KILL $((TM + 15)) curl -s -L -m "$TM" --speed-limit 3000 --speed-time 15 -D "$HDR" -o "$PART" -w \'%{http_code}\' "$URL")',
  '    if [ "$CODE" != "200" ]; then echo "fail http=$CODE" > "$RES"; continue; fi',
  '    # 单连接必须以「本次响应」的 Content-Length 为准：',
  '    # 像 dmoe/random.php 这种 302 每次跳到不同图的地址，HEAD 拿到的长度属于另一张图，',
  '    # 拿它做校验会把好图判成 fail short（实测 1022532 vs 784913）',
  '    CL2=$(grep -i "^content-length:" "$HDR" 2>/dev/null | tail -1 | tr -dc 0-9)',
  '    if [ -n "$CL2" ]; then CL="$CL2"; fi',
  '  fi',
  '  SZ2=$(stat -c %s "$PART" 2>/dev/null || echo 0)',
  '  if [ "$SZ2" -lt 1024 ]; then echo "fail tiny $SZ2" > "$RES"; continue; fi',
  '  # 长度校验：分段/单连接都必须与 Content-Length 一致，否则就是半张图（绿屏来源）',
  '  if [ -n "$CL" ] && [ "$SZ2" != "$CL" ]; then echo "fail short $SZ2/$CL" > "$RES"; continue; fi',
  '  # 严格解码 + 限制尺寸（宽<=960 高<=900，小图不放大，保持比例）',
  '  # 超大图（实测 5000x7000）在这里被缩到 643x900，原生解码器不会超限',
  '  if ! /bin/ffmpeg -v error -err_detect explode -i "$PART" \\',
  '        -vf "scale=w=\'min(iw,960)\':h=\'min(ih,900)\':force_original_aspect_ratio=decrease" \\',
  '        -y "$TMPJ" >/dev/null 2>&1; then',
  '    echo "fail decode" > "$RES"; continue',
  '  fi',
  '  if [ ! -s "$TMPJ" ]; then echo "fail noout" > "$RES"; continue; fi',
  '  TAIL=$(tail -c 2 "$TMPJ" | od -An -tx1 | tr -d " \\n")',
  '  if [ "$TAIL" != "ffd9" ]; then echo "fail eoi=$TAIL" > "$RES"; continue; fi',
  '  mv -f "$TMPJ" "$FINAL"',
  '  FSZ=$(stat -c %s "$FINAL" 2>/dev/null || echo 0)',
  '  echo "ok $CODE $FSZ" > "$RES"',
  '  break',
  'done',
  'rm -f "$PART" "$TMPJ" "$HDR" /tmp/rp_pp_*.bin /tmp/rp_probe.bin',
  'echo done > "$DONE"',
].join('\n')

// 返回 { ok, relName, path, size, reason }
// onProgress(kb) 可选，每秒回调一次已下载字节数
export function downloadImage(url, dir, name, timeoutMs, onProgress) {
  const tm = timeoutMs || 90
  const d = String(dir).replace(/\/+$/, '')
  const n = String(name).replace(/\.\w+$/, '') + '.jpg'
  const finalPath = d + '/' + n
  const key = nextTaskKey()
  const resFile = '/tmp/rp_dres_' + key + '.txt'
  const doneFile = '/tmp/rp_ddone_' + key + '.txt'
  const progFile = '/tmp/rp_dprog_' + key + '.txt'

  console.warn('[RP] dl ' + url + ' -> ' + finalPath)
  const tL0 = Date.now()
  const started = launch('/tmp/rp_img.sh', IMG_SCRIPT, [
    sq(url), sq(d), sq(n), sq(String(tm)),
    sq(resFile), sq(doneFile), sq(progFile),
  ])
  // 计时埋点：execShell 本身在这台设备上可能很慢（曾见 CpuProf 记录 25s），
  // 打出来才能分清「启动慢」还是「下载慢」
  console.warn('[RP] launched in ' + (Date.now() - tL0) + 'ms')
  if (!started) {
    // 脚本没落地时后台什么都不会发生，等下去只会得到一句「timeout」，
    // 再被上层当成网络问题。直接给出真实原因。
    return Promise.resolve({
      ok: false, relName: n, path: finalPath, size: 0, reason: 'write-fail',
    })
  }

  // 两次尝试 + 每次 tm 秒，留足余量（并发探测/回退会多花几秒）
  const maxWait = tm * 2 * 1000 + 60000
  return new Promise((resolve) => {
    const t0 = Date.now()
    let firstBytes = 0
    let lastBytes = -1
    const poll = async () => {
      const done = trim(await readFile(doneFile))
      if (done === 'done') {
        console.warn('[RP] dl done in ' + (Date.now() - tL0) + 'ms, first-bytes at ' + firstBytes + 'ms')
        const res = trim(await readFile(resFile))
        const ok = /^ok\s/.test(res)
        const ms = /^ok\s+\d+\s+(\d+)/.exec(res)
        resolve({
          ok,
          relName: n,
          path: finalPath,
          size: ms ? Number(ms[1]) : 0,
          reason: ok ? '' : (res || 'unknown'),
        })
        return
      }
      if (Date.now() - t0 >= maxWait) {
        console.warn('[RP] dl timeout at ' + (Date.now() - tL0) + 'ms, bytes=' + lastBytes)
        resolve({ ok: false, relName: n, path: finalPath, size: 0, reason: 'timeout' })
        return
      }
      if (onProgress) {
        const p = trim(await readFile(progFile))
        const bytes = Number(p)
        if (bytes > 0 && !firstBytes) firstBytes = Date.now() - tL0
        if (bytes > 0) lastBytes = bytes
        if (bytes > 0) onProgress(Math.round(bytes / 1024))
      }
      setTimeout(poll, 500)
    }
    poll()
  })
}

// 统一取图入口：原生 downloadFile 优先（带对冲请求），失败再退 curl。
//
// 为什么兜底也要走这里：换小图、转码这两级兜底原先直接调 downloadImage（curl），
// 而 curl 在这台设备上只有 ~17KB/s（应用进程派生的子进程被限速），
// 于是一次兜底又要等 40s 以上；原生通道是它的 10 倍，兜底没理由用慢的那条。
//
// 为什么要对冲：
//  · 慢：同一张图的原生下载实测 8s 也有 111s 也有（平台下载器单连接偶发卡住）；
//  · 快失败：平台下载器还会「秒失败」—— 0~7ms 就返回一个并不存在的路径（见 downloadImageNative）。
// 所以第二路不能傻等 12s：第一路一旦失败就立刻补发；第一路成功则**取消**第二路
// （旧实现会留下一个 12s 后才触发的孤儿请求，既浪费流量，又会和下一次取图抢下载器）。
//
// opts: { onProgress, nativeTimeout, curlTimeout, hedgeMs, nativeOnly }
export async function fetchImage(url, dir, name, opts) {
  const o = opts || {}
  const dirN = String(dir).replace(/\/+$/, '')
  const base = String(name).replace(/\.\w+$/, '')
  const finalName = base + '.jpg'
  const hedgeMs = o.hedgeMs === undefined ? 12000 : o.hedgeMs

  const results = []
  const run = async (u, key) => {
    const r = await downloadImageNative(u, dir, base + '_' + key, o.nativeTimeout || 120000, key)
    const v = r || { ok: false, key: key, reason: 'no-api' }
    v.key = key
    results.push(v)
    return v
  }
  const bust = (u) => u + (u.indexOf('?') >= 0 ? '&' : '?') + '_rp=' + Date.now()

  let settled = false
  let hedgeTimer = null
  const c1 = run(url, 'c1')

  const c2 = new Promise((resolve) => {
    if (o.nativeOnly) { resolve(null); return }
    let fired = false
    const fire = () => {
      if (fired) return
      fired = true
      if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null }
      if (settled) { resolve(null); return }
      run(bust(url), 'c2').then(resolve)
    }
    hedgeTimer = setTimeout(fire, hedgeMs)
    c1.then((r) => { if (!r || !r.ok) fire() })
  })

  const runners = o.nativeOnly ? [c1] : [c1, c2]
  const winner = await new Promise((resolve) => {
    let left = runners.length
    runners.forEach((p) => p.then((r) => {
      if (r && r.ok) { settled = true; resolve(r); return }
      left -= 1
      if (left === 0) resolve(null)
    }))
  })
  if (hedgeTimer) { clearTimeout(hedgeTimer); hedgeTimer = null }

  if (winner) {
    // 发布成最终文件名：调用方（和 <image>）只认 dir/name.jpg
    try {
      execShell('mv -f ' + sq(dirN + '/' + winner.relName) + ' ' + sq(dirN + '/' + finalName))
      // 清掉另一路可能已落盘的残件 + 转码临时文件（不阻塞）
      const junk = ['_c1.jpg', '_c2.jpg', '_c1.tmp.jpg', '_c2.tmp.jpg']
        .map((s) => sq(dirN + '/' + base + s)).join(' ')
      execShell('rm -f ' + junk)
    } catch (e) { /* ignore */ }
    // 发布后必须落到最终名上：mv 失败（或对冲那路的文件已被清掉）时，
    // 上层会以为成功、<image> 却拿到一个不存在的 src —— 用户看到的是「空白 + 已获取」。
    const fin = await fileSize(dirN + '/' + finalName)
    if (fin <= 0) {
      console.warn('[RP] publish-fail ' + finalName + ' size=' + fin)
      return { ok: false, relName: finalName, path: dirN + '/' + finalName, size: 0, reason: 'publish-fail' }
    }
    return { ok: true, relName: finalName, path: dirN + '/' + finalName, size: fin, reason: '' }
  }

  // 都失败时把「更能说明问题」的原因带回去：
  // 转码兜底是靠 /decode|eoi/ 触发的，若被 'native-fail' 盖掉就永远不会触发
  const pick = (r) => (r && r.ok === false && /decode|eoi/i.test(String(r.reason)) ? r : null)

  // 直连源（每次请求都是一个随机地址）：失败就赶紧回去换一个新地址，
  // 比拿同一个 404 地址再走一遍慢速 curl 划算得多。平台没有原生能力时仍走 curl。
  const noApi = results.every((r) => !r || r.reason === 'no-api')
  if (o.noCurl && !noApi) {
    console.warn('[RP] native failed, skip curl -> retry new url')
    return results.map(pick).filter(Boolean)[0] || results[0] || null
  }

  console.warn('[RP] native all failed (' +
    results.map((r) => r.key + ':' + r.reason).join(' | ') + ') -> curl')
  const curl = await downloadImage(url, dir, name, o.curlTimeout || 90, o.onProgress)
  if (curl && curl.ok) return curl

  return pick(curl) || results.map(pick).filter(Boolean)[0] || curl || results[0] || null
}

// 清理旧图：只保留最近 keep 张 rp_*.jpg，避免包目录越堆越多
export function pruneImages(dir, keep) {
  const d = sq(String(dir).replace(/\/+$/, ''))
  const n = Number(keep) || 6
  const cmd =
    'cd ' + d + ' 2>/dev/null && ' +
    'ls -t rp_*.jpg 2>/dev/null | tail -n +' + (n + 1) +
    ' | while read f; do rm -f "$f"; done'
  execShell(cmd)
}

// 清掉下载/转码中途产生的垃圾（.part、.tmp.jpg、对冲请求的 _c1/_c2 文件）
// 只在启动时调用：那时不可能有正在进行的转码，删了不会误伤
export function sweepTemp(dir) {
  const d = sq(String(dir).replace(/\/+$/, ''))
  execShell('cd ' + d + ' 2>/dev/null && rm -f rp_*.part rp_*.tmp.jpg rp_*_c1.jpg rp_*_c2.jpg 2>/dev/null; true')
}

// 判断文件存在且非空（通过 execShell 写标记再读回）
function fileExists(path) {
  const markFile = '/tmp/rp_fexist.txt'
  const p = sq(path)
  execShell("[ -s " + p + " ] && echo yes > " + markFile + " || echo no > " + markFile)
  return new Promise((resolve) => {
    setTimeout(async () => {
      const mark = trim(await readFile(markFile))
      resolve(mark === 'yes')
    }, 300)
  })
}

// 确保目录存在
export function ensureDir(path) {
  execShell("mkdir -p " + sq(path))
}

// 文件字节数（<0 表示读不到）
export function fileSize(path) {
  const out = '/tmp/rp_size.txt'
  execShell('[ -f ' + sq(path) + ' ] && stat -c %s ' + sq(path) + ' > ' + out + ' || echo -1 > ' + out)
  return readFileRetry(out, 3, 120).then((t) => {
    const v = trim(t)
    return v === '' ? -1 : Number(v)
  })
}

// 取文件 md5 前 12 位（用来判「这次下到的图是不是和上次一模一样」）
// 为什么要按内容判而不是按 URL：icatw 的接口会一直返回同一个 id / 同一个 URL，
// 但代理每次给的字节其实不同；只看 URL 会误判成「重复」，只看 URL 相等也会漏判。
export function fileMd5(path) {
  const out = '/tmp/rp_md5.txt'
  execShell('rm -f ' + out + '; md5sum ' + sq(path) + ' 2>/dev/null | cut -c1-12 > ' + out)
  return readFileRetry(out, 3, 120).then((t) => trim(t))
}

// 复制文件（cp）。判据是「目标文件真的有内容」，不是「cp 命令发出去了」：
// 旧实现只等固定 2.5s 再读一个标记，目标没写出来也照样返回 ok。
export function copyFile(src, dest) {
  const markFile = '/tmp/rp_cp.txt'
  const cmd =
    'rm -f ' + markFile + '; ' +
    'cp ' + sq(src) + ' ' + sq(dest) + '; ' +
    'if [ -s ' + sq(dest) + ' ]; then stat -c %s ' + sq(dest) + ' > ' + markFile + '; fi'
  execShell(cmd)
  return readFileRetry(markFile, 10, 200).then((t) => {
    const n = Number(trim(t))
    return !!n && n > 0
  })
}

