# Bob Browser 网页任务执行复盘 — 小红书「海拉尔 旅游攻略」检索

> 日期：2026-08-20
> 场景：对话要求「打开小红书搜索海拉尔旅游攻略，整理成攻略」
> 目的：复盘一次典型的长链路浏览器任务，沉淀可复用的执行优化

---

## 一、执行轨迹还原（按工具轮次）

```
navigate 小红书搜索 → 受限页失败 → 查标签页状态 → 重试失败 → 改用 useNewTab 成功
  │
  ├─ 快照被截断 ──→ JS 提取链接 ──→ JS 返回空（CSP 拦截）
  ├─ HTML 结构解析 ──→ HTML 太大被截断
  ├─ 截图确认布局 ──→ 截图未返回视觉描述（静默失败）
  └─ 分块 snapshot 才定位到卡片（成功）
  │
  ├─ 逐篇打开笔记：打开→回搜索页→重新定位卡片（往返 4 次）
  ├─ 视频笔记信息少 → 靠评论区捞信息（2 次）
  └─ 收集 5-6 篇图文/评论 → 加载 bob-ui → 生成攻略
```

---

## 二、问题清单与根因

### P1 页面定位连环试错（浪费 8-9 轮，最严重）

| 尝试 | 结果 | 根因 |
|---|---|---|
| snapshot 截断 | 失败 | snapshot 无分页（offset）能力，truncated 后无法继续取 |
| run_js 注入 | 空 | 小红书 CSP 拦截脚本注入，从源头就该排除 |
| get_html 整页 | 截断 | 大页面 HTML 超长，从源头就该排除 |
| screenshot(describe) | 无描述 | 视觉翻译静默失败（dataUrl 提取正则未命中，无任何提示） |
| 分块 snapshot | 成功 | 兜底成功，但已耗 5 轮 |

根因：**工具缺陷**（snapshot 不可分页、describe 失败静默）+ **模型策略缺陷**（未预判强反爬站点特性，逐条试错）。

### P2 反复返回搜索页重定位（浪费 4-5 轮）

每开一篇笔记 → 返回搜索页 → 重新定位下一张卡片。应首次就一次性收集全部目标链接。

### P3 导航附着无效重试（浪费 2-3 轮）

「受限 → 查状态 → 重试 → 才 useNewTab」。失败时应在第一次就 useNewTab 兜底。

### P4 卡片偏移返工

按 `section:nth-of-type(N)` 直接点，未先验证，「大家都在搜」占位块导致偏移，回头重验。

### P5 视频笔记低性价比

两篇视频笔记文字极少，靠评论捞信息。图文笔记信息量远高。

### P6 上下文膨胀

试错内容（截断 HTML、多次 snapshot、往返导航）全部累积进上下文，计费与 token 消耗翻倍。

---

## 三、已落地的优化（2026-08-20）

### 1. 工具缺陷修复

- **browser.snapshot 新增 offset 分页**（[background.js](file:///Users/baolei/Desktop/BobAgent/browser-mcp/assets/extension/background.js)）：`slice(offset, offset+limit)`，ref 编号跨页连续；返回 `offset/total/truncated` 字段。截断后可 `offset = 上次 offset+count` 继续取，不再换工具
- **snapshot 工具描述**（[tools.ts](file:///Users/baolei/Desktop/BobAgent/browser-mcp/src/tools.ts)）明确分页用法
- **screenshot describe 失败提示**（[tools.ts](file:///Users/baolei/Desktop/BobAgent/projects/src/app/api/chat/tools.ts)）：dataUrl 提取失败但结果含截图数据时，返回明确提示引导改用 snapshot 分页 / extract_text，不再静默

### 2. 系统提示词策略（[route.ts](file:///Users/baolei/Desktop/BobAgent/projects/src/app/api/chat/route.ts)）

- **强反爬站点策略**：小红书/知乎/百度系禁用 run_js（CSP 拦截）、get_html 整页（截断）；一律 snapshot，truncated 用 offset 分页；describe 失败立即换分页 snapshot，不重复截图
- **导航受限直接 useNewTab**：CDP 超时/受限不可附加/no tab attached 时直接带 useNewTab: true 重试，不先查状态
- **列表页批量抓取**：先一次性收集全部目标链接再逐个 navigate，禁止"每开一篇就回列表页重定位"；图文 vs 视频区分，先读图文

### 3. 部署生效提示

- route.ts / tools.ts：刷新 dev（:8321）生效
- background.js：需在 Chrome 扩展管理页 **重新加载 Bob WebBridge 扩展**（chrome://extensions → 刷新）后才生效；已打包 crx 环境需重新 pack-crx 安装

---

## 四、预期收益

- 定位阶段：9 轮试错 → 2-3 轮（snapshot + 一次分页）
- 批量抓取：往返 4 次 → 0 次（收集链接后直连）
- 导航附着：2-3 轮 → 1 轮
- 上下文消耗：约减少 40-60%（剔除失败试错与往返）

---

## 五、遗留可优化项（未实施）

| 项 | 说明 | 收益 |
|---|---|---|
| 卡片偏移自校验 | 定位前先验证 1-2 张卡片标题-位置对应 | 避免返工 |
| 视频/图文预分类 | 取链接阶段按摘要自动区分，跳过视频 | 省 2 轮 |
| bob-ui 提前加载 | 任务起点已知要产出可视化时提前加载技能 | 省 2 轮 |
| 失败策略白名单 | 常见反爬站（小红书/知乎/抖音）预置策略到工具描述 | 治本 |
