# Dejavu — Chrome 扩展

> 录一次，AI 处处复现

Chrome 扩展（MV3，纯 JS 无构建），点图标打开侧边栏，提供两个能力。回放所需的通用 Skill 在仓库上级的 [`skill/`](../skill/SKILL.md) 目录。

## 功能

1. **Token 捕获**：点「获取 Token」后监控当前标签页的请求头（`Authorization` / `x-token` / `x-api-key` 等），在页面上操作（如登录）即可捕获，点击「复制」写入剪贴板。
2. **操作录制**：点「开始监控」后录制当前标签页的点击 / 输入 / 回车 / 滚动 / 表单提交 / 页面跳转，侧边栏实时显示；点「停止并保存」自动归档并下载录制数据包（`recording-*.zip`），交给装了通用 Skill 的 AI 即可回放。
3. **录制历史**：每次录制自动归档一条记录（最近 10 次，存在本地），点击条目可展开动作明细、重新下载 zip；录制页被意外关闭时数据也不丢。

## 安装

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 「加载已解压的扩展程序」选择本目录（`chrome/`）

## 使用

- 点扩展图标直接打开侧边栏（面板绑定当前标签页）
- Token：先点按钮再去页面上操作，捕获列表实时出现，点「复制」
- 录制：点「开始监控」→ 正常操作 → 「停止并保存」，`recording-*.zip` 自动下载到下载目录，可立即开始下一次录制
- 历史：在「录制历史」中回看任何一次录制，展开明细或重新下载 zip

## 录制包结构（formatVersion 1）

```
recording-<域名>-<时间戳>.zip
├── actions.json      # 语义动作序列（type/selector/text/value/时间戳/截图引用）
├── network.json      # 录制期间网络请求基线（method/url/status，token 掩码）
├── metadata.json     # 起止 URL、时长、动作数、UA、formatVersion 等
└── screenshots/      # 每个动作一张 JPEG（按序号命名）
```

格式细节见 [`../skill/SKILL.md`](../skill/SKILL.md)，由通用 Skill 按版本解析。

## 本地测试

```bash
cd testpage && python3 -m http.server 8765
# 访问 http://localhost:8765 按页面提示操作
```

## 已知限制

- 只捕获请求头中的 token，不解析响应体（换来无「正在被调试」横幅、无需 chrome.debugger）
- 不录制 iframe 内部动作、不记录鼠标轨迹/悬停
- 截图依赖录制标签页处于前台可见；`type=password` 输入值录制为 `***`
- 长录制会话截图可能超过 session storage 10MB 配额，超限后自动降级为不存截图（metadata.json 中有标记）
- chrome:// 等浏览器内置页面无法录制（无内容脚本）
- SPA 软导航不单独记动作，由各动作携带的 url 变化体现

## 第三方库

- [fflate](https://github.com/101arrowz/fflate)（MIT）：zip 打包，见 `lib/LICENSE-fflate.txt`
