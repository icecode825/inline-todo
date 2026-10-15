# Inline Todo (行内待办)

**English** | [中文说明见下方](#中文说明)

Checkable inline todos **anywhere in a line** for Obsidian — not just at the start of a list item.

```markdown
Buy groceries[]milk /[]bread /[x]report done/

A todo can also span[]several lines
within the same paragraph,
until the slash/ and normal text continues here.
```

## Features

- **Inline syntax**: `[]text/` = unchecked, `[x]text/` = checked (strikethrough). The todo only covers the text between the markers.
- **Multi-line**: content may span soft line breaks within the same paragraph.
- **Native Markdown inside**: bold, italics, highlights, inline code, links etc. inside the markers are rendered by Obsidian as usual — the plugin only draws the checkbox and the "done" style, and never interferes with inner syntax.
- **Click to toggle** in both Live Preview and Reading mode. State is written back to the file (`[]` ↔ `[x]`).
- **Cursor reveals source**: place the cursor inside a todo in Live Preview and it shows the raw `[]text/` so you can edit it, like native Markdown syntax does.
- **Safe by default**: markers inside inline code / code blocks are ignored. Source mode always shows raw text. An unmatched `[]` or `/` never renders.
- **Escaping**: a literal slash inside the content is written as `\/`.
- **JS API** for other plugins and statistics scripts (see below).

## Syntax

| Syntax | Meaning |
| --- | --- |
| `[]text/` | unchecked inline todo |
| `[x]text/` | checked inline todo (strikethrough) |
| `\/` inside content | literal `/` |
| (single line break inside) | keeps the todo open (same paragraph only) |
| standard task line ending with `/` (e.g. `- [ ] buy milk/`) | no line break after it — consecutive tasks display in one row |

### Standard tasks, inline display

Keep writing normal Obsidian tasks — they stay 100% visible to Tasks, Dataview and every statistics plugin. Add a trailing `/` to a task line and it joins the next line into a single visual row (the `/` is hidden by this plugin's rendering only):

```markdown
- [ ] buy milk/
- [ ] wash dishes/
- [x] weekly report/
- [ ] backup data
```

`buy milk`, `wash dishes` and `weekly report` render as one row; `backup data` (no trailing `/`) stays on its own line. Plain text lines between tasks are absorbed into the row; blank lines, headings, quotes, code blocks and other list items break the chain.

## Install

- Community plugins: search **Inline Todo** (pending review).
- Manual: download `main.js`, `manifest.json`, `styles.css` from the [latest release](../../releases/latest) into `<vault>/.obsidian/plugins/inline-todo/` and enable it.

## For developers / statistics

The plugin exposes a public API so other plugins and scripts can read inline todos (they are **not** list items, so the Tasks plugin / Dataview task lists will not see them — use this API instead):

```js
const api = app.plugins.plugins['inline-todo']?.api;

// All inline todos of one note (in document order)
const todos = await api.getTodos('notes/today.md');
// [{ checked: false, text: 'milk', raw: '[]milk /', index: 12, line: 3, column: 4 }, ...]

// Scan the whole vault: { 'path/to/note.md': [todos...] }
const all = await api.getAll();

// Subscribe to toggles (callback receives the file path)
const ref = api.onChanged((path) => console.log('changed:', path));
// app.workspace.offref(ref) to unsubscribe
```

DataviewJS example — count open inline todos per note:

```dataviewjs
const api = app.plugins.plugins['inline-todo']?.api;
const all = await api.getAll();
const rows = Object.entries(all).map(([path, todos]) => ({
  note: path,
  open: todos.filter(t => !t.checked).length,
  done: todos.filter(t => t.checked).length,
}));
dv.table(['note', 'open', 'done'], rows.map(r => [r.note, r.open, r.done]));
```

## 中文说明

在 Obsidian 里让**一行中的任意位置**都能放可勾选的待办，不再受“待办必须是列表项”的限制。

```markdown
买菜[]牛奶 /[]面包 /[x]周报写完了/

待办也可以[]跨行书写，
只要在同一个段落内，
到斜杠为止/ 后面就恢复普通文字。
```

### 语法

| 写法 | 含义 |
| --- | --- |
| `[]内容/` | 未完成待办 |
| `[x]内容/` | 已完成待办（内容自动划删除线） |
| 内容里的 `\/` | 字面斜杠 `/` |
| 段落内换行 | 待办继续，跨段落不行 |
| 标准任务行尾加 `/`（如 `- [ ] 买菜/`） | 该行不换行，与下一行拼成一行显示 |

### 标准任务横排（推荐，统计全兼容）

照常写 Obsidian 原生任务，源文件 100% 标准，**Tasks、Dataview、一切统计插件完整识别**。给任务行尾加 `/`，连续的任务就在一行内并排显示（`/` 只在本插件渲染时隐藏）：

```markdown
- [ ] 买菜/
- [ ] 洗碗/
- [x] 写周报/
- [ ] 备份数据
```

`买菜`、`洗碗`、`写周报` 横排一行；`备份数据`（行尾没有 `/`）保持竖排。任务之间夹的普通文字行也会被吸进横排；空行、标题、引用、代码块、其他列表会断开横排链。

### 行为说明

- **实时预览**与**阅读模式**都渲染，点击复选框直接写回源文件（`[]` ↔ `[x]`）
- **光标进入待办范围**（实时预览）时自动露出原始语法，方便编辑
- **源码模式**始终显示原始语法
- 行内代码、代码块中的标记**不会误渲染**；没有结束符的 `[]` 也不会
- 待办内部的**加粗、斜体、高亮、链接等一切语法**都按 Obsidian 原生规则渲染，插件只负责待办框和完成样式

### 给插件开发者 / 统计脚本

行内待办**不是列表任务**，所以 Tasks、Dataview 的任务列表默认看不到它们。本插件提供公开 API：

```js
const api = app.plugins.plugins['inline-todo']?.api;

await api.getTodos('笔记.md');  // 该笔记全部行内待办
await api.getAll();             // 全库扫描 { 路径: 待办数组 }
api.onChanged(path => { ... }); // 监听勾选变化
```

每个待办对象包含：`checked`（是否完成）、`text`（内容，已还原转义）、`index`（源文偏移）、`line` / `column`（行/列，从 0 计）。

DataviewJS 统计示例见上文 English 部分。

## License

[MIT](./LICENSE) © [icecode825](https://github.com/icecode825)
