/* ============================================================
   行内待办 Inline Todo  v0.4.0
   语法一（正文随手待办）：[]内容/ 未完成，[x]内容/ 已完成
   语法二（标准任务横排）：- [ ] 内容/ 行尾斜杠 = 与下一行拼一行
   - 行尾 / 渲染时隐藏；内容里的字面斜杠写作 \/
   - 标准任务横排：链内普通文字行被吸收，无斜杠任务行结束链，
     空行/标题/引用/代码块/其他列表断链
   - 内容可跨行（同一段落内软换行），内部 Markdown 原生渲染
   - 行内代码/代码块中跳过；源码模式不渲染；光标进入露出源码
   - 对外 API：app.plugins.plugins["inline-todo"].api
   ============================================================ */
'use strict';

var obsidian = require('obsidian');
var cmView = require('@codemirror/view');
var cmState = require('@codemirror/state');
var cmLang = require('@codemirror/language');

var TODO_SCAN_RE = /\[([xX]?)\]((?:[^/\\]|\\.)*)\//g;
var TASK_LINE_RE = /^- \[([xX ])\] ?(.*)$/;
var ENDS_SLASH_RE = /(?:^|[^\\])\/$/;

/* ---------- 工具 ---------- */

function normText(s) {
	return s.replace(/[*_~`\\]/g, '').replace(/\s+/g, ' ').trim();
}

function findUnescapedSlash(str, from) {
	var i = str.indexOf('/', from);
	while (i !== -1 && i > 0 && str[i - 1] === '\\') i = str.indexOf('/', i + 1);
	return i;
}

// 去掉行尾未转义的 "/"（及其前导空白）
function stripTrailingSlash(t) {
	var m = t.match(/^(.*[^\\])\/\s*$/);
	return m ? m[1].replace(/\s+$/, '') : t;
}

function inCode(state, pos) {
	var node = cmLang.syntaxTree(state).resolveInner(pos, -1);
	for (var n = node; n; n = n.parent) {
		if (/code/i.test(n.name || '')) return true;
	}
	return false;
}

// 是否落在原生任务复选框标记内（避免 "- [x] 任务" 被误认成行内待办）
function inTaskMarker(state, pos) {
	var node = cmLang.syntaxTree(state).resolveInner(pos, -1);
	for (var n = node; n; n = n.parent) {
		if (/TaskMarker/i.test(n.name || '')) return true;
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

// 扫描一段 Markdown 源文，返回全部行内待办（供 API 与回写定位共用）
function scanTodos(text) {
	TODO_SCAN_RE.lastIndex = 0;
	var res = [], m;
	while ((m = TODO_SCAN_RE.exec(text))) {
		var before = text.slice(0, m.index);
		var nl = before.lastIndexOf('\n');
		res.push({
			checked: m[1] !== '',
			text: stripTrailingSlash(m[2].replace(/\\\//g, '/')),
			raw: m[0],
			index: m.index,
			line: before.split('\n').length - 1,
			column: m.index - (nl + 1)
		});
	}
	return res;
}

/* ---------- 链（标准任务横排）计算：纯源文行级 ---------- */

function chainBreakerLine(t) {
	if (/^\s/.test(t)) return true;                                  // 缩进（子项等）
	if (/^#{1,6} /.test(t)) return true;                             // 标题
	if (/^>/.test(t)) return true;                                   // 引用/标注
	if (/^```/.test(t)) return true;                                 // 代码块
	if (/^\|/.test(t)) return true;                                  // 表格
	if (/^(-{3,}|\*{3,})\s*$/.test(t)) return true;                  // 分隔线
	if (/^(\d+\. |- )/.test(t) && !TASK_LINE_RE.test(t)) return true; // 其他列表项
	return false;
}

// 入参 lines 为字符串数组（不含换行符）；行号 1-based
function computeChainsFromLines(lines) {
	var chains = [], cur = null, member = {};
	for (var i = 0; i < lines.length; i++) {
		var text = lines[i];
		if (!text.trim() || chainBreakerLine(text)) { cur = null; continue; }
		var m = text.match(TASK_LINE_RE);
		var endsSlash = ENDS_SLASH_RE.test(text);
		if (m) {
			if (endsSlash) {
				if (!cur) { cur = []; chains.push(cur); }
				cur.push(i + 1);
				member[i + 1] = true;
			} else {
				cur = null; // 无斜杠任务行：不吸收，结束链
			}
		} else if (cur) {
			cur.push(i + 1); // 普通文字行：被动吸收
			member[i + 1] = true;
		}
	}
	return { chains: chains, member: member };
}

function computeChains(doc) {
	var lines = [];
	for (var i = 1; i <= doc.lines; i++) lines.push(doc.line(i).text);
	return computeChainsFromLines(lines);
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

var ChainWidget = class extends cmView.WidgetType {
	constructor(rows, sig, plugin) {
		super();
		this.rows = rows;
		this.sig = sig;
		this.plugin = plugin;
	}
	eq(other) {
		return other.sig === this.sig;
	}
	toDOM(view) {
		var wrap = document.createElement('span');
		wrap.className = 'itd-chain-row';
		var self = this;
		this.rows.forEach(function (r) {
			if (r.isTask) {
				var box = document.createElement('input');
				box.type = 'checkbox';
				box.className = 'itd-box';
				box.checked = r.checked;
				box.addEventListener('mousedown', function (e) { e.preventDefault(); });
				box.addEventListener('click', function (e) {
					e.preventDefault();
					view.dispatch({
						changes: { from: r.tokAbs + 1, to: r.tokAbs + 2, insert: r.checked ? ' ' : 'x' }
					});
					if (self.plugin) {
						var mv = self.plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
						self.plugin._emitChanged(mv && mv.file ? mv.file.path : null);
					}
				});
				wrap.appendChild(box);
				var sp = document.createElement('span');
				sp.textContent = r.text;
				if (r.checked) sp.className = 'itd-done';
				wrap.appendChild(sp);
			} else {
				var sp2 = document.createElement('span');
				sp2.textContent = r.text;
				wrap.appendChild(sp2);
			}
		});
		return wrap;
	}
	ignoreEvent() { return true; }
};

function buildDecosEntry(view, plugin) {
	if (isSourceMode(view)) return cmView.Decoration.none;
	var out = [];
	var doc = view.state.doc;

	// ---- 标准任务横排链 → 块级替换 ----
	var chain = computeChains(doc);

	for (var ci = 0; ci < chain.chains.length; ci++) {
		var ls = chain.chains[ci];
		var from = doc.line(ls[0]).from;
		var to = doc.line(ls[ls.length - 1]).to;
		if (inCode(view.state, from)) continue;

		// 光标在链内 → 显示原始源码
		var sel = view.state.selection, inside = false;
		for (var ri = 0; ri < sel.ranges.length; ri++) {
			var h = sel.ranges[ri].head, an = sel.ranges[ri].anchor;
			if ((h >= from && h <= to + 1) || (an >= from && an <= to + 1)) { inside = true; break; }
		}
		if (inside) continue;

		var rows = [], sig = [];
		for (var li = 0; li < ls.length; li++) {
			var l = doc.line(ls[li]);
			var mm = l.text.match(TASK_LINE_RE);
			if (mm) {
				var checked = mm[1] === 'x' || mm[1] === 'X';
				rows.push({
					isTask: true,
					checked: checked,
					tokAbs: l.from + l.text.indexOf('['),
					text: stripTrailingSlash(mm[2])
				});
				sig.push(checked ? 'x' : 'o');
			} else {
				rows.push({ isTask: false, text: stripTrailingSlash(l.text) });
				sig.push('t');
			}
		}
		out.push({ f: from, t: to, k: 'c', rows: rows, sig: sig.join('|') });
	}

	// ---- 行内 []x/ 待办 ----
	var visible = view.visibleRanges;
	for (var r = 0; r < visible.length; r++) {
		var range = visible[r];
		var text = view.state.sliceDoc(range.from, range.to);
		var re = /\[([xX]?)\]/g;
		var m;
		while ((m = re.exec(text))) {
			var tok = m[0];
			var s = range.from + m.index;
			var checked2 = m[1] !== '';
			if (inCode(view.state, s) || inTaskMarker(view.state, s)) continue;
			if (chain.member[doc.lineAt(s).number]) continue; // 链内行由块级装饰接管
			var contentStart = s + tok.length;
			var searchEnd = Math.min(range.to, contentStart + 4000);
			var after = view.state.sliceDoc(contentStart, searchEnd);
			var endRel = findUnescapedSlash(after, 0);
			if (endRel < 0) continue;
			var contentEnd = contentStart + endRel;
			if (inCode(view.state, contentEnd)) continue;
			var contentStr = after.slice(0, endRel);

			out.push({ f: s, t: s + tok.length, k: 'w', w: new CheckboxWidget(checked2, s, plugin) });

			var hides = [], kk = 0;
			while ((kk = contentStr.indexOf('\\/', kk)) !== -1) { hides.push(kk); kk += 2; }
			for (var h2 = 0; h2 < hides.length; h2++) {
				out.push({ f: contentStart + hides[h2], t: contentStart + hides[h2] + 1, k: 'h' });
			}

			if (checked2 && contentStr.length) {
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
						var line = doc.lineAt(p);
						var stop = Math.min(line.to, segEndAbs);
						out.push({ f: p, t: stop, k: 'm' });
						p = stop + 1;
					}
				}
			}

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
		else if (d.k === 'c') builder.add(d.f, d.t, cmView.Decoration.replace({ block: true, widget: new ChainWidget(d.rows, d.sig, plugin) }));
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

function processBlockOnce(el, plugin, ctx) {
	var nodes = collectTextNodes(el);
	if (!nodes.length) return false;
	var map = buildOffsetMap(nodes);
	var combined = map.combined;
	var locate = makeLocate(map.starts, nodes);

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

	var nodes2 = collectTextNodes(el);
	if (!nodes2.length) return true;
	var map2 = buildOffsetMap(nodes2);
	var combined2 = map2.combined;
	var locate2 = makeLocate(map2.starts, nodes2);

	var contentStart = combined2.length;
	for (var x = 0; x < nodes2.length; x++) {
		if (box.compareDocumentPosition(nodes2[x]) & Node.DOCUMENT_POSITION_FOLLOWING) {
			contentStart = map2.starts[x];
			break;
		}
	}
	var slashIdx = findUnescapedSlash(combined2, contentStart);
	if (slashIdx < 0) return true;

	makeRange(locate2(slashIdx), locate2(slashIdx + 1)).deleteContents();

	var c1 = locate2(contentStart), c2 = locate2(slashIdx);
	var r2 = makeRange(c1, c2);
	var frag = r2.extractContents();
	var span = document.createElement('span');
	span.className = 'itd-content' + (match.checked ? ' itd-done' : '');
	span.appendChild(frag);
	r2.insertNode(span);

	var uw = document.createTreeWalker(span, NodeFilter.SHOW_TEXT, null);
	var un;
	while ((un = uw.nextNode())) {
		if (un.nodeValue.indexOf('\\/') !== -1) {
			un.nodeValue = un.nodeValue.replace(/\\\//g, '/');
		}
	}
	return true;
}

// 阅读模式：隐藏元素内最后一个非空文本节点行尾的 "/"（链成员行）
function stripTrailingSlashDom(root) {
	var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
	var nodes = [], n;
	while ((n = w.nextNode())) nodes.push(n);
	for (var i = nodes.length - 1; i >= 0; i--) {
		var v = nodes[i].nodeValue;
		if (!v || !v.trim()) continue;
		var m = v.match(/^(.*[^\\])\/\s*$/);
		if (m) nodes[i].nodeValue = m[1].replace(/\s+$/, '');
		break;
	}
}

async function handleToggle(plugin, box, ctx) {
	try {
		var sourcePath = ctx && ctx.sourcePath;
		if (!sourcePath) return;
		var file = plugin.app.vault.getAbstractFileByPath(sourcePath);
		if (!file) return;
		var want = box.dataset.norm || '';

		var view = plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
		var ed = (view && view.file && view.file.path === sourcePath && view.editor) ? view.editor : null;
		var docText = ed ? ed.getValue() : await plugin.app.vault.read(file);

		TODO_SCAN_RE.lastIndex = 0;
		var matches = [], mm;
		while ((mm = TODO_SCAN_RE.exec(docText))) matches.push(mm);
		if (!matches.length) return;

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
			var span = box.nextElementSibling;
			if (span && span.classList.contains('itd-content')) {
				span.classList.toggle('itd-done', box.checked);
			}
			plugin._emitChanged(sourcePath);
		} else {
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

/* ---------- 插件 ---------- */

var InlineTodoPlugin = class extends obsidian.Plugin {
	async onload() {
		var self = this;

		this.api = {
			version: '0.4.0',
			getTodos: function (path) { return self._getTodos(path); },
			getAll: function () { return self._getAllTodos(); },
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
			// 标准任务横排：列表节 / 段落节
			var secEl = (el.matches && el.matches('ul, p')) ? el : null;
			if (secEl && ctx.getSectionInfo) {
				var info = ctx.getSectionInfo(secEl);
				if (info) self.applyChainStyling(secEl, ctx, info);
			}
		});
		this.registerEditorExtension([
			cmView.ViewPlugin.fromClass(class {
				constructor(view) { this.decorations = buildDecosEntry(view, self); }
				update(u) { this.decorations = buildDecosEntry(u.view, self); }
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

	// 标准任务横排：给链成员的 ul / p 加显示类（数据不动，纯显示层）
	async applyChainStyling(secEl, ctx, info) {
		try {
			var sourcePath = ctx && ctx.sourcePath;
			if (!sourcePath) return;
			var file = this.app.vault.getAbstractFileByPath(sourcePath);
			if (!file) return;
			var text = await this.app.vault.cachedRead(file);
			if (!secEl.isConnected) return;
			var chain = computeChainsFromLines(text.split('\n'));
			var lineNo = info.lineStart + 1; // getSectionInfo 的 line 是 0-based
			if (!chain.member[lineNo]) return;
			secEl.classList.add('itd-run');
			if (secEl.tagName === 'UL') {
				var lis = secEl.querySelectorAll(':scope > li');
				for (var i = 0; i < lis.length; i++) {
					if (!chain.member[lineNo + i]) break;
					stripTrailingSlashDom(lis[i]);
				}
			} else {
				stripTrailingSlashDom(secEl);
			}
		} catch (err) {
			console.error('[inline-todo] 横排样式失败:', err);
		}
	}
};

module.exports = InlineTodoPlugin;
