<template>
  <div class="root">
    <!-- 顶栏：标题 + 源切换 -->
    <div class="topbar">
      <text class="title">随机图片</text>
      <div class="tabs">
        <div
          v-for="sid in sourceIds"
          :key="sid"
          class="tab"
          :class="tabClass(sid)"
          @click="switchSource(sid)"
        >
          <text class="tab-text">{{ shortName(sid) }}</text>
        </div>
      </div>
    </div>

    <!-- 主体：左图右配置 -->
    <div class="body">
      <!-- 左栏：图片显示 -->
      <div class="left">
        <div class="img-box" @click="openFullscreen">
          <!-- 源说明（如 setu 缺 API Key）优先于通用占位文案 -->
          <div v-if="!imgUrl && noticeLines.length" class="img-notice">
            <text
              v-for="(ln, i) in noticeLines"
              :key="'nt' + i"
              class="notice-line"
            >{{ ln }}</text>
          </div>
          <!-- 无图占位 -->
          <text v-if="!imgUrl && !loading && !noticeLines.length" class="img-placeholder">{{ imgHint }}</text>
          <!-- 加载中：下载完成但图片还在解码渲染时保持显示，避免用户误以为卡死 -->
          <text v-if="loading" class="loading-text">加载中...</text>
          <!-- 图片直接显示（contain 看全图）；点击图片放大全屏 -->
          <!-- @load 解码完成后解除 loading；@error 失败也解除，避免卡死在加载中 -->
          <!-- :key 绑到 src 上：每次换新文件名就强制重建原生视图，
               彻底避免「同一个 image 节点沿用上一次的位图/纹理」导致的花屏 -->
          <image
            v-if="imgUrl"
            :key="imgUrl"
            class="img"
            :src="imgUrl"
            resize="contain"
            @load="onImgLoad"
            @error="onImgError"
          />
        </div>
        <text v-if="imgMeta" class="meta-text">{{ imgMeta }}</text>
      </div>

      <!-- 右栏：字段配置 + 操作 -->
      <div class="right">
        <scroller class="fields" scroll-direction="vertical">
          <div
            v-for="f in fields"
            :key="f.key"
            class="field-row"
          >
            <text class="field-label">{{ f.label }}</text>
            <!-- select 字段：预选下拉 -->
            <div v-if="f.type === 'select'" class="select-box">
              <div
                v-for="o in f.options"
                :key="o.value"
                class="opt"
                :class="optClass(f.key, o.value)"
                @click="pickOption(f.key, o.value)"
              >
                <text class="opt-text">{{ o.label }}</text>
              </div>
            </div>
            <!-- input 字段：点一下拉起输入法 -->
            <div v-else class="input-box" @click="editField(f.key)">
              <text class="input-value">{{ curCfg[f.key] || '（点按输入）' }}</text>
            </div>
          </div>
        </scroller>

        <!-- 操作按钮 -->
        <div class="actions">
          <div class="btn btn-main" @click="fetchImage">
            <text class="btn-text">获取图片</text>
          </div>
          <div class="btn btn-sub" @click="download">
            <text class="btn-text">保存</text>
          </div>
          <div class="btn btn-sub" @click="toggleSaveDir">
            <text class="btn-text">存到:{{ saveDirName }}</text>
          </div>
        </div>

        <!-- 状态栏 -->
        <text v-if="status" class="status">{{ status }}</text>
      </div>
    </div>

    <!-- 全屏大图覆盖层：点击图片放大，点空白处返回；可继续放大/缩小（最大 8 倍）并拖动查看 -->
    <div v-if="fullscreen" class="fullscreen-layer">
      <!-- 工具条单独一层：点这里不触发「点任意处返回」 -->
      <div class="fs-bar">
        <text class="fs-zoom-text">缩放 {{ fsZoomText }}</text>
        <div class="fs-btns">
          <div class="fs-btn" :class="fsCanOut ? 'fs-btn-on' : 'fs-btn-off'" @click="zoomOut">
            <text class="fs-btn-text">缩小</text>
          </div>
          <div class="fs-btn" :class="fsCanIn ? 'fs-btn-on' : 'fs-btn-off'" @click="zoomIn">
            <text class="fs-btn-text">放大</text>
          </div>
          <div class="fs-btn fs-btn-reset" @click="zoomReset">
            <text class="fs-btn-text">复位</text>
          </div>
          <div class="fs-btn fs-btn-close" @click="closeFullscreen">
            <text class="fs-btn-text">关闭</text>
          </div>
        </div>
      </div>
      <!-- 舞台：拖动移动画面，轻点空白处返回 -->
      <div class="fs-stage" @click="onStageClick">
        <div
          class="fs-canvas"
          :style="fsCanvasStyle"
          @touchstart="onFsTouchStart"
          @touchmove="onFsTouchMove"
          @touchend="onFsTouchEnd"
          @touchcancel="onFsTouchEnd"
        >
          <!-- 与左栏缩略图绑定同一份 imgUrl，并同样用 :key 绑定：
               两处永远指向同一个磁盘文件，不会出现「点开的大图和缩略图不是同一张」 -->
          <image
            v-if="imgUrl"
            :key="'fs_' + imgUrl"
            class="fullscreen-img"
            :src="imgUrl"
            resize="contain"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import {
  SOURCE_IDS, getSource, sourceFields, defaultConfig, isInputField,
} from '@/lib/sources.js'
import {
  buildUrl, extractImageUrl, buildFilename, guessExt, sanitizeConfig, makeImageName,
  proxyResizeUrl, mixR18,
} from '@/lib/config.js'
import {
  loadConfig, saveConfig, openInput, registerTextEdit,
  curlGetJson, fetchImage as fetchImageFile, copyFile, getWorkspace,
  pruneImages, fileMd5, resolveSaveRoot, sweepTemp,
} from '@/lib/native.js'

// 原生下载没有进度回调，长时间没反应时界面会像卡死。
// 用秒数计时先给点反馈；一旦 curl 通道开始报 KB 进度，就让它接管。
function pacedStatus(view, label) {
  const t0 = Date.now()
  const st = { last: 0 }
  st.timer = setInterval(() => {
    if (Date.now() - st.last < 1200) return
    view.status = label + ' ' + Math.round((Date.now() - t0) / 1000) + 's'
  }, 1000)
  st.progress = (kb) => { st.last = Date.now(); view.status = '下载中 ' + kb + ' KB' }
  st.stop = () => clearInterval(st.timer)
  return st
}

// ---- 全屏缩放 ----
// 平台只支持 2D transform、没有 transition（见 skill 的 weex-css-limits 清单），
// 所以「放大/缩小」用 transform: translate(...) scale(...) 实现，平滑靠定时器分帧补间。
// 档位固定成等差数列，避免连续乘 1.5 出现 150% / 225% 这种难读的数字。
const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8]
const ZOOM_MAX = 8
const FS_W = 936
const FS_H = 244

// 触摸点坐标：Weex 的 touch 事件挂在 changedTouches/touches[0] 上，字段是 pageX/pageY
function touchPoint(e) {
  const list = e && (e.changedTouches || e.touches)
  const t = (list && list.length) ? list[0] : (e || {})
  const px = t.pageX !== undefined ? t.pageX : (t.clientX !== undefined ? t.clientX : t.x)
  const py = t.pageY !== undefined ? t.pageY : (t.clientY !== undefined ? t.clientY : t.y)
  return { x: Number(px) || 0, y: Number(py) || 0 }
}

export default {
  name: 'index',
  data() {
    return {
      sourceIds: SOURCE_IDS,
      // 单一状态字段：当前源
      curSource: 'yuki',
      // 各源配置缓存
      cfgMap: {},
      // 当前配置（派生）
      curCfg: sanitizeConfig('yuki', {}),
      // 图片状态
      imgUrl: '',
      imgMeta: '',
      imgHint: '点击「获取图片」开始',
      loading: false,
      // 请求进行中（下载/校验），用来挡住重复点击；与 loading（解码中）分开
      busy: false,
      // 每次获取的序号，参与图片文件名，保证 src 每次都变
      seq: 0,
      // 上一张图的文件内容 md5，用来判断「这次是不是又是同一张」
      lastHash: '',
      status: '',
      // 拖动查看画布尺寸（图片按原始宽高显示，超出可视区可拖动）
      imgViewW: 1088,
      imgViewH: 612,
      // 远程原图地址 + 本地临时路径
      remoteUrl: '',
      localImgPath: '',
      // 下载目录：picture / favorite
      saveDir: 'picture',
      // lolicon「混合」模式的轮次：偶数轮 r18=0、奇数轮 r18=1，
      // 保证混合拿到的是真的 1:1，而不是服务端按池子大小随机（那样基本全是全年龄）
      mixSeq: 0,
      // 全屏看图模式
      fullscreen: false,
      // 全屏缩放：1~8 倍；fsX/fsY 是拖动位移（屏幕像素，已按缩放比例夹取）
      fsScale: 1,
      fsX: 0,
      fsY: 0,
      // 缩放补间定时器 / 本次拖动起点 / 本次触摸是否已经构成「拖动」
      fsTimer: null,
      fsDrag: null,
      fsSuppress: false,
      // 输入法当前编辑的字段
      editingKey: '',
    }
  },

  computed: {
    fields() {
      return sourceFields(this.curSource)
    },
    saveDirName() {
      return this.saveDir === 'picture' ? 'Picture' : 'Favorite'
    },
    // 当前源的说明文字（目前只有 setu 有：缺 API Key 用不了）
    noticeLines() {
      const s = getSource(this.curSource)
      return s && Array.isArray(s.notice) ? s.notice : []
    },
    fsZoomText() {
      return Math.round(this.fsScale * 100) + '%'
    },
    fsCanIn() {
      return this.fsScale < ZOOM_MAX - 0.001
    },
    fsCanOut() {
      return this.fsScale > 1.001
    },
    // 用 transform 缩放：容器布局尺寸不变（仍是 936×244），视觉上放大 8 倍也不会把页面撑开，
    // 超出部分由舞台的 overflow 裁掉。translate 写在 scale 前面 = 位移按屏幕像素算，符合拖动手感。
    fsCanvasStyle() {
      return {
        width: FS_W + 'px',
        height: FS_H + 'px',
        transform: 'translate(' + this.fsX + 'px, ' + this.fsY + 'px) scale(' + this.fsScale + ')',
        transformOrigin: 'center center',
      }
    },
  },

  created() {
    registerTextEdit()
    // 启动即清理上一轮遗留：临时文件全删，上一轮缓存的图只留最近 2 张
    // （不点「保存」的图都只是临时缓存，不该长期占着包目录）
    try {
      sweepTemp(getWorkspace())
      pruneImages(getWorkspace(), 2)
    } catch (e) { /* 清理失败不影响主流程 */ }
    // 读回持久化配置（异步）
    this.loadAll().then(() => {
      this.applySource(this.curSource)
    })
  },

  beforeDestroy() {
    // 页面销毁时把补间定时器收掉，避免它在后台继续改已卸载页面的状态
    this.stopFsAnim()
  },

  methods: {
    // ---- 配置加载/保存 ----
    async loadAll() {
      const map = {}
      for (const sid of SOURCE_IDS) {
        map[sid] = sanitizeConfig(sid, await loadConfig('cfg_' + sid, defaultConfig(sid)))
      }
      const savedDir = await loadConfig('save_dir', 'picture')
      this.cfgMap = map
      this.saveDir = savedDir === 'favorite' ? 'favorite' : 'picture'
    },

    persist() {
      for (const sid of SOURCE_IDS) {
        saveConfig('cfg_' + sid, this.cfgMap[sid])
      }
      saveConfig('save_dir', this.saveDir)
    },

    applySource(sid) {
      this.curSource = sid
      this.curCfg = this.cfgMap[sid] || sanitizeConfig(sid, defaultConfig(sid))
    },

    // ---- 源切换 ----
    switchSource(sid) {
      if (sid === this.curSource) return
      this.applySource(sid)
      // 切源清空当前图
      this.imgUrl = ''
      this.imgMeta = ''
      this.remoteUrl = ''
      this.localImgPath = ''
      this.imgHint = '点击「获取图片」开始'
      this.status = ''
      this.loading = false
      this.busy = false
    },

    shortName(sid) {
      const m = { yuki: 'Yuki', icatw: 'Gateway', setu: 'Setu', lolicon: 'Lolicon' }
      return m[sid] || sid
    },

    tabClass(sid) {
      return sid === this.curSource ? 'tab tab-on' : 'tab'
    },

    // ---- 字段配置 ----
    optClass(key, val) {
      return this.curCfg[key] === val ? 'opt opt-on' : 'opt'
    },

    pickOption(key, val) {
      this.curCfg = Object.assign({}, this.curCfg, { [key]: val })
      this.cfgMap[this.curSource] = this.curCfg
      this.persist()
      this.status = ''
    },

    editField(key) {
      if (!isInputField(this.curSource, key)) return
      this.editingKey = key
      const prefill = this.curCfg[key] || ''
      openInput('请输入', prefill, (text) => {
        this.curCfg = Object.assign({}, this.curCfg, { [key]: text })
        this.cfgMap[this.curSource] = this.curCfg
        this.persist()
        this.status = ''
      })
    },

    // ---- 获取图片 ----
    // 全流程：请求 JSON → 解析地址 → 下载(后台) → 严格校验+缩放+原子发布 → 换 src 显示
    // 关键：整个下载过程不再阻塞主线程（execShell 后台化），状态栏实时显示已下载字节数
    async fetchImage() {
      if (this.busy) return
      this.busy = true
      this.loading = true
      this.status = '请求中...'
      this.imgHint = ''

      // 判重按「内容 md5」而不是 URL：
      //  - yuki 会连续返回同一个 PID（URL 相同 → 图相同）
      //  - icatw 会一直返回同一个 id/URL，但代理每次给的字节不同（URL 相同 → 图不同）
      // 所以只有比对落盘文件的 md5，才能同时覆盖这两种情况。
      let ex = null
      let dl = null
      let hash = ''
      let reqBody = ''
      let lastErr = ''
      let fallback = null
      // 服务端转码整个取图过程最多做一次：它是最后兜底且慢（冷缓存 20~35s），
      // 每轮都做一遍就会变成「下载 → 转码 → 再下载 → 又转码」的来回跳
      let transcoded = false

      // 实际生效的配置：lolicon 选「混合」时由客户端交替 0/1，
      // 一次抓取内固定用同一个值（重试轮次不翻面，否则同一张图会跨模式重下）
      const effCfg = this.curSource === 'lolicon' ? mixR18(this.curCfg, this.mixSeq) : this.curCfg
      if (this.curSource === 'lolicon' && this.curCfg.r18 === '2') this.mixSeq += 1

      // 直连源（目前只有 icatw 的非网关选项）：URL 本身就是图片，省掉一次 JSON 往返，
      // 也顺带避开网关那些「参数被忽略 / 5 分钟缓存」的坑。
      const def = getSource(this.curSource)
      const isDirect = !!(def && def.direct) && !(effCfg && effCfg.source === 'gateway')

      for (let round = 0; round < 2; round += 1) {
        // 每轮重新构建 URL：内置的时间戳参数保证不复用服务端缓存
        const url = buildUrl(this.curSource, effCfg)
        this.status = round === 0 ? '请求中...' : '换一张...'
        console.warn('[RP] fetch url=' + url)

        if (isDirect) {
          // 直连源拿不到作品信息，至少把「这张图来自哪个站」标出来
          const host = (/^https?:\/\/([^/]+)/.exec(url) || [])[1] || ''
          ex = { url: url, meta: { site: host } }
          this.status = '下载图片...'
        } else {
          const r = await curlGetJson(url, 20)
          if (r.code !== '200') {
            this.busy = false
            this.loading = false
            this.status = '请求失败(HTTP ' + r.code + ')'
            // 网关拿不到图时返回的是 503 + NO_IMAGE_AVAILABLE，直接把服务端原话摆出来
            this.imgHint = /NO_IMAGE_AVAILABLE/.test(String(r.body))
              ? '该分类没有可用图源（服务端）'
              : '请检查网络或字段配置'
            return
          }

          let data = null
          try { data = JSON.parse(r.body) } catch (e) { data = null }
          reqBody = r.body

          const got = extractImageUrl(this.curSource, data, this.curCfg.size)
          if (!got || !got.url) {
            this.busy = false
            this.loading = false
            // lolicon 对「标签没命中」返回的是 200 + {"data":[]}，不是错误，
            // 直接甩原始响应体用户看不懂，这里给可操作的提示
            if (this.curSource === 'lolicon' && /"data"\s*:\s*\[\s*\]/.test(r.body)) {
              this.status = '该标签没有结果'
              this.imgHint = '换个标签，或把标签留空（全随机）'
            } else {
              this.status = '未解析到图片地址'
              this.imgHint = '响应：' + String(r.body).slice(0, 60)
            }
            return
          }
          ex = got
        }

        // 唯一文件名：每次获取都换名字，<image> 的 src 必然变化，
        // 既不会命中上一次的位图缓存（否则永远显示同一张），也不会覆盖正在显示的图
        const ws = getWorkspace()
        this.seq += 1
        const name = makeImageName(String(Date.now()) + String(this.seq))

        this.status = '下载图片...'
        // 首选平台原生下载：实测同一张 700KB 的图，原生 3.7s，应用内 curl 40s（约 10 倍）
        const pace = pacedStatus(this, round === 0 ? '下载图片' : '重新下载')
        try {
          dl = await fetchImageFile(ex.url, ws, name, {
            onProgress: pace.progress,
            // 直连源第一轮失败就别再拿同一个地址走慢速 curl 了：
            // 多半是那个站这次返回 404/空页，直接回去换一个新随机地址更快
            noCurl: isDirect && round === 0,
          })
        } finally {
          pace.stop()
        }

        // 失败后的两级兜底：只在本轮内各多试一次，不额外消耗重试轮次
        if (dl && !dl.ok) {
          // 1) 尺寸降级：大图在慢速边缘节点上很容易超时（实测 700KB 的图在应用内要 40s），
          //    这时换同一作品的小图档位（约 1/10 体积）再下一次，先让用户看到图。
          if (ex && ex.fallbackUrl && ex.fallbackUrl !== ex.url) {
            this.status = '换小图重试...'
            console.warn('[RP] fallback small ' + ex.fallbackUrl)
            this.seq += 1
            const n2 = makeImageName(String(Date.now()) + String(this.seq))
            const p2 = pacedStatus(this, '换小图重试')
            let dl2 = null
            try {
              dl2 = await fetchImageFile(ex.fallbackUrl, ws, n2, { onProgress: p2.progress })
            } finally {
              p2.stop()
            }
            if (dl2 && dl2.ok) {
              dl = dl2
              ex = Object.assign({}, ex, { url: ex.fallbackUrl })
            }
          }
          // 2) 转码兜底：本地 ffmpeg 解不动（个别 webp/超大图）→ 由图像代理转成标准 jpg
          //    只在「确实是解码/EOI 失败」时触发，且整个取图只做一次：
          //    下载失败（dl-fail）说明文件根本没下来，转码也救不了，只会白等 10~30s。
          if (dl && !dl.ok && !transcoded && /decode|eoi/.test(String(dl.reason))) {
            transcoded = true
            const via = proxyResizeUrl(ex.url)
            if (via && via !== ex.url) {
              this.status = '转码重试...'
              console.warn('[RP] transcode fallback ' + via)
              this.seq += 1
              const name3 = makeImageName(String(Date.now()) + String(this.seq))
              const p3 = pacedStatus(this, '转码重试')
              let dl3 = null
              try {
                // 代理站冷缓存要 ~33s，超时给足；它能直接吐标准 jpg，所以 curl 通道也够用
                dl3 = await fetchImageFile(via, ws, name3, { onProgress: p3.progress })
              } finally {
                p3.stop()
              }
              if (dl3 && dl3.ok) dl = dl3
            }
          }
        }

        if (!dl || !dl.ok) {
          // 截断/超时的图一律丢弃，绝不显示半张（否则就是「下半部分全绿」）
          lastErr = dl ? dl.reason : 'unknown'
          continue
        }

        hash = await fileMd5(dl.path)
        // 和上次显示的完全一样 → 再换一次；第二次仍重复就接受
        if (hash && this.lastHash && hash === this.lastHash && round === 0) {
          console.warn('[RP] duplicate hash=' + hash + ' -> retry')
          // 先留住这张（万一重试失败，至少还有图可显示）
          fallback = { ex: ex, dl: dl, hash: hash }
          continue
        }
        break
      }

      // 重试失败但有上一张可用 → 退回它，不要让用户白等
      if ((!dl || !dl.ok) && fallback) {
        ex = fallback.ex
        dl = fallback.dl
        hash = fallback.hash
      }

      if (!dl || !dl.ok) {
        this.busy = false
        this.loading = false
        this.status = '图片下载失败：' + (lastErr || 'unknown')
        this.imgHint = '已丢弃不完整的图片，请重试'
        return
      }
      if (!ex || !ex.url) {
        this.busy = false
        this.loading = false
        this.status = '未解析到图片地址'
        this.imgHint = '响应：' + String(reqBody).slice(0, 60)
        return
      }

      this.lastHash = hash
      this.localImgPath = dl.path
      this.remoteUrl = ex.url
      // 清掉旧图：只留最近 4 张（当前这张是最新的，一定保留），避免包目录越堆越大
      pruneImages(getWorkspace(), 4)

      const meta = ex.meta || {}
      const parts = []
      if (meta.title) parts.push('标题:' + meta.title)
      if (meta.author) parts.push('作者:' + meta.author)
      if (meta.pid) parts.push('PID:' + meta.pid)
      if (meta.site) parts.push('来源:' + meta.site)
      // lolicon 会回传这张图到底是不是 R18 → 直接标出来，切换分级时能立刻看出区别
      if (typeof meta.r18 === 'boolean') parts.push(meta.r18 ? '分级:R18' : '分级:全年龄')
      if (meta.tags) parts.push('标签:' + meta.tags)
      this.imgMeta = parts.join('  ')
      this.status = '加载图片...'
      console.warn('[RP] img=' + ex.url + ' local=' + dl.relName + ' size=' + dl.size + ' md5=' + hash)

      this.imgUrl = dl.relName

      // 兜底：3s 内没收到 @load/@error 就强制解除，防止极端情况下卡在「加载中」
      const token = dl.relName
      setTimeout(() => {
        if (this.imgUrl === token && this.loading) {
          this.loading = false
          this.busy = false
        }
      }, 3000)
    },

    // ---- 图片解码完成：解除 loading，状态改为已获取 ----
    onImgLoad() {
      this.loading = false
      this.busy = false
      this.status = '已获取'
    },

    // ---- 图片加载/解码失败：解除 loading，给出提示 ----
    onImgError() {
      this.loading = false
      this.busy = false
      this.status = '图片显示失败'
      this.imgHint = '图片已下载但无法显示'
    },

    // ---- 下载 ----
    toggleSaveDir() {
      this.saveDir = this.saveDir === 'picture' ? 'favorite' : 'picture'
      this.persist()
    },

    // ---- 全屏看图 + 缩放 ----
    openFullscreen() {
      if (!this.imgUrl) return
      this.fsScale = 1
      this.fsX = 0
      this.fsY = 0
      this.fsSuppress = false
      this.fullscreen = true
    },
    closeFullscreen() {
      this.stopFsAnim()
      this.fsDrag = null
      this.fullscreen = false
      // 关掉就复位：下次点开永远是原尺寸，不会带着上次的放大状态进来
      this.fsScale = 1
      this.fsX = 0
      this.fsY = 0
    },

    // 舞台空白处轻点返回；拖动过就不当点击，免得一拖就退出
    onStageClick() {
      if (this.fsSuppress) { this.fsSuppress = false; return }
      this.closeFullscreen()
    },

    stopFsAnim() {
      if (this.fsTimer) { clearInterval(this.fsTimer); this.fsTimer = null }
    },

    // 位移边界：画面只能在自己的尺寸范围内移动，不会拖到全黑
    clampFs(scale, x, y) {
      const mx = Math.max(0, (FS_W * scale - FS_W) / 2)
      const my = Math.max(0, (FS_H * scale - FS_H) / 2)
      return {
        x: Math.round(Math.min(mx, Math.max(-mx, x))),
        y: Math.round(Math.min(my, Math.max(-my, y))),
      }
    },

    // 分帧补间：平台没有 transition，只能自己插值。6 帧 × 30ms ≈ 180ms，
    // 缩放时同步把位移夹回合法范围，放大后再缩小不会留下「偏出画面」的偏移。
    animateFs(targetScale) {
      this.stopFsAnim()
      const s0 = this.fsScale
      const x0 = this.fsX
      const y0 = this.fsY
      const c = this.clampFs(targetScale, x0, y0)
      const N = 6
      let i = 0
      this.fsTimer = setInterval(() => {
        i += 1
        const t = i / N
        // easeOutCubic：起手快、收尾稳，看起来才顺
        const e = 1 - Math.pow(1 - t, 3)
        this.fsScale = Math.round((s0 + (targetScale - s0) * e) * 1000) / 1000
        this.fsX = Math.round(x0 + (c.x - x0) * e)
        this.fsY = Math.round(y0 + (c.y - y0) * e)
        if (i >= N) {
          this.fsScale = targetScale
          this.fsX = c.x
          this.fsY = c.y
          this.stopFsAnim()
        }
      }, 30)
    },

    zoomIn() {
      if (!this.fsCanIn) return
      const cur = this.fsScale
      let next = ZOOM_MAX
      for (let i = 0; i < ZOOM_STEPS.length; i += 1) {
        if (ZOOM_STEPS[i] > cur + 0.001) { next = ZOOM_STEPS[i]; break }
      }
      this.animateFs(next)
    },

    zoomOut() {
      if (!this.fsCanOut) return
      const cur = this.fsScale
      let prev = 1
      for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
        if (ZOOM_STEPS[i] < cur - 0.001) { prev = ZOOM_STEPS[i]; break }
      }
      this.animateFs(prev)
    },

    zoomReset() {
      this.animateFs(1)
    },

    onFsTouchStart(e) {
      const t = touchPoint(e)
      this.fsDrag = { x: t.x, y: t.y, px: this.fsX, py: this.fsY }
      this.fsSuppress = false
      this.stopFsAnim()
    },

    // 按「增量」跟手，而不是按「从起点算的总位移」：
    // 实测触摸流会被系统中途打断（连续 slip 之间会插 touchend/touchcancel），
    // 一旦中断就清掉起点，后续移动全被丢掉 —— 表现为「拖了很长但画面只动了一点点」。
    // 现在每次 move 只取与上一次落点的差、并把落点更新成当前位置，
    // 即使中间丢了事件，下一次移动也能接着算。
    onFsTouchMove(e) {
      const t = touchPoint(e)
      if (!this.fsDrag) {
        this.fsDrag = { x: t.x, y: t.y, px: this.fsX, py: this.fsY }
        return
      }
      const dx = t.x - this.fsDrag.x
      const dy = t.y - this.fsDrag.y
      if (!dx && !dy) return
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.fsSuppress = true
      this.fsDrag.x = t.x
      this.fsDrag.y = t.y
      // 原始尺寸（或更小）时没有可移动的余量，直接不动
      if (this.fsScale <= 1.001) return
      const c = this.clampFs(this.fsScale, this.fsX + dx, this.fsY + dy)
      this.fsX = c.x
      this.fsY = c.y
      this.fsDrag.px = c.x
      this.fsDrag.py = c.y
    },

    onFsTouchEnd() {
      // 注意：这里**不清** fsDrag。触摸流会在 slips 之间插 touchend，
      // 清掉起点下一次移动就只能重新锚定、丢掉中间那段位移。
      // 起点只在下一次 touchstart（真正重新按下）时重置。
      if (this.fsDrag && this.fsSuppress) {
        console.warn('[RP] fs drag -> ' + this.fsX + ',' + this.fsY +
          ' @' + this.fsScale + 'x')
      }
      // touchend 之后通常会跟一个 click：先把它吞掉，再清标记
      if (this.fsSuppress) {
        setTimeout(() => { this.fsSuppress = false }, 400)
      }
    },

    async download() {
      if (!this.remoteUrl) {
        this.status = '请先获取图片'
        return
      }
      // Picture / Favorite 是系统已有目录，只探测不重建；Favorite 里才建子文件夹
      const root = await resolveSaveRoot(this.saveDir)
      // 用本地实际落盘文件的扩展名（webp 已被转成 jpg），而不是远程 URL 的扩展名
      const ext = this.localImgPath && this.localImgPath.includes('.')
        ? this.localImgPath.split('.').pop()
        : guessExt(this.remoteUrl)
      const name = buildFilename(this.curSource, ext)
      const dest = root + '/' + name
      this.status = '下载中...'
      console.warn('[RP] dl ' + this.remoteUrl + ' -> ' + dest)

      // 优先：已有本地临时文件，直接复制；否则重新下载
      if (this.localImgPath) {
        const copyOk = copyFile(this.localImgPath, dest)
        if (copyOk) {
          this.status = '已保存到 ' + dest
          return
        }
      }
      // 走到这里说明本地缓存文件没复制成功（被 prune 清掉了），只能重新下一次
      const pace = pacedStatus(this, '下载中')
      let dl = null
      try {
        dl = await fetchImageFile(this.remoteUrl, root, name, { onProgress: pace.progress })
      } finally {
        pace.stop()
      }
      this.status = (dl && dl.ok) ? ('已保存到 ' + dest) : '下载失败'
    },
  },
}
</script>

<style lang="less" scoped>
@import "base.less";

.root {
  width: 936px;
  height: 280px;
  flex-direction: column;
  background-color: #f5f6f8;
}

/* 顶栏 */
.topbar {
  width: 936px;
  height: 44px;
  flex-direction: row;
  align-items: center;
  padding-left: 16px;
  padding-right: 16px;
  background-color: #2c3e50;
}

.title {
  font-size: 22px;
  color: #ffffff;
  font-weight: bold;
  margin-right: 20px;
}

.tabs {
  flex-direction: row;
}

.tab {
  height: 30px;
  padding-left: 14px;
  padding-right: 14px;
  margin-right: 8px;
  border-radius: 15px;
  justify-content: center;
  background-color: #44566b;
}

.tab-on {
  background-color: #41b883;
}

.tab-text {
  font-size: 15px;
  color: #ffffff;
}

/* 主体 */
.body {
  width: 936px;
  height: 236px;
  flex-direction: row;
}

/* 左栏：图片 */
.left {
  width: 560px;
  height: 236px;
  flex-direction: column;
  padding: 8px;
}

.img-box {
  width: 544px;
  height: 190px;
  background-color: #e8eaed;
  border-radius: 8px;
  justify-content: center;
  align-items: center;
}

.img {
  width: 544px;
  height: 190px;
}

.img-notice {
  width: 520px;
  padding-left: 20px;
  padding-right: 20px;
}

.notice-line {
  width: 520px;
  margin-bottom: 6px;
  font-size: 16px;
  line-height: 26px;
  color: #5b6b7c;
  text-align: center;
}

.img-placeholder {
  font-size: 18px;
  color: #8892a0;
  text-align: center;
}

.loading-text {
  font-size: 16px;
  color: #41b883;
}

.meta-text {
  margin-top: 6px;
  font-size: 13px;
  color: #55606e;
  lines: 1;
  text-overflow: ellipsis;
}

/* 右栏 */
.right {
  width: 376px;
  height: 236px;
  flex-direction: column;
  padding: 8px;
}

.fields {
  width: 360px;
  height: 130px;
}

.field-row {
  width: 360px;
  flex-direction: row;
  align-items: flex-start;
  margin-bottom: 4px;
}

.field-label {
  width: 90px;
  font-size: 14px;
  color: #2c3e50;
  margin-top: 6px;
}

.select-box {
  width: 268px;
  flex-direction: row;
  flex-wrap: wrap;
}

.opt {
  height: 26px;
  padding-left: 10px;
  padding-right: 10px;
  margin-right: 6px;
  margin-bottom: 4px;
  border-radius: 6px;
  background-color: #e0e4ea;
  justify-content: center;
}

.opt-on {
  background-color: #41b883;
}

.opt-text {
  font-size: 12px;
  color: #34495e;
}

.input-box {
  width: 268px;
  height: 30px;
  border-radius: 6px;
  background-color: #ffffff;
  border-width: 1px;
  border-style: solid;
  border-color: #ccd2da;
  justify-content: center;
  padding-left: 8px;
  padding-right: 8px;
}

.input-value {
  font-size: 13px;
  color: #2c3e50;
  lines: 1;
  text-overflow: ellipsis;
}

/* 操作 */
.actions {
  width: 360px;
  flex-direction: row;
  margin-top: 8px;
}

.btn {
  height: 34px;
  border-radius: 8px;
  justify-content: center;
  align-items: center;
  padding-left: 10px;
  padding-right: 10px;
  margin-right: 8px;
}

.btn-main {
  background-color: #41b883;
}

.btn-sub {
  background-color: #5a8dee;
}

.btn-text {
  font-size: 14px;
  color: #ffffff;
}

.status {
  margin-top: 6px;
  font-size: 12px;
  color: #e67e22;
  lines: 1;
  text-overflow: ellipsis;
}

/* 全屏大图覆盖层 */
.fullscreen-layer {
  width: 936px;
  height: 280px;
  position: absolute;
  top: 0;
  left: 0;
  flex-direction: column;
  background-color: #000000;
  justify-content: center;
  align-items: center;
}

/* 缩放工具条：独立一层，点它不会触发「点舞台返回」 */
.fs-bar {
  width: 936px;
  height: 36px;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-left: 14px;
  padding-right: 12px;
}

.fs-zoom-text {
  font-size: 14px;
  color: #cccccc;
}

.fs-btns {
  flex-direction: row;
}

.fs-btn {
  height: 26px;
  border-radius: 13px;
  padding-left: 12px;
  padding-right: 12px;
  margin-left: 8px;
  justify-content: center;
  align-items: center;
}

.fs-btn-on {
  background-color: #3a3f46;
}

.fs-btn-off {
  background-color: #26292d;
}

.fs-btn-reset {
  background-color: #5a8dee;
}

.fs-btn-close {
  background-color: #4a4f57;
}

.fs-btn-text {
  font-size: 13px;
  color: #ffffff;
}

/* 舞台：画面在这里被缩放/拖动，超出部分裁掉（容器默认 overflow 就是 hidden） */
.fs-stage {
  width: 936px;
  height: 244px;
  justify-content: center;
  align-items: center;
  overflow: hidden;
}

.fs-canvas {
  justify-content: center;
  align-items: center;
}

.fullscreen-img {
  width: 936px;
  height: 244px;
}
</style>
