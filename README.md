# Flow 多账号管理器（桌面应用）

这是一个本地桌面应用：保存多个 Google 账号登录态，然后一键用“独立会话”打开 Flow 页面（多窗口模式：可同时打开多个账号窗口）。

- Flow 地址：`https://labs.google/fx/tools/flow`
- 每个账号使用独立的浏览器上下文打开一个窗口：互不影响，可并行操作多个账号

## 使用

在 `flow-multi-account/` 目录执行：

1) 安装依赖

```bash
npm install
```

2) 启动桌面应用

```bash
npm start
```

应用内右侧有“保存账号（一次性）”面板：输入账号名 → 会打开登录窗口 → 手动登录目标账号并进入 Flow → 回到应用点击“保存完成”。

## 数据存放

- 桌面应用模式（Electron）：账号数据存放在系统用户数据目录下的 `profiles/`
- 网页模式（可选）：存放在 `flow-multi-account/profiles/`
 - 下载文件：默认保存到系统“下载”目录下的 `Flow 多账号管理器/`（应用内可一键打开）

桌面应用的默认路径示例：

- Windows：`%APPDATA%\\Flow 多账号管理器\\profiles`
- macOS：`~/Library/Application Support/Flow 多账号管理器/profiles`

### 无落盘模式（更安全：客户端不保存账号文件）

如果你希望客户端**不在本机落盘保存账号登录态**（即不生成/保留 `profiles/*.json`），可在启动时设置：

```bash
FMA_NO_LOCAL_PROFILES=1 npm start
```

说明：桌面应用（Electron）默认启用无落盘模式；如需恢复本地落盘保存（不推荐），可显式关闭：

```bash
FMA_NO_LOCAL_PROFILES=0 npm start
```

行为说明：

- 本机不会写入 `profiles/*.json`（启动时与退出时会尽力清理遗留文件）
- 已激活模式下：打开账号时会从管理端拉取 `storageState` 并**仅在内存中使用**
- “同步账号”只同步可用账号列表，不下载账号文件到本机
- 本模式要求管理端可访问；否则无法打开账号（因为本机没有可用的登录态文件）

注意：即使不保存 `profiles/*.json`，Playwright/Chromium 运行时仍会创建临时的浏览器配置目录（用于运行时会话），通常在上下文关闭后自动清理。

## 浏览器要求

为避免打包体积过大，本项目默认使用系统已安装的 Google Chrome（`channel=chrome`）。请先安装 Chrome。

如需指定 channel（高级）：

```bash
PLAYWRIGHT_CHANNEL=chrome npm start
```

## 打包发布（DMG / EXE）

生成安装包：

- macOS：`npm run dist` → `flow-multi-account/dist/*.dmg`
- Windows：`npm run dist` → `flow-multi-account/dist/*.exe`（NSIS 安装器）

说明：通常需要在对应系统上构建对应产物（mac 上出 dmg，win 上出 exe）。

### Windows 打包提示（常见失败：符号链接权限）

如果你在 Windows 上打包遇到类似 `Cannot create symbolic link` 的报错，通常是因为 electron-builder 解压依赖工具时需要创建符号链接，而系统未开启开发者模式/无管理员权限。

解决方案（任选其一）：

- 开启 Windows「开发者模式」(Settings → For developers → Developer Mode)
- 用管理员权限运行终端后再执行 `npm run dist`
- 运行兼容模式：`npm run dist:compat`

另外：本项目默认在 Windows 打包时禁用自动代码签名发现（更稳定）。如你确实要启用签名，构建前设置：

```powershell
$env:ALLOW_CODESIGN="1"
npm run dist
```

## 主动关闭窗口

应用内提供：

- “关闭 Flow 窗口”（对应后端 `POST /close`）
- “退出浏览器进程”（对应后端 `POST /quit`，下次再打开会重新拉起浏览器）

### 自动释放内存（可选）

默认情况下：当你关闭 Flow/保存窗口后，如果浏览器空闲超过 10 分钟，会自动退出以释放内存（下次打开会自动重启）。

可通过环境变量关闭/调整：

- 关闭自动退出：`BROWSER_IDLE_MINUTES=0`
- 调整为 30 分钟：`BROWSER_IDLE_MINUTES=30`

## 删除账号

在应用左侧列表点击垃圾桶按钮（无弹窗，二次点击确认删除）。

## 网页模式（可选）

如你仍想用网页仪表盘：

```bash
npm run start:web
```

## 代理服务（框架）

本项目支持“按账号获取代理”：每次点击打开某个账号时，都会请求本机代理服务获取该账号的代理，然后将代理应用到本次打开的浏览器上下文（`browser.newContext({ proxy })`）。

默认代理服务地址：`http://127.0.0.1:3123`

可用环境变量覆盖：

- `PROXY_SERVICE_URL=http://127.0.0.1:3123`
- `PROXY_SERVICE_TIMEOUT_MS=2500`

代理服务在仓库根目录：`proxy-service/`，启动方式：

```bash
cd proxy-service
npm install
npm start
```

### 节点（vless / hysteria2）自动落地（sing-box）

当管理端返回的不是 `http(s)://` / `socks5://` 代理，而是订阅节点（`vless://` / `hysteria2://`）时，客户端会在本机启动 `sing-box`，将节点落地为本地 SOCKS5：

- `socks5://127.0.0.1:53182`

然后 Playwright 会使用这个本地 SOCKS5 代理打开 Flow。

注意：

- 这不会修改系统代理（例如你本机的 `127.0.0.1:7890`），只影响本应用创建的 Playwright 浏览器实例。
- 需要本机可执行 `sing-box`：
  - macOS（推荐）：`brew install sing-box`
  - 或把二进制放到 `flow-multi-account/bin/`：
    - macOS/Linux：`flow-multi-account/bin/sing-box`
    - Windows：`flow-multi-account/bin/sing-box.exe`
  - 如不在 PATH 中也可指定：`FMA_SINGBOX_BIN=/path/to/sing-box`
- 自动下载（缺失时）：默认会尝试从 GitHub Releases 下载并安装到本机 `userData/runtime/sing-box/`；可用 `FMA_SINGBOX_AUTO_DOWNLOAD=0` 关闭。
  - 下载 URL：默认会按平台使用一个“固定版本”的直链兜底；也可手动指定 `FMA_SINGBOX_DOWNLOAD_URL=<直链到 zip/tar.gz 或二进制>` 或 `FMA_SINGBOX_VERSION=<版本号>`。
- 开发调试可开：`FMA_SINGBOX_DEBUG=1`（将直接输出 sing-box 日志）

### 代理调试（打印完整用户名/密码）

默认情况下客户端日志会对代理做脱敏（避免泄露）。如需排查代理连通性，可显式开启调试输出：

```bash
FMA_PROXY_LOG_CREDENTIALS=1 npm start
```

可选项：

- 关闭连通性预检查：`FMA_PROXY_PREFLIGHT=0`
- 指定预检查 URL（默认 `https://www.google.com/generate_204`）：`FMA_PROXY_PREFLIGHT_URL=https://www.google.com/generate_204`
- 指定预检查方法（默认 `GET`）：`FMA_PROXY_PREFLIGHT_METHOD=HEAD`

## 激活与账号同步（内网部署）

当 `proxy-service` 部署在管理员机器上时，`Flow 多账号管理器` 支持“机器码 + 激活码”：

- 未激活：启动后进入激活界面（展示机器码与服务地址输入框）
- 激活成功：自动从服务端“全量同步”分配给本机器的账号 JSON
- 后续管理员更新分配后：用户点击右上角“同步账号”即可重新全量获取

服务端管理入口：

- `http://<server>:3123/admin.html`（可生成激活码、上传账号 JSON、为机器分配账号）

服务地址配置：

- 在激活界面填写服务地址（例如 `http://10.0.0.2:3123`），会保存到本机 `device.json`
