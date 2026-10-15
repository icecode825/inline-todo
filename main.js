/* ============================================================
   行内待办 Inline Todo  v0.3.0
   语法：[]内容/        未完成
         [x]内容/       已完成（内容加删除线）
   - 结束符为 "/"，内容里的字面斜杠写作 \/
   - 内容可跨行（同一段落内的软换行）
   - 内容内部的 Markdown 语法按 Obsidian 原生规则渲染，插件不干预
   - 行内代码/代码块中跳过；源码模式不渲染（显示原始语法）
   - 对外 API：app.plugins.plugins["inline-todo"].api
   ============================================================ */
'use strict';

var obsidian = require('obsidian');
var cmView = require('@codemirror/view');
var cmState = require('@codemirror/state');
var cmLang = require('@codemirror/language');

var TODO_SCAN_RE = /\[([xX]?)\]((?:[^/\\]|\\.)*)\//g;

// 扫描一段 Markdown 源文，返回全部行内待办（供 API 与回写定位共用）
function scanTodos(text) {
	TODO_SCAN_RE.lastIndex = 0;
	var res = [], m;
	while ((m = TODO_SCAN_RE.exec(text))) {
		var before = text.slice(0, m.index);
		var nl = before.lastIndexOf('\n');
		res.push({
			checked: m[1] !== '',
			text: m[2].replace(/\\\//g, '/'),
			raw: m[0],
			index: m.index,
			line: before.split('\n').length - 1,
			column: m.index - (nl + 1)
		});
	}
	return res;
}

/* ---------- 工具 ---------- */

// 归一化：去掉常见 md 修饰符与反斜杠转义并压缩空白，用于源文/渲染文内容比对
function normText(s) {
	return s.replace(/[*_~`\\]/g, '').replace(/\s+/g, ' ').trim();
}

// 找第一个未被反斜杠转义的 "/"
function findUnescapedSlash(str, from) {
	var i = str.indexOf('/', from);
	while (i !== -1 && i > 0 && str[i - 1] === '\\') i = str.indexOf('/', i + 1);
	return i;
}

function inCode(state, pos) {
	var node = cmLang.syntaxTree(state).resolveInner(pos, -1);
	for (var n = node; n; n = n.parent) {
		if (/code/i.test(n.name || '')) return true;
	}
	return false;
}

// 源码模式下不渲染（Live Preview / 阅读模式才渲染）
function isSourceMode(editorView) {
	var leaf = editorView.dom && editorView.dom.closest('.workspace-leaf-content');
	if (!leaf) return false;
	var sv = leaf.querySelector('.markdown-source-view');
	return !!sv && !sv.classList.contains('is-live-preview');
}

/* ---------- 编辑器（Live Preview）---------- */

var CheckboxWidget = class extends cmView.WidgetType {
	constructor(checked, pos, plugin) {
		super();
		this.checked = checked;
		this.pos = pos;
		this.plugin = plugin;
	}
	eq(other) {
		return other.checked === this.checked && other.pos === this.pos;
	}
	toDOM(view) {
		var box = document.createElement('input');
		box.type = 'checkbox';
		box.className = 'itd-box';
		box.checked = this.checked;
		box.addEventListener('mousedown', function (e) { e.preventDefault(); });
		box.addEventListener('click', function (e) {
			e.preventDefault();
			view.dispatch({
				changes: {
					from: this.pos,
					to: this.pos + (this.checked ? 3 : 2),
					insert: this.checked ? '[]' : '[x]'
				}
			});
			if (this.plugin) {
				var mv = this.plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
				this.plugin._emitChanged(mv && mv.file ? mv.file.path : null);
			}
		}.bind(this));
		return box;
	}
	ignoreEvent() { return true; }
};

function buildDecos(view, plugin) {
	if (isSourceMode(view)) return cmView.Decoration.none;
	var out = [];
	var visible = view.visibleRanges;
	for (var r = 0; r < visible.length; r++) {
		var range = visible[r];
		var text = view.state.sliceDoc(range.from, range.to);
		var re = /\[([xX]?)\]/g;
		var m;
		while ((m = re.exec(text))) {
			var tok = m[0];
			var s = range.from + m.index;
			var checked = m[1] !== '';
			if (inCode(view.state, s)) continue;
			var contentStart = s + tok.length;
			var searchEnd = Math.min(range.to, contentStart + 4000);
			var after = view.state.sliceDoc(contentStart, searchEnd);
			var endRel = findUnescapedSlash(after, 0);
			if (endRel < 0) continue;
			var contentEnd = contentStart + endRel;
			if (inCode(view.state, contentEnd)) continue;
			var contentStr = after.slice(0, endRel);

			// 光标位于该待办语法范围内（含结束符）→ 显示原始语法，方便编辑
			var sel = view.state.selection;
			var cursorInside = false;
			for (var ri = 0; ri < sel.ranges.length; ri++) {
				var h = sel.ranges[ri].head, an = sel.ranges[ri].anchor;
				if ((h >= s && h <= contentEnd + 1) || (an >= s && an <= contentEnd + 1)) {
					cursorInside = true;
					break;
				}
			}
			if (cursorInside) {
				re.lastIndex = m.index + tok.length + endRel + 1;
				continue;
			}

			// 起始标记 → 复选框
			out.push({ f: s, t: s + tok.length, k: 'w', w: new CheckboxWidget(checked, s, plugin) });

			// 内容中的转义反斜杠 "\/"：隐藏反斜杠，斜杠原样显示
			var hides = [], kk = 0;
			while ((kk = contentStr.indexOf('\\/', kk)) !== -1) { hides.push(kk); kk += 2; }
			for (var h = 0; h < hides.length; h++) {
				out.push({ f: contentStart + hides[h], t: contentStart + hides[h] + 1, k: 'h' });
			}

			// 完成态：内容逐行加 mark（避开反斜杠位置）
			if (checked && contentStr.length) {
				var segs = [], segStart = 0;
				for (var q = 0; q < hides.length; q++) {
					if (hides[q] > segStart) segs.push([segStart, hides[q]]);
					segStart = hides[q] + 1;
				}
				if (segStart < contentStr.length) segs.push([segStart, contentStr.length]);
				for (var gi = 0; gi < segs.length; gi++) {
					var p = contentStart + segs[gi][0];
					var segEndAbs = contentStart + segs[gi][1];
					while (p < segEndAbs) {
						var line = view.state.doc.lineAt(p);
						var stop = Math.min(line.to, segEndAbs);
						out.push({ f: p, t: stop, k: 'm' });
						p = stop + 1;
					}
				}
			}

			// 结束符 → 隐藏
			out.push({ f: contentEnd, t: contentEnd + 1, k: 'h' });
			re.lastIndex = m.index + tok.length + endRel + 1;
		}
	}
	out.sort(function (a, b) { return a.f - b.f || a.t - b.t; });
	var builder = new cmState.RangeSetBuilder();
	for (var i = 0; i < out.length; i++) {
		var d = out[i];
		if (d.k === 'w') builder.add(d.f, d.t, cmView.Decoration.replace({ widget: d.w }));
		else if (d.k === 'h') builder.add(d.f, d.t, cmView.Decoration.replace({}));
		else builder.add(d.f, d.t, cmView.Decoration.mark({ class: 'itd-done' }));
	}
	return builder.finish();
}

/* ---------- 阅读模式 ---------- */

function collectTextNodes(el) {
	var nodes = [];
	var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
		acceptNode: function (nv) {
			var p = nv.parentElement;
			if (!p) return NodeFilter.FILTER_REJECT;
			if (p.closest('code, pre, .itd-box')) return NodeFilter.FILTER_REJECT;
			return NodeFilter.FILTER_ACCEPT;
		}
	});
	var tn;
	while ((tn = w.nextNode())) nodes.push(tn);
	return nodes;
}

function buildOffsetMap(nodes) {
	var starts = [], acc = 0, parts = [];
	for (var i = 0; i < nodes.length; i++) {
		parts.push(nodes[i].nodeValue);
		starts.push(acc);
		acc += nodes[i].nodeValue.length;
	}
	return { starts: starts, parts: parts, combined: parts.join('') };
}

function makeLocate(starts, nodes) {
	return function (off) {
		for (var j = nodes.length - 1; j >= 0; j--) {
			if (off >= starts[j]) return { node: nodes[j], offset: off - starts[j] };
		}
		return { node: nodes[0], offset: 0 };
	};
}

function makeRange(a, b) {
	var r = document.createRange();
	r.setStart(a.node, a.offset);
	r.setEnd(b.node, b.offset);
	return r;
}

// 对单个块级元素处理一个待办；处理到返回 true（外层循环驱动）
function processBlockOnce(el, plugin, ctx) {
	var nodes = collectTextNodes(el);
	if (!nodes.length) return false;
	var map = buildOffsetMap(nodes);
	var combined = map.combined;
	var locate = makeLocate(map.starts, nodes);

	// 找第一个完整的待办
	var re = /\[([xX]?)\]/g, m, match = null;
	while ((m = re.exec(combined))) {
		var cs = m.index + m[0].length;
		var slash = findUnescapedSlash(combined, cs);
		if (slash >= 0) {
			match = { s: m.index, tok: m[0], checked: m[1] !== '', cs: cs, e: slash };
			break;
		}
	}
	if (!match) return false;

	// 1) 删除起始标记，原位插入复选框
	var a = locate(match.s), b = locate(match.s + match.tok.length);
	var r1 = makeRange(a, b);
	r1.deleteContents();
	var box = document.createElement('input');
	box.type = 'checkbox';
	box.className = 'itd-box';
	box.checked = match.checked;
	box.dataset.norm = normText(combined.slice(match.cs, match.e));
	if (ctx && ctx.sourcePath) box.dataset.src = ctx.sourcePath;
	box.addEventListener('change', function () { handleToggle(plugin, box, ctx); });
	r1.insertNode(box);

	// 2) 重新收集（复选框插入导致文本节点可能被拆分）
	var nodes2 = collectTextNodes(el);
	if (!nodes2.length) return true;
	var map2 = buildOffsetMap(nodes2);
	var combined2 = map2.combined;
	var locate2 = makeLocate(map2.starts, nodes2);

	// 内容起点 = 第一个位于复选框之后的文本节点开头
	var contentStart = combined2.length;
	for (var x = 0; x < nodes2.length; x++) {
		if (box.compareDocumentPosition(nodes2[x]) & Node.DOCUMENT_POSITION_FOLLOWING) {
			contentStart = map2.starts[x];
			break;
		}
	}
	var slashIdx = findUnescapedSlash(combined2, contentStart);
	if (slashIdx < 0) return true;

	// 先删结束符 "/"（后删不影响前面的偏移）
	makeRange(locate2(slashIdx), locate2(slashIdx + 1)).deleteContents();

	// 再抽取内容包进 span
	var c1 = locate2(contentStart), c2 = locate2(slashIdx);
	var r2 = makeRange(c1, c2);
	var frag = r2.extractContents();
	var span = document.createElement('span');
	span.className = 'itd-content' + (match.checked ? ' itd-done' : '');
	span.appendChild(frag);
	r2.insertNode(span);

	// 还原内容中的转义："\/" → "/"
	var uw = document.createTreeWalker(span, NodeFilter.SHOW_TEXT, null);
	var un;
	while ((un = uw.nextNode())) {
		if (un.nodeValue.indexOf('\\/') !== -1) {
			un.nodeValue = un.nodeValue.replace(/\\\//g, '/');
		}
	}
	return true;
}

// 阅读模式点击：定位源文件中对应待办并翻转（走编辑器事务，避免整页重渲染闪动）
function domOccurrenceIndex(box) {
	var root = box.closest('.markdown-preview-view, .markdown-rendered');
	if (!root) return -1;
	var all = root.querySelectorAll('input.itd-box');
	var n = 0;
	for (var i = 0; i < all.length; i++) {
		if (all[i] === box) return n;
		if (all[i].dataset.src === box.dataset.src) n++;
	}
	return -1;
}

async function handleToggle(plugin, box, ctx) {
	try {
		var sourcePath = ctx && ctx.sourcePath;
		if (!sourcePath) return;
		var file = plugin.app.vault.getAbstractFileByPath(sourcePath);
		if (!file) return;
		var want = box.dataset.norm || '';

		// 若当前活动视图就是该文件，直接用其编辑器（不触发阅读视图重渲染）
		var view = plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
		var ed = (view && view.file && view.file.path === sourcePath && view.editor) ? view.editor : null;
		var docText = ed ? ed.getValue() : await plugin.app.vault.read(file);

		TODO_SCAN_RE.lastIndex = 0;
		var matches = [], mm;
		while ((mm = TODO_SCAN_RE.exec(docText))) matches.push(mm);
		if (!matches.length) return;

		// 优先按 DOM 顺序定位（解决同内容待办串位），失败再按内容匹配
		var target = -1;
		var idx = domOccurrenceIndex(box);
		if (idx >= 0 && idx < matches.length && normText(matches[idx][2]) === want) {
			target = idx;
		} else {
			for (var i = 0; i < matches.length; i++) {
				if (normText(matches[i][2]) === want) { target = i; break; }
			}
		}
		if (target < 0) {
			console.warn('[inline-todo] 未在源文件中找到对应待办:', want);
			return;
		}

		var hit = matches[target];
		var tokLen = hit[1] ? 3 : 2;
		var newTok = box.checked ? '[x]' : '[]';

		if (ed) {
			ed.replaceRange(newTok, ed.offsetToPos(hit.index), ed.offsetToPos(hit.index + tokLen));
			// 原地补样式，不重渲染
			var span = box.nextElementSibling;
			if (span && span.classList.contains('itd-content')) {
				span.classList.toggle('itd-done', box.checked);
			}
			plugin._emitChanged(sourcePath);
		} else {
			// 嵌入等场景兜底：整篇改写 + 重渲染
			var src = await plugin.app.vault.read(file);
			var newSrc = src.slice(0, hit.index) + newTok + src.slice(hit.index + tokLen);
			await plugin.app.vault.modify(file, newSrc);
			if (view && view.previewMode) view.previewMode.rerender(true);
			plugin._emitChanged(sourcePath);
		}
	} catch (err) {
		console.error('[inline-todo] 勾选回写失败:', err);
	}
}

/* ---------- 插件 ---------- */

var InlineTodoPlugin = class extends obsidian.Plugin {
	async onload() {
		var self = this;

		// ---- 对外 API：供其他插件 / DataviewJS / 统计脚本读取行内待办 ----
		this.api = {
			version: '0.3.0',
			// 读取单个笔记的全部行内待办（按文档顺序）
			getTodos: function (path) { return self._getTodos(path); },
			// 扫描全库，返回 { 路径: 待办数组 }，只含有待办的笔记
			getAll: function () { return self._getAllTodos(); },
			// 监听勾选变化，回调参数为文件路径；返回引用可传 offref 取消
			onChanged: function (cb) { return self.app.workspace.on('inline-todo:changed', cb); }
		};

		this.registerMarkdownPostProcessor(function (el, ctx) {
			if (!(el instanceof HTMLElement)) return;
			var sel = 'p, li, h1, h2, h3, h4, h5, h6, td, th';
			var blocks = [];
			if (el.matches && el.matches(sel)) blocks.push(el);
			var found = el.querySelectorAll(sel);
			for (var i = 0; i < found.length; i++) blocks.push(found[i]);
			for (var j = 0; j < blocks.length; j++) {
				var guard = 0;
				while (processBlockOnce(blocks[j], self, ctx) && guard++ < 200) {}
			}
		});
		this.registerEditorExtension([
			cmView.ViewPlugin.fromClass(class {
				constructor(view) { this.decorations = buildDecos(view, self); }
				update(u) { this.decorations = buildDecos(u.view, self); }
			}, {
				decorations: function (v) { return v.decorations; }
			})
		]);
	}

	_emitChanged(path) {
		try { this.app.workspace.trigger('inline-todo:changed', path || null); } catch (e) { /* ignore */ }
	}

	async _getTodos(path) {
		var file = this.app.vault.getAbstractFileByPath(path);
		if (!file || !this.app.vault.cachedRead) return [];
		var text = await this.app.vault.cachedRead(file);
		return scanTodos(text);
	}

	async _getAllTodos() {
		var out = {};
		var files = this.app.vault.getMarkdownFiles();
		for (var i = 0; i < files.length; i++) {
			try {
				var text = await this.app.vault.cachedRead(files[i]);
				var todos = scanTodos(text);
				if (todos.length) out[files[i].path] = todos;
			} catch (e) { /* 跳过读取失败的文件 */ }
		}
		return out;
	}
};

module.exports = InlineTodoPlugin;
