// 平台能力桥接（唯一的平台依赖层，页面只调这里）
// 封装：storage 读写（jsapi + fs 兜底）、curl 发请求、文件读写、输入法

import fs from 'fs'
import globalModule from 'global'

const G = new globalModule.Global()

// ---- 常量 ----
// 保存目录：Picture / Favorite 都是系统本来就有的根目录，**不能重复创建**。
//  · Picture ：直接存进去，不再套子文件夹
//  · Favorite：系统收藏目录，里面再建一个 randompic 子文件夹放本应用的图
// 根目录名在各固件上大小写不一致（见过 Pictures / Picture），所以运行时按「已存在的那个」取，
// 都按候选顺序探测 —— 否则会凭空多造一个大小写不同的空目录，用户在图库/收藏里看不到图。
const PICTURE_ROOTS = ['/userdisk/Picture', '/userdisk/Pictures', '/userdisk/picture']
const FAVORITE_ROOTS = ['/userdisk/Favorite', '/userdisk/favorite']
const SAVE_SUBDIR = 'randompic'

// 目录是否存在。沿用本文件的「写标记文件再读回」模式：execShell 的返回值不可靠
export function dirExists(path) {
  const mark = '/tmp/rp_direxist.txt'
  execShell('rm -f ' + mark + '; [ -d ' + sq(path) + ' ] && echo yes > ' + mark)
  return new Promise((resolve) => {
    setTimeout(async () => resolve(trim(await readFile(mark)) === 'yes'), 250)
  })
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

// 配置文件落盘位置（storage 不可靠时的兜底）
const CFG_FILE = '/userdisk/randompic_cfg.json'

// ---- storage：jsapi 优先，fs 兜底 ----
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

// ---- 配置持久化：storage + fs 双写双读 ----
export async function loadConfig(key, fallback) {
  const v = storageGet(key)
  if (v !== null && v !== undefined) {
    try { return JSON.parse(v) } catch (e) { return fallback }
  }
  // fs 兜底（readFile 异步）
  try {
    const txt = await fs.readFile(CFG_FILE)
    if (txt) {
      const all = JSON.parse(txt)
      if (all && all[key] !== undefined) return all[key]
    }
  } catch (e) { /* ignore */ }
  return fallback
}

export function saveConfig(key, value) {
  storageSet(key, JSON.stringify(value))
  // fs 兜底写（writeFile 同步）
  try {
    let all = {}
    try { all = JSON.parse(fs.readFile(CFG_FILE) || '{}') } catch (e) { all = {} }
    all[key] = value
    fs.writeFile(CFG_FILE, JSON.stringify(all))
  } catch (e) { /* ignore */ }
}

// ---- 文件写（同步）----
export function writeFileSync(path, data) {
  try { fs.writeFile(path, data); return true } catch (e) { return false }
}

// ---- execShell + 读回 ----
export function execShell(cmd) {
  try { return G.execShell(cmd) } catch (e) { return false }
}

// fs.readFile 是异步的，必须 await
export async function readFile(path) {
  try { return await fs.readFile(path) } catch (e) { return '' }
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
function launch(scriptPath, scriptBody, args) {
  writeFileSync(scriptPath, scriptBody)
  const cmd =
    'chmod 755 ' + sq(scriptPath) + '; ' +
    'setsid sh ' + sq(scriptPath) + ' ' + args.join(' ') +
    ' </dev/null >/dev/null 2>&1 &'
  execShell(cmd)
}

// 去掉首尾空白
function trim(s) {
  return String(s || '').replace(/^\s+|\s+$/g, '')
}

// ---- HTTP：curl 拿 JSON ----
// 返回 { code, body, size }；失败 code 为 '000'
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
  launch('/tmp/rp_json.sh', script, [sq(url), sq(String(tm)), sq(bodyFile), sq(resFile), sq(doneFile)])

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

  writeFileSync(scriptFile, CONV_SCRIPT)
  try {
    execShell('rm -f ' + resFile + '; sh ' + scriptFile + ' ' +
      sq(picked) + ' ' + sq(dir) + ' ' + sq(name) + ' ' + sq(resFile))
  } catch (e) { /* ignore */ }

  const res = trim(await readFile(resFile))
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
  launch('/tmp/rp_img.sh', IMG_SCRIPT, [
    sq(url), sq(d), sq(n), sq(String(tm)),
    sq(resFile), sq(doneFile), sq(progFile),
  ])
  // 计时埋点：execShell 本身在这台设备上可能很慢（曾见 CpuProf 记录 25s），
  // 打出来才能分清「启动慢」还是「下载慢」
  console.warn('[RP] launched in ' + (Date.now() - tL0) + 'ms')

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
    return { ok: true, relName: finalName, path: dirN + '/' + finalName, size: winner.size || 0, reason: '' }
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

// 取文件 md5 前 12 位（用来判「这次下到的图是不是和上次一模一样」）
// 为什么要按内容判而不是按 URL：icatw 的接口会一直返回同一个 id / 同一个 URL，
// 但代理每次给的字节其实不同；只看 URL 会误判成「重复」，只看 URL 相等也会漏判。
export function fileMd5(path) {
  const out = '/tmp/rp_md5.txt'
  execShell("md5sum " + sq(path) + " 2>/dev/null | cut -c1-12 > " + out)
  return new Promise((resolve) => {
    setTimeout(async () => {
      resolve(trim(await readFile(out)))
    }, 400)
  })
}

// 复制文件（cp），返回是否成功
export function copyFile(src, dest) {
  const markFile = '/tmp/rp_cp.txt'
  const cmd =
    "rm -f " + markFile + "; " +
    "cp " + sq(src) + " " + sq(dest) + "; " +
    "if [ -s " + sq(dest) + " ]; then echo ok > " + markFile + "; fi"
  execShell(cmd)
  return new Promise((resolve) => {
    setTimeout(async () => {
      const mark = trim(await readFile(markFile))
      resolve(mark === 'ok')
    }, 2500)
  })
}
