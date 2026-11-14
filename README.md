# 随机图片（RandomPic）

一个运行在 936×280 横屏嵌入式设备上的随机图片小程序，基于 falcon-ui 组件库。

## 功能

- **多图源**：Pixiv Yuki、Anime Gateway、雪涼 Setu 三个源可切换，字段随源动态变化
- **尺寸与分级**：常规 / 小图 / 原图；部分源支持全年龄 / 混合 / R18
- **本地保存**：保存到 `/userdisk/Pictures`，收藏到 `/userdisk/Favorite/randompic`
- **全屏查看**：1–8 倍缩放、拖动平移、一键复位
- **下载策略**：平台原生下载优先，失败自动换地址重试；超大图与 webp 本地转码

## 环境要求

- Node.js 18+（推荐 22）
- npm 9+
- 构建工具 `aiot-vue-cli` 已声明在 `devDependencies`，`npm install` 会自动安装，**无需全局安装**

## 构建

```bash
npm install
npm run build:prod
```

产物位于项目根目录：`<appid>.<version>.amr`，例如 `8001793430496590.1_3_9.amr`。
版本号取自 `package.json` 的 `version`，发新包前记得递增。

## 可选：推送到设备

`postbuild:prod` 会在构建成功后自动执行 `tools/push-amr.mjs`：把最新包推到设备 `/userdisk`，并只保留最近 3 个版本。

未连接设备（或本机没装 `adb`）时，脚本只打印一条警告后正常退出，**不影响构建成功与否**。

单独执行：

```bash
npm run push            # 推送 + 清理旧包
npm run push:install    # 推完顺手安装并启动
npm run push:dry        # 只看会做什么，不动手
```

## 目录结构

```
src/
  app.js / app.json / base-page.js
  lib/            图源定义、URL 构建、原生能力封装（下载/转码/文件）
  pages/index/    主页面：配置面板 + 图片区 + 全屏查看
  styles/         变量与基础样式
test/             单元测试
tools/            构建后推送脚本
api-mock/         本地接口 mock 示例
```

## 测试

```bash
node test/lib.test.mjs
```

## 屏幕适配

界面按 936×280 的设计稿写 px，运行时由 `src/lib/fit.js` 算一次：
`scale = min(屏宽/936, 屏高/280)`，把 `屏宽/scale` 交给框架的 `setViewPort()` 做等比缩放，
再按算出的「虚拟画布」把整屏骨架（根容器、图片区、字段区、全屏舞台）用内联 `:style` 重新注入。

- 设计尺寸的机器（936×280）：`scale = 1`，**不调用** `setViewPort`，画面与改造前逐像素一致；
- 960×266 这类更扁的屏：缩到 0.95，虚拟画布 1011×280，底部不再被裁；
- 更宽的屏：多出来的宽度给图片区，右栏宽度不变；
- 拿不到屏幕信息、或 `setViewPort` 不可用：自动退回 936×280，不会白屏。

`plan()` / `layout()` 都是纯函数，`node test/fit.test.mjs` 覆盖 12 种分辨率。

## 落盘说明（重要）

本平台写文件的能力**逐固件不同**：有的固件没有 `fs.writeFile`，有的写成功但不落盘。
工程里的实现是：

1. 启动先探针（真写一次再读回），据此选 `fs` 或 `shell base64` 通道；
2. 配置整份重写：先写 `.tmp` → `mv` 原子替换 → 读回比对；失败会把「配置未保存」显示到状态栏；
3. 下载用的 shell 脚本同样走这条写通道，写不下去时直接报「本地存储不可写」，不会伪装成网络超时。

配置文件位于 `/userdisk/randompic_cfg_<appid>.json`（按 appid 隔离，装两个版本也不会互相覆盖）。

## 说明

- `package.json` 里的 `appid` 是设备端应用标识。要装到自己的设备上，需替换成你在设备平台注册的 appid，否则会因包名/签名不匹配无法安装。
- 图源均为第三方公开接口，可用性不受本项目控制，个别时段可能出现 404 或超时。
- 仓库不含真机截图、诊断数据与构建产物（见 `.gitignore`），这些内容不影响构建。
