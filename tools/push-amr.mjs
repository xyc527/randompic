#!/usr/bin/env node
// 构建后固定步骤：把最新 .amr 推到笔的 /userdisk，并只保留最近 N 个历史包。
//
// 用法：
//   node tools/push-amr.mjs                # 推送 + 清理（只保留 3 个版本）
//   node tools/push-amr.mjs --keep 2       # 只保留 2 个版本
//   node tools/push-amr.mjs --install      # 推完顺手装到设备并重启应用
//   node tools/push-amr.mjs --dry-run      # 只打印将要做什么，不动手
//
// 已挂到 npm 生命周期：npm run build:prod 成功后自动执行（见 package.json 的 postbuild:prod）
//
// 安全约束（都踩过坑）：
//  1) 只处理「本 appid 的版本化包」和「早期临时名 rp<数字>.amr」，其它 app 的 amr 一律不碰；
//  2) 刚推上去的那个文件永远在保留集里，即使它的版本号不是最新的（比如回滚重打包）；
//  3) 只用 rm -f 删具体文件名，不做通配删除；
//  4) 没设备时只警告不报错（否则一次断连就会把「构建成功」变成失败），要严格用 RP_STRICT=1。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const APPID = String(pkg.appid || '')
const VERSION = String(pkg.version || '')

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const argOf = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const KEEP = Math.max(1, Number(argOf('--keep', '3')) || 3)
const DRY = has('--dry-run')
const INSTALL = has('--install')
const STRICT = process.env.RP_STRICT === '1'
const REMOTE_DIR = '/userdisk'

const log = (...a) => console.log(...a)
const warn = (...a) => console.warn(...a)

function adb(args, opts = {}) {
  return execFileSync('adb', args, { encoding: 'utf8', ...opts }).replace(/\r/g, '')
}

function pickDevice() {
  let out = ''
  try { out = adb(['devices']) } catch (e) { return '' }
  const line = out.split('\n').slice(1).find((l) => /\tdevice$/.test(l.trim()))
  return line ? line.split('\t')[0].trim() : ''
}

// 本地：找最新版本号的那个 amr（按 x.y.z 数值比，不看 mtime —— 回滚重打包也不会选错）
function parseVer(name) {
  const m = new RegExp('^' + APPID + '\\.(\\d+)_(\\d+)_(\\d+)\\.amr$').exec(name)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function cmpVer(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return b[i] - a[i]
  return 0
}

const localAmrs = fs.readdirSync(ROOT)
  .map((n) => ({ name: n, ver: parseVer(n) }))
  .filter((x) => x.ver)
  .sort((a, b) => cmpVer(a.ver, b.ver))

if (!localAmrs.length) {
  warn('!! 工程根目录没有 ' + APPID + '.x_y_z.amr，先构建')
  process.exit(STRICT ? 2 : 0)
}

const latest = localAmrs[0]
const localPath = path.join(ROOT, latest.name)
log('== 本地最新包: ' + latest.name + ' (' + latest.ver.join('.') + ', ' + fs.statSync(localPath).size + ' 字节)')
if (VERSION && latest.ver.join('.') !== VERSION) {
  warn('!! 注意：包版本 ' + latest.ver.join('.') + ' 与 package.json version ' + VERSION + ' 不一致（忘了 bump？）')
}

const dev = pickDevice()
if (!dev) {
  warn('!! 未检测到设备，跳过推送。插上笔后单独跑：npm run push')
  process.exit(STRICT ? 2 : 0)
}
const adbFor = (args) => adb(['-s', dev, ...args])

// 远端清单：只看 .amr
let remoteList = []
try {
  const out = adbFor(['shell', 'ls -1 ' + REMOTE_DIR + '/*.amr 2>/dev/null'])
  remoteList = out.split('\n').map((s) => s.trim()).filter(Boolean).map((p) => path.posix.basename(p))
} catch (e) { remoteList = [] }

const legacyRe = /^rp\d+\.amr$/
// 把「即将推上去的这个」也算进清单，否则清理时按旧清单算，会多留一个（4 个而不是 KEEP 个）
const merged = remoteList.indexOf(latest.name) >= 0 ? remoteList : remoteList.concat([latest.name])
const ours = merged
  .map((n) => ({ name: n, ver: parseVer(n) }))
  .filter((x) => x.ver)
  .sort((a, b) => cmpVer(a.ver, b.ver))
const legacy = remoteList.filter((n) => legacyRe.test(n))

// 保留集：最新 KEEP 个版本化包 + 本次推送的这个（即使它版本号不最高）
const keep = new Set(ours.slice(0, KEEP).map((x) => x.name))
keep.add(latest.name)
const drop = [
  ...ours.map((x) => x.name).filter((n) => !keep.has(n)),
  ...legacy,
]

log('== 设备: ' + dev + '  远端 ' + REMOTE_DIR + ' 现有 ' + remoteList.length + ' 个 amr')
if (DRY) {
  log('== [dry-run] 将推送: ' + latest.name)
  log('== [dry-run] 将保留: ' + [...keep].join(', '))
  log('== [dry-run] 将删除: ' + (drop.length ? drop.join(', ') : '(无)'))
  process.exit(0)
}

// 1) 推送（同名覆盖，可重复执行）
log('== push -> ' + REMOTE_DIR + '/' + latest.name)
// adb push 的进度行走 stderr，这里只吞掉异常：推送结果用「远端文件是否存在」验证（下一步）
try { adbFor(['push', localPath, REMOTE_DIR + '/' + latest.name]) } catch (e) {
  warn('!! 推送失败: ' + (e && e.message ? e.message : e))
}

// 2) 清理：先确认新包真的在远端，再删旧的（顺序反了会在推送失败时把好包删光）
const after = adbFor(['shell', 'ls -1 ' + REMOTE_DIR + '/' + latest.name + ' 2>/dev/null']).trim()
if (!after) {
  warn('!! 远端没找到刚推的包，为安全起见不执行清理')
  process.exit(STRICT ? 2 : 0)
}

const targets = drop.filter((n) => n !== latest.name)
if (!targets.length) {
  log('== 清理: 无需删除（远端已有 ' + keep.size + ' 个包）')
} else {
  log('== 清理: 删除 ' + targets.length + ' 个旧包 -> ' + targets.join(', '))
  // 逐个 rm -f，不用通配符，避免误伤同目录其它文件
  for (const n of targets) {
    try { adbFor(['shell', 'rm -f ' + REMOTE_DIR + '/' + n]) } catch (e) { warn('   rm 失败: ' + n) }
  }
}

const left = adbFor(['shell', 'ls -1 ' + REMOTE_DIR + '/' + APPID + '*.amr 2>/dev/null'])
  .split('\n').map((s) => s.trim()).filter(Boolean)
log('== 留在设备上的本应用包: ' + left.join(', '))

// 3) 可选：直接装上并重启（日常验收用）
if (INSTALL) {
  log('== install')
  const r = adbFor(['shell', 'miniapp_cli install ' + REMOTE_DIR + '/' + latest.name])
  log('   ' + r.trim())
  try {
    adbFor(['shell', 'kill -9 $(pidof miniapp) 2>/dev/null; true'])
    execFileSync('sleep', ['8'])
    log('   ' + adbFor(['shell', 'miniapp_cli start ' + APPID + ' index']).trim())
    adbFor(['shell', 'miniapp_cli debugApp ' + APPID])
  } catch (e) { warn('   重启应用失败: ' + e.message) }
}
