# 参与贡献（Contributing）

感谢你为 `antigravity-zh-lite` 贡献词条或代码！

## 1. 补充词库（最简单）

词库按界面区域拆分为 7 个模块文件，均位于 `dicts/` 目录：

- `dicts/sidebar.json`：侧边栏、项目/环境切换、自动化任务
- `dicts/settings.json`：设置面板、权限策略、模型配额、语音与辅助功能
- `dicts/chat-chrome.json`：对话输入框、工具栏、回复操作、辅助面板
- `dicts/shortcuts.json`：快捷键名称
- `dicts/modals.json`：弹窗、审批卡片固定骨架、反馈与状态提示
- `dicts/marketplace.json`：插件市场分类、插件详情页与示例提示词
- `dicts/patterns.json`：带数字/变量的动态正则模板与正文排除选择器

### 翻译约定
1. **保留专有名词**：产品名、模型名（`Antigravity`、`Gemini`、`Claude`、`GPT`）、斜杠命令（`/plan`、`/swarm`）以及插件品牌名（`Figma`、`Cloudflare`、`Linear`）保持英文原样。
2. **简洁自然**：按钮和标签尽量简短，避免撑破窄按钮布局。
3. **提交前本地校验**：
   ```bash
   npm run validate
   npm run build
   npm test
   ```

## 2. 使用内置采集器快速找漏词

1. 启动守护：`node bin/ag-zh.js --restart`（或已安装常驻服务）。
2. 在 Antigravity 右下角点击 **`采集`**，逛一遍未翻译的页面后点击 **`结束`**。
3. 打开自动生成的 `dicts/_collected.json`，剔除文件名、个人对话标题等噪声后，将真实 UI 文案合入对应 `dicts/*.json`（保存后客户端会直接热更新预览效果）。
4. 注意：**请勿提交** `dicts/_collected.json`、`dicts/_dynamic_cache.json` 和 `ag-zh.config.json`（均已在 `.gitignore` 中忽略）。
