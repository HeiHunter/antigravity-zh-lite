# antigravity-zh-lite

[![CI & Release](https://github.com/HeiHunter/antigravity-zh-lite/actions/workflows/ci-release.yml/badge.svg)](https://github.com/HeiHunter/antigravity-zh-lite/actions/workflows/ci-release.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Node.js >= 22](https://img.shields.io/badge/Node.js-%3E%3D22-339933.svg)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Windows-blue.svg)](#快速开始)

面向 **Google Antigravity 2.0 桌面端** 的轻量化、零依赖、无侵入简体中文汉化插件（支持 **macOS & Windows**，基于 CDP 运行时动态注入 + 开机静默常驻守护）。

---

## 效果预览

| 设置面板（常规 / 权限 / 输入框） | 自定义配置与插件市场 |
| :---: | :---: |
| ![设置面板中文界面](./assets/screenshot-settings.png) | ![插件市场中文界面](./assets/screenshot-marketplace.jpg) |

---

## 核心特性

- **极度轻量化（零 `node_modules`）**：纯原生 Node.js（≥ 22），无需 `npm install`，解压或克隆即用；注入客户端的单文件内核（含完整 700+ 词库与悬浮 UI）仅 ~84 KB（gzip 后 ~26 KB）。
- **macOS & Windows 双平台开机常驻**：
  - **macOS**：一键注册 `LaunchAgent` 静默常驻 + 自动生成带官方图标的 `Antigravity 中文版.app`。
  - **Windows**：一键注册 Startup 无黑框常驻（`.vbs`）+ 自动生成带官方图标的桌面快捷方式 `Antigravity 中文版.lnk`。
  - **自动跟随接管**：即便直接从原图标打开官方 Antigravity，后台守护检测到后也会自动平滑接管并完成汉化。
- **零侵入、不破坏应用签名**：不改动 `Antigravity.app` / `Antigravity.exe` 及 `app.asar`，不触发 macOS 签名告警或权限重置，天然抗官方版本自动更新。
- **React 虚拟 DOM 安全**：仅原地替换叶子 `TextNode.nodeValue` 与安全属性（`placeholder` / `title` / `aria-label`），自动跳过代码块、终端、输入框与聊天正文，防白屏、防误译。
- **精准长句自动翻译 + 系统代理自动识别**：针对无法穷举的命令审批风险说明与插件市场长简介（仅匹配 **≥ 5 词且 ≥ 28 字符** 的长句，以及 `Allow ...?` 审批标题），后台自动翻译并永久缓存在本地；严格拦截模型名（`Gemini` / `Claude` / `GPT`）与短标签；自动读取 macOS / Windows 系统 HTTP 代理与环境变量代理。
- **内置一键采集 & 自动上传**：右下角悬浮胶囊点击 `采集` → `结束 (N)`，通过 CDP 原生通道实时落盘到 `dicts/_collected.json`（可选配置 Webhook / GitHub Issue / Gist 自动上传）。

---

## 面对客户端更新：三层抗更新机制

传统修改 `app.asar` 的静态补丁，每次官方更新都容易失效、白屏或出现大量新功能未汉化。本插件针对 Antigravity 高频迭代设计了三层闭环：

1. **升级不失效**：零侵入运行时注入，官方自动覆盖更新安装包后无需重新打补丁。
2. **新长句自动适应**：新版新增的功能说明、权限审批风险提示、新上架插件介绍等长句（≥ 5 词且 ≥ 28 字符），无需更新插件即可在 ~200ms 内自动翻译并永久缓存在本地。
3. **新短词一键采集自愈**：如果新版新增了短按钮、菜单项或修改了原有文案描述，点击右下角 **`采集`** → 逛一遍新界面 → 点击 **`结束 (N)`**，即可自动过滤噪声并导出漏译 JSON 到 `dicts/_collected.json`：
   - **本地秒级热补**：把翻译补进 `dicts/*.json`，保存瞬间客户端自动热更新生效，无需重启；
   - **一键回馈社区**：也可直接粘贴到 [词条补充 Issue](https://github.com/HeiHunter/antigravity-zh-lite/issues/new?template=dict-collect.md)，几分钟即可同步覆盖所有用户。

---

## 环境要求

- **Node.js ≥ 22.0.0**（基于原生 `WebSocket` 与 `fetch`）
  - macOS：`brew install node` 或前往 [nodejs.org](https://nodejs.org/)
  - Windows：`winget install OpenJS.NodeJS.LTS` 或前往 [nodejs.org](https://nodejs.org/)

---

## 快速开始

### 1. 获取插件（任选其一）

* **方式 A（推荐，普通用户）**：前往 [Releases 页面](https://github.com/HeiHunter/antigravity-zh-lite/releases) 下载最新 `antigravity-zh-lite-v*.zip` 并解压到本地固定目录。
* **方式 B（开发者）**：
  ```bash
  git clone https://github.com/HeiHunter/antigravity-zh-lite.git
  cd antigravity-zh-lite
  ```

### 2. 一键安装开机常驻（macOS & Windows 通用）

在插件目录执行：

```bash
node bin/ag-zh.js install
```

* **macOS**：自动注册 `LaunchAgent` 静默常驻服务，并在 `~/Applications/` 与当前目录生成 `Antigravity 中文版.app`（可拖入 Dock 替代原图标）。
* **Windows**：自动写入开机无黑框自启 `.vbs`，并在桌面与当前目录生成 `Antigravity 中文版.lnk` 快捷方式。

常用管理命令：
```bash
node bin/ag-zh.js status      # 查看常驻服务、调试端口、动态翻译与挂载窗口状态
node bin/ag-zh.js uninstall   # 一键干净卸载常驻服务与快捷启动器（零残留）
```

### 3. 临时体验（不安装开机常驻）

* **macOS**：双击 `启动汉化.command`，或终端运行 `node bin/ag-zh.js --restart`
* **Windows**：双击 `启动汉化.bat`，或终端运行 `node bin\ag-zh.js --restart`

---

## 界面操作（右下角极简胶囊）

| 操作 / 快捷键 | 功能 |
| :--- | :--- |
| 点击 `中 / EN`（或 `Option/Alt + Shift + L`） | 实时无损切换中文 / 英文原版 |
| 点击 `采集` → 浏览界面 → 点击 `结束 (N)`（或 `Option/Alt + Shift + C`） | 采集未译词条并自动保存/上传 |
| `Option/Alt + Shift + H` | 隐藏 / 显示右下角悬浮胶囊 |

---

## 进阶配置（`ag-zh.config.json`）

执行 `install` 后会在项目根目录自动生成 `ag-zh.config.json`（也可手动复制 `ag-zh.config.example.json`）：

- **自定义代理（可选）**：默认自动读取环境变量与 macOS / Windows 系统 HTTP 代理；如需手动指定，填写 `dynamicTranslate.proxy`（例如 `"http://127.0.0.1:7890"`）。
- **大模型动态翻译（可选）**：将 `dynamicTranslate.provider` 设为 `"gemini"` 或 `"openai"`，并填写 `apiKey` / `model` / `apiBaseUrl`；设为 `enabled: false` 可关闭动态翻译、仅使用本地静态词库。
- **采集自动上传（可选）**：`upload.mode` 支持 `"local"`（默认落盘 `dicts/_collected.json`）、`"webhook"`、`"github-issue"`、`"github-gist"`。
- **自定义客户端安装路径**：若 Antigravity 未安装在默认目录，可在 `app` 字段填入实际路径（macOS `.app` 或 Windows `.exe`）。

---

## 常见问题（FAQ）

**Q：是否会修改 Antigravity 安装包或破坏 macOS 签名？**  
A：完全不会。本插件通过 Chromium DevTools Protocol（CDP）在运行时向渲染页面注入轻量脚本，不触碰任何官方二进制文件或 `app.asar`。卸载后 100% 恢复原貌。

**Q：开启 `--remote-debugging-port=9229` 安全吗？**  
A：Chromium 的远程调试端口默认仅绑定在本地回环地址 `127.0.0.1`，不对外网开放。如需更改端口，可在 `ag-zh.config.json` 修改 `port` 后重新执行 `install`。

**Q：Antigravity 客户端自动升级后汉化会失效吗？**  
A：不会失效。官方更新覆盖安装包不影响本插件运行；如果新版出现了全新英文界面，长句会自动走动态翻译，短标签可点击右下角「采集 → 结束」快速补充。

**Q：为什么需要 Node.js ≥ 22？**  
A：为了做到真正的「零第三方依赖（0 `node_modules`）」，本插件直接使用 Node 22+ 原生内置的 `WebSocket` 与 `fetch`。

---

## 参与贡献

欢迎通过 [提交词条 Issue](https://github.com/HeiHunter/antigravity-zh-lite/issues/new?template=dict-collect.md) 或直接向 `dicts/*.json` 提交 Pull Request 来完善翻译，详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

```bash
npm run validate      # 校验 dicts/*.json 语法、重键与正则合法性
npm run build         # 构建 dist/injector.js 与 dist/dict.json
npm test              # 运行全部自动化单元测试
npm run pack:release  # 自动过滤本地隐私缓存，生成干净的分发压缩包
```

---

## 免责声明

本项目为社区维护的第三方本地化辅助工具，与 Google 或 Antigravity 官方无任何从属关系。按 [MIT License](./LICENSE) 开源提供，请按需使用。
