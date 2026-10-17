/* ============================================================
   行内待办 Inline Todo  v0.4.3
   语法一（正文随手待办）：[]内容/ 未完成，[x]内容/ 已完成
   语法二（标准任务横排）：连续非空行块中任意任务行以 / 结尾，
   整块横排一行显示（行尾 / 隐藏）；想断开就插入空行
   - 数据层完全标准：Tasks / Dataview / 一切统计原生识别
   - 内容可跨行（同一段落内软换行），内部 Markdown 原生渲染
   - 行内代码/代码块中跳过；源码模式不渲染；光标进入露出源码
   - 横排装饰经 StateField 提供（CM6 禁止 ViewPlugin 提供块级装饰）
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
	return s.replace(/[*_~`\\=]/g, '').replace(/\s+/g, ' ').trim();
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

/* ---------- 链（标准任务横排）计算：块级规则 ----------
   连续非空行 = 一个块；块内只要有任务行以 / 结尾，整块横排。
   标题/引用/代码块/表格/分隔线/缩进/其他列表项会把块切断。 */

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

// 空白段（连续空行）范围：ln 上方/下方紧邻的连续空行段 [startLine, endLine]（1-based），没有则 null
function gapRangeAround(lines, ln, dir) {
	if (dir < 0) {
		if (ln < 2 || lines[ln - 2].trim()) return null;
		var s = ln - 1;
		while (s > 1 && !lines[s - 2].trim()) s--;
		return [s, ln - 1];
	}
	if (ln > lines.length - 1 || lines[ln].trim()) return null;
	var e = ln + 1;
	while (e < lines.length && !lines[e].trim()) e++;
	return [ln + 1, e];
}

// 入参 lines 为字符串数组（不含换行符）；行号 1-based
// meta 与 chains 平行：首/末行是否待办行、上/下方紧邻空段范围（空段减一规则用）
function computeChainsFromLines(lines) {
	// 横排规则：连续非空行构成一个块（标题/引用/代码/表格/缩进/其他列表项断开），
	// 块内只要有任务行以 / 结尾，整块拼一行（含纯文字行、普通待办行）；想断开就插入空行
	// 空段规则（v0.4.2）：待办只辐射紧邻的上/下各一行——是文字就连进本行，是空行则该空行消失
	// （N 个回车显示 N-1 个）；边界是文字行时相邻空段不动
	var chains = [], member = {}, meta = [];
	var i = 0;
	while (i < lines.length) {
		if (!lines[i].trim() || chainBreakerLine(lines[i])) { i++; continue; }
		var block = [], hasSlash = false, hasTask = false, j = i;
		while (j < lines.length && lines[j].trim() && !chainBreakerLine(lines[j])) {
			if (ENDS_SLASH_RE.test(lines[j])) hasSlash = true;
			if (TASK_LINE_RE.test(lines[j])) hasTask = true;
			block.push(j + 1);
			j++;
		}
		if (hasSlash && hasTask) {
			chains.push(block);
			for (var k2 = 0; k2 < block.length; k2++) member[block[k2]] = true;
			meta.push({
				firstTask: TASK_LINE_RE.test(lines[block[0] - 1]),
				lastTask: TASK_LINE_RE.test(lines[block[block.length - 1] - 1]),
				upGap: gapRangeAround(lines, block[0], -1),
				downGap: gapRangeAround(lines, block[block.length - 1], 1)
			});
		}
		i = j;
	}
	return { chains: chains, member: member, meta: meta };
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
		// 链内文字用 Obsidian 原生 Markdown 渲染（异步，失败退回纯文本）
		var renderMd = null;
		try {
			var MR = obsidian.MarkdownRenderer;
			if (MR && typeof MR.render === 'function' && self.plugin) {
				var mv0 = self.plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
				var path0 = mv0 && mv0.file ? mv0.file.path : '';
				renderMd = function (text, sp) {
					if (!text) return;
					var holder = document.createElement('span');
					MR.render(self.plugin.app, text, holder, path0, self.plugin).then(function () {
						if (!sp.isConnected) return;
						var src = holder.querySelector(':scope > p') || holder;
						while (sp.firstChild) sp.removeChild(sp.firstChild);
						while (src.firstChild) sp.appendChild(src.firstChild);
					}).catch(function () { /* 保留纯文本占位 */ });
				};
			}
		} catch (e) { renderMd = null; }
		this.rows.forEach(function (r) {
			// 点击文字：露出源码并把光标定位到该行行首（块替换是原子的，光标进不来，只能主动露出）
			function revealSource(e) {
				e.preventDefault();
				view.dispatch({ selection: { anchor: r.lineFrom } });
				if (self.plugin) {
					var mv = self.plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
				}
			}
			if (r.isTask) {
				var box = document.createElement('input');
				box.type = 'checkbox';
				box.className = 'itd-box';
				box.checked = r.checked;
				box.addEventListener('mousedown', function (e) { e.preventDefault(); });
				box.addEventListener('click', function (e) {
					e.preventDefault();
					e.stopPropagation();
					view.dispatch({
						changes: { from: r.tokAbs + 1, to: r.tokAbs + 2, insert: r.checked ? ' ' : 'x' }
					});
					if (self.plugin) {
						var mv = self.plugin.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
					}
				});
				wrap.appendChild(box);
				var sp = document.createElement('span');
				sp.textContent = r.text;
				if (r.checked) sp.className = 'itd-done';
				sp.addEventListener('mousedown', function (e) { e.preventDefault(); });
				sp.addEventListener('click', revealSource);
				wrap.appendChild(sp);
				if (renderMd) { try { renderMd(r.text, sp); } catch (e) { /* 保留纯文本 */ } }
			} else {
				var sp2 = document.createElement('span');
				sp2.textContent = r.text;
				sp2.addEventListener('mousedown', function (e) { e.preventDefault(); });
				sp2.addEventListener('click', revealSource);
				wrap.appendChild(sp2);
				if (renderMd) { try { renderMd(r.text, sp2); } catch (e) { /* 保留纯文本 */ } }
			}
		});
		return wrap;
	}
	ignoreEvent() { return true; }
};

// 空块 widget：隐藏横排链后面的第一个空行（一个回车不显示，N 个回车显示 N-1 个）
var EmptyBlockWidget = class extends cmView.WidgetType {
	toDOM() {
		var s = document.createElement('span');
		s.className = 'itd-blank-hide';
		return s;
	}
	eq() { return true; }
};

// StateField：横排链的块级装饰（CM6 要求块级装饰必须直接提供，不能走 ViewPlugin）
function buildChainDecos(state, plugin) {
	var doc = state.doc;
	// 源码模式（非实时预览）完全不渲染，保持原始 Markdown
	var lpOn = obsidian.editorLivePreviewField ? state.facet(obsidian.editorLivePreviewField) : true;
	if (!lpOn) return cmView.Decoration.none;
		var chain = computeChains(doc);
		var out = [];
		var skipCursor = 0, skipCode = 0;
		var sel = state.selection;
		function cursorInRange(f, t) {
			for (var ri = 0; ri < sel.ranges.length; ri++) {
				var h = sel.ranges[ri].head, an = sel.ranges[ri].anchor;
				if ((h >= f && h <= t) || (an >= f && an <= t)) return true;
			}
			return false;
		}
		// 空段减一（v0.4.2）：待办只辐射紧邻上/下各一行。
		// 链边界行是待办 → 紧邻空行隐藏一个（N 个回车显示 N-1 个）；
		// 边界是文字行 → 相邻空段不动。同一空段被多条链共享时只减一次。
		var shrunkGaps = {};
		function shrinkGap(gap, adjacentLn) {
			if (!gap || shrunkGaps[gap[0] + ':' + gap[1]]) return;
			var bl = doc.line(adjacentLn);
			if (bl.text.trim() || cursorInRange(bl.from, bl.to)) return;
			shrunkGaps[gap[0] + ':' + gap[1]] = 1;
			out.push(cmView.Decoration.replace({ block: true, widget: new EmptyBlockWidget() }).range(bl.from, bl.to));
		}
		for (var ci = 0; ci < chain.chains.length; ci++) {
			var ls = chain.chains[ci];
			var from = doc.line(ls[0]).from;
			var to = doc.line(ls[ls.length - 1]).to;
			if (inCode(state, from)) { skipCode++; continue; }

			// 光标在链内 → 显示原始源码
			if (cursorInRange(from, to + 1)) { skipCursor++; continue; }

			var mt = chain.meta[ci];
			if (mt && mt.firstTask) shrinkGap(mt.upGap, ls[0] - 1); // 上方紧邻空行
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
					lineFrom: l.from,
					text: stripTrailingSlash(mm[2])
				});
				sig.push(checked ? 'x' : 'o');
			} else {
				rows.push({ isTask: false, lineFrom: l.from, text: stripTrailingSlash(l.text) });
				sig.push('t');
			}
		}
		// 统一收尾：链的 widget + 下方紧邻空行（边界是待办才减一）
		out.push(cmView.Decoration.replace({ block: true, widget: new ChainWidget(rows, sig.join('|'), plugin) }).range(from, to));
		if (mt && mt.lastTask) shrinkGap(mt.downGap, ls[ls.length - 1] + 1);
	}
	return cmView.Decoration.set(out, true);
}

// ViewPlugin：行内 []x/ 待办（仅行内装饰，视口内）
function buildInlineDecos(view, plugin) {
	var out = [];
	var doc = view.state.doc;
	// 源码模式（非实时预览）完全不渲染，保持原始 Markdown
	if (obsidian.editorLivePreviewField && !view.state.facet(obsidian.editorLivePreviewField)) {
		return cmState.RangeSet.empty;
	}
	// 光标所在待办露出源码（方便编辑 [] 标记与结束符 /）
	var selRanges = view.state.selection.ranges;
	function cursorIn(f, t) {
		for (var rr = 0; rr < selRanges.length; rr++) {
			var hh = selRanges[rr].head, aa = selRanges[rr].anchor;
			if ((hh >= f && hh <= t) || (aa >= f && aa <= t)) return true;
		}
		return false;
	}
	var chain = computeChains(doc);
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
			if (chain.member[doc.lineAt(s).number]) continue; // 链内行由 StateField 块级装饰接管
			var contentStart = s + tok.length;
			var searchEnd = Math.min(range.to, contentStart + 4000);
			var after = view.state.sliceDoc(contentStart, searchEnd);
			var endRel = findUnescapedSlash(after, 0);
			if (endRel < 0) continue;
			var contentEnd = contentStart + endRel;
			if (inCode(view.state, contentEnd)) continue;
			var contentStr = after.slice(0, endRel);
			// 光标在该待办范围内 → 跳过装饰，露出原始语法（[]文字/）
			if (cursorIn(s, contentEnd + 1)) { re.lastIndex = contentEnd + 1; continue; }

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
			if (p.closest('.itd-box')) return NodeFilter.FILTER_REJECT;
			// 注意：code/pre 内文字现在也收集（否则含行内代码的待办 norm 失配、勾选回写失败），
			// 是否处于代码内由 inCodeNode 在匹配阶段判断
			return NodeFilter.FILTER_ACCEPT;
		}
	});
	var tn;
	while ((tn = w.nextNode())) nodes.push(tn);
	return nodes;
}

// DOM 位置是否处于行内代码/代码块内（用于排除代码里的 "[]x/"）
function inCodeNode(loc) {
	var el = loc && loc.node ? loc.node.parentElement : null;
	return !!(el && el.closest && el.closest('code, pre'));
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

// 源文件待办内容 norm 集合（用于阅读模式下校验结束符：\/ 在渲染文本中已变成 /，需要借助源文件找回真正的结束符）
function getSourceTodoNorms(plugin, ctx) {
	try {
		var sp = ctx && ctx.sourcePath;
		if (!sp) return null;
		// 与链数据同源取文本：不能只看活动视图（预览渲染时活动视图可能不是本文件）
		var text = plugin._getSourceText(sp);
		if (text === null) return null;
		if (plugin._normCache && plugin._normCache.path === sp && plugin._normCache.len === text.length) return plugin._normCache.norms;
		var todos = scanTodos(text);
		var norms = {};
		for (var i = 0; i < todos.length; i++) norms[normText(todos[i].text)] = true;
		plugin._normCache = { path: sp, len: text.length, norms: norms };
		return norms;
	} catch (e) { return null; }
}

function processBlockOnce(el, plugin, ctx) {
	var nodes = collectTextNodes(el);
	if (!nodes.length) return false;
	var map = buildOffsetMap(nodes);
	var combined = map.combined;
	var locate = makeLocate(map.starts, nodes);

	var re = /\[([xX]?)\]/g, m, match = null;
	var srcNorms = getSourceTodoNorms(plugin, ctx);
	while ((m = re.exec(combined))) {
		var cs = m.index + m[0].length;
		var slash = findUnescapedSlash(combined, cs);
		while (slash >= 0 && inCodeNode(locate(slash))) slash = findUnescapedSlash(combined, slash + 1);
		if (slash < 0) continue;
		// 行内代码/代码块里的 "[]x/" 不是待办
		if (inCodeNode(locate(m.index))) continue;
		// 转义斜杠（\/）在渲染文本中已是普通 /：逐个候选结束符向后试探，取内容与源文件待办一致的那个
		if (srcNorms) {
			var s2 = slash, hit2 = -1;
			while (s2 >= 0) {
				if (srcNorms[normText(combined.slice(cs, s2))]) { hit2 = s2; break; }
				s2 = findUnescapedSlash(combined, s2 + 1);
			}
			if (hit2 >= 0) slash = hit2;
		}
		match = { s: m.index, tok: m[0], checked: m[1] !== '', cs: cs, e: slash };
		break;
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
	while (slashIdx >= 0 && inCodeNode(locate2(slashIdx))) slashIdx = findUnescapedSlash(combined2, slashIdx + 1);
	// 转义斜杠（\/）在渲染文本里已是普通 /：向右试探，取内容与源文件待办一致的那个作为结束符
	if (srcNorms && slashIdx >= 0) {
		var s3 = slashIdx, hit3 = -1;
		while (s3 >= 0) {
			if (srcNorms[normText(combined2.slice(contentStart, s3))]) { hit3 = s3; break; }
			s3 = findUnescapedSlash(combined2, s3 + 1);
		}
		if (hit3 >= 0) slashIdx = hit3;
	}
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

// 取任务 li 里"任务自身文字"的节点集合：checkbox 之后、遇到嵌套块级元素或 <br>（懒续行）为止。
// 兼容两种结构：紧密（checkbox 是 li 直接子级）与松散（li > p > checkbox）
function liTaskParts(li) {
	var cb = li.querySelector('input[type=checkbox]');
	var container = cb ? cb.parentNode : li;
	var kids = Array.prototype.slice.call(container.childNodes);
	var cbSeen = false, parts = [];
	for (var k = 0; k < kids.length; k++) {
		var nd = kids[k];
		if (nd === cb) { cbSeen = true; continue; }
		if (!cbSeen) continue;
		if (nd.nodeType === 3) { parts.push(nd); continue; }
		if (nd.nodeType === 1) {
			var t = nd.tagName;
			if (t === 'BR') break; // 懒续行文字从 <br> 开始，不属于任务自身文字
			if (t === 'P' || t === 'UL' || t === 'OL' || t === 'DIV' || t === 'BLOCKQUOTE' || t === 'PRE') break;
			parts.push(nd);
		}
	}
	return parts;
}

// 剥掉任务自身文字行尾的 "/"（懒续行的嵌套段落不受影响）。返回是否剥了（= 是否横排成员）
function stripTaskSlash(li) {
	var parts = liTaskParts(li);
	for (var i = parts.length - 1; i >= 0; i--) {
		if (parts[i].nodeType !== 3) continue;
		var v = parts[i].nodeValue;
		if (!v || !v.trim()) continue;
		var m = v.match(/^(.*[^\\])\/\s*$/);
		if (m) {
			parts[i].nodeValue = m[1].replace(/\s+$/, '');
			return true;
		}
		return false;
	}
	return false;
}

// 已勾选任务项：仅给任务自身文字加完成样式（懒续行的嵌套段落不受影响）
function applyCheckedStrike(li) {
	try {
		var cb = li.querySelector(':scope > input[type=checkbox]');
		if (!cb || !cb.checked) return;
		if (li.dataset.itdStrike) return;
		li.dataset.itdStrike = '1';
		var parts = liTaskParts(li);
		if (!parts.length) return;
		var span = document.createElement('span');
		span.className = 'itd-done';
		var host = parts[0].parentNode || li;
		host.insertBefore(span, parts[0]);
		for (var k2 = 0; k2 < parts.length; k2++) span.appendChild(parts[k2]);
	} catch (e) { /* 忽略 */ }
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
			// 原地更新完成样式：跳过中间可能存在的空元素，找到 itd-content 包裹层
			var span = box.nextElementSibling;
			while (span && !(span.classList && span.classList.contains('itd-content'))) span = span.nextElementSibling;
			if (span) span.classList.toggle('itd-done', box.checked);
		} else {
			var src = await plugin.app.vault.read(file);
			var newSrc = src.slice(0, hit.index) + newTok + src.slice(hit.index + tokLen);
			await plugin.app.vault.modify(file, newSrc);
			if (view && view.previewMode) view.previewMode.rerender(true);
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

		// 横排链的块级装饰：必须经 StateField 直接提供（CM6 禁止 ViewPlugin 提供块级装饰）
		var chainField = cmState.StateField.define({
			create: function (state) { return buildChainDecos(state, self); },
			update: function (value, tr) {
				if (tr.docChanged || tr.selection) return buildChainDecos(tr.state, self);
				return value;
			},
			provide: function (f) { return cmView.EditorView.decorations.from(f); }
		});

		this.registerMarkdownPostProcessor(function (el, ctx) {
			try {
				if (!(el instanceof HTMLElement)) return;
				el.dataset.itdProcessed = '1';
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
				// 新版 Obsidian 阅读视图每块外有 div.el-p / div.el-ul 包裹，
				// post-processor 收到的 el 可能是包裹层而非 p/ul 本体，两种都要处理
				var tops = [];
				if (el.matches && el.matches('ul, p')) tops.push({ target: el, probe: el });
				if (el.querySelectorAll) {
					var subs = el.querySelectorAll('ul, p');
					for (var q = 0; q < subs.length; q++) tops.push({ target: subs[q], probe: el });
				}
				for (var t = 0; t < tops.length; t++) {
					var target = tops[t].target;
					if (!ctx.getSectionInfo) continue;
					// 优先取元素自身的 section 行范围（打 start/end 流动标记需要精确行界），失败回退 probe
					var ownInfo = ctx.getSectionInfo(target);
					var info = ownInfo || ctx.getSectionInfo(tops[t].probe);
					if (!info) continue;
					// 注意：处理标记只在真正标记成功后设置（见 _applyChainStylingNow），
					// 否则链数据未就绪时提前置位会让该元素永久跳过
					self.applyChainStyling(target, ctx, info, !!ownInfo);
				}
				// 横排间距归一（空段减一）在渲染稳定后执行
				self._scheduleChainGapPass();
			} catch (err) {
				console.error('[inline-todo] 后处理失败:', err);
			}
		});
		this.registerEditorExtension([
			chainField,
			// 回车连续输入待办：行尾是有内容的待办（[]文字/）时，按回车在本行末尾紧接着
			// 生成下一个空语法 []/，光标停在其中间，方便连写；空语法 []/ 上回车不干预（Obsidian 原生换行）
			cmState.Prec.highest(cmView.EditorView.domEventHandlers({
				keydown: function (ev, v) {
					if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return false;
					var st = v.state;
					var head = st.selection.main.head;
					var line = st.doc.lineAt(head);
					if (head !== line.to) return false; // 只在行尾
					var mm = line.text.match(/\[([xX]?)\]((?:[^/\\]|\\.)*)\/\s*$/);
					if (!mm) return false; // 行尾不是待办语法
					if (inCode(st, line.to - 1)) return false; // 代码内不处理
					if (!mm[2].trim()) return false; // 空语法 []/：交给 Obsidian 普通换行
					v.dispatch({
						changes: { from: head, to: head, insert: '[]/' },
						selection: { anchor: head + 2 }
					});
					ev.preventDefault();
					return true;
				}
			})),
			cmView.ViewPlugin.fromClass(class {
				constructor(view) {
					this.decorations = buildInlineDecos(view, self);
				}
				update(u) { this.decorations = buildInlineDecos(u.view, self); }
			}, {
				decorations: function (v) { return v.decorations; }
			})
		]);

		// 插件加载/重载后重扫已存在的预览视图：
		// 后处理器只在新渲染时被调用，不主动重扫的话重载后旧 DOM 不会被重新标记
		setTimeout(function () {
			try { self._remarkAll(); } catch (e) { /* 忽略 */ }
		}, 800);
	}


	// 标准任务横排：给链成员的 ul / p 加显示类（数据不动，纯显示层）
	// 源文件链缓存（阅读模式用，按路径+长度失效）
	// 取指定文件源码文本：活动视图 → 任意 markdown leaf 的 editor → 文本缓存 → 异步读盘（下次生效）
	_getSourceText(path) {
		try {
			if (!path) return null;
			var v = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			if (v && v.file && v.file.path === path && v.editor) return v.editor.getValue();
			var leaves = this.app.workspace.getLeavesOfType('markdown');
			for (var i = 0; i < leaves.length; i++) {
				var lv = leaves[i].view;
				if (lv && lv.file && lv.file.path === path && lv.editor) {
					try { return lv.editor.getValue(); } catch (e2) { /* 视图未就绪，跳过 */ }
				}
			}
			if (this._textCache && this._textCache[path] !== undefined) return this._textCache[path];
			var af = this.app.vault.getAbstractFileByPath(path);
			if (af) {
				var self = this;
				this.app.vault.cachedRead(af).then(function (t) {
					if (!self._textCache) self._textCache = {};
					if (self._textCache[path] === t) return;
					self._textCache[path] = t;
					self._chainCache = null;
					self._normCache = null;
					self._remarkAll();
				}).catch(function () { /* 忽略 */ });
			}
			return null;
		} catch (e) { return null; }
	}

	getSourceChains(sourcePath) {
		try {
			var text = this._getSourceText(sourcePath);
			if (text === null) {
				return null;
			}
			if (this._chainCache && this._chainCache.path === sourcePath && this._chainCache.len === text.length) return this._chainCache.chain;
			var chain = computeChainsFromLines(text.split('\n'));
			this._chainCache = { path: sourcePath, len: text.length, chain: chain };
			return chain;
		} catch (e) {
			return null;
		}
	}

	// 文本缓存刷新后重扫所有预览视图：让 Obsidian 重新渲染，后处理器会重建元素并重新标记
	_remarkAll() {
		// 防抖：短时间多次触发只重渲染一次，避免文字闪动
		if (this._remarkTimer) return;
		var self = this;
		this._remarkTimer = setTimeout(function () {
			self._remarkTimer = null;
			try {
				var leaves = self.app.workspace.getLeavesOfType('markdown');
				for (var i = 0; i < leaves.length; i++) {
					var v = leaves[i].view;
					if (!v || !v.getMode || v.getMode() !== 'preview') continue;
					if (!v.previewMode || !v.previewMode.rerender) continue;
					try { v.previewMode.rerender(true); } catch (e) { /* 单个视图失败不影响其他 */ }
				}
			} catch (e) {
				console.error('[inline-todo] 重扫失败:', e);
			}
		}, 250);
	}

	/* ---------- 阅读模式横排间距（v0.4.2 空段减一）----------
	   纯 CSS 流式方案：链内块全部行内化自然流动；链与链之间的换行/空行由后链
	   .itd-run-start::before 的 --itd-break 换行符承担（N 个空行 = N 个 \A = 显示 N-1 个）；
	   链与普通块之间的间距落在相邻块朝向链的一侧 margin 上（内联盒垂直 margin 无效）。
	   边界行是待办才动间距；边界是文字 → 保持自然。渲染稳定后调度执行，幂等。 */
	_scheduleChainGapPass() {
		if (this._gapPassTimer) return; // 已有待执行（合并一次渲染中的多次调度）
		var self = this;
		this._gapPassTimer = setTimeout(function () {
			self._gapPassTimer = null;
			try { self.normalizeChainGaps(); } catch (e) {
				console.error('[inline-todo] 间距计算失败:', e);
			}
		}, 60);
		// 后续变化由 _ensureGapObserver 的 MutationObserver 自愈，不再叠加定时补刀（避免布局多次跳动）
	}

	normalizeChainGaps() {
		var roots = document.querySelectorAll('.markdown-preview-sizer, .markdown-preview-view');
		for (var ri = 0; ri < roots.length; ri++) {
			var root = roots[ri];
			if (!(root instanceof HTMLElement)) continue;
			// 自愈观察器：Obsidian 重渲染会替换 section 元素丢掉我们设的 margin，
			// 监听 sizer 子列表变化，变动后自动重应用（观察 style 属性不触发，无反馈回路）
			this._ensureGapObserver(root);
			// 清场：重置本 root 直属子元素的内联上下 margin（含包裹层内的 p/ul），避免陈旧样式
			var kids = root.children;
			for (var ki = 0; ki < kids.length; ki++) {
				var kid = kids[ki];
				kid.style.marginTop = '';
				kid.style.marginBottom = '';
				var innerClear = kid.querySelectorAll(':scope > p, :scope > ul');
				for (var ic = 0; ic < innerClear.length; ic++) {
					innerClear[ic].style.marginTop = '';
					innerClear[ic].style.marginBottom = '';
				}
			}
			if (!root.querySelector(':scope > .itd-run-wrap')) continue;
			var unit = this._measureBlankUnit(root);
			for (var wi = 0; wi < kids.length; wi++) {
				var cw = kids[wi];
				if (!(cw.classList && cw.classList.contains('itd-run-wrap'))) continue;
				this._applyWrapGap(cw, 'up', unit);
				this._applyWrapGap(cw, 'down', unit);
			}
		}
	}

	// sizer 子列表观察器（每个 root 一个，去重）：重渲染后自动重应用横排间距
	_ensureGapObserver(root) {
		if (!this._gapObsMap) this._gapObsMap = new Map();
		if (this._gapObsMap.has(root)) return;
		var self = this;
		var timer = null;
		var obs = new MutationObserver(function () {
			if (timer) return;
			timer = setTimeout(function () {
				timer = null;
				try { self.normalizeChainGaps(); } catch (e) { /* 忽略 */ }
			}, 100);
		});
		obs.observe(root, { childList: true });
		this._gapObsMap.set(root, obs);
	}

	onunload() {
		// 断开间距观察器
		if (this._gapObsMap) {
			this._gapObsMap.forEach(function (obs) { try { obs.disconnect(); } catch (e) { /* 忽略 */ } });
			this._gapObsMap.clear();
		}
	}

	// 单侧间距（链 wrap 与相邻普通块之间）：边界是待办 → 间距 = (空段长度-1) 个段距；
	// 邻块也是链 wrap → 间距已由 ::before 换行符承担，跳过；边界是文字 → 不动
	_applyWrapGap(c, side, unit) {
		var gapStr = side === 'up' ? c.dataset.itdUpGap : c.dataset.itdDownGap;
		var isTask = side === 'up' ? c.dataset.itdFirstTask === '1' : c.dataset.itdLastTask === '1';
		if (!gapStr || !isTask) return;
		var neighbor = side === 'up' ? c.previousElementSibling : c.nextElementSibling;
		if (!neighbor) return;
		if (neighbor.classList && neighbor.classList.contains('itd-run-wrap')) return;
		var parts = gapStr.split(':');
		var n = parseInt(parts[1], 10) - parseInt(parts[0], 10) + 1;
		var k = Math.max(0, n - 1);
		// 注意：setProperty 必须用连字符名（驼峰会被 CSSOM 静默拒绝）
		var prop = side === 'up' ? 'margin-bottom' : 'margin-top';
		neighbor.style.setProperty(prop, (k * unit) + 'px', 'important');
		var sel = side === 'up' ? ':scope > p:last-child, :scope > ul:last-child' : ':scope > p:first-child, :scope > ul:first-child';
		var inner = neighbor.querySelectorAll(sel);
		for (var q = 0; q < inner.length; q++) inner[q].style.setProperty(prop, (k * unit) + 'px', 'important');
	}

	// 一个"空行"的视觉高度 ≈ 正常段落的段距（阅读模式下 N 个空行也只会话成一个段距）
	_measureBlankUnit(root) {
		try {
			var ps = root.querySelectorAll('p');
			for (var i = 0; i < ps.length && i < 5; i++) {
				var cs = getComputedStyle(ps[i]);
				var mb = parseFloat(cs.marginBottom) || 0;
				if (mb > 0) return mb;
				var mt = parseFloat(cs.marginTop) || 0;
				if (mt > 0) return mt;
			}
			var lh = parseFloat(getComputedStyle(root).lineHeight);
			if (lh > 0) return lh;
		} catch (e) { /* 忽略 */ }
		return 16;
	}

	applyChainStyling(secEl, ctx, info, isOwnInfo) {
		var self = this;
		// Obsidian 会在元素挂载到 sizer 之前调用后处理器（阅读模式渐进渲染）：
		// 断开状态不放弃，挂起重试，连上后再标记
		if (!secEl.isConnected) {
			var tries = 0;
			var retry = function () {
				tries++;
				if (secEl.isConnected) {
					self._applyChainStylingNow(secEl, ctx, info, isOwnInfo);
				} else if (tries < 8) {
					setTimeout(retry, 80);
				}
			};
			setTimeout(retry, 80);
			return;
		}
		this._applyChainStylingNow(secEl, ctx, info, isOwnInfo);
	}

	// 按 data-line（相对 section 首行的源行偏移）找 li
	_findLiBySrcLine(lis, offset) {
		for (var i = 0; i < lis.length; i++) {
			if (parseInt(lis[i].dataset.line, 10) === offset) return lis[i];
		}
		return null;
	}

	_applyChainStylingNow(secEl, ctx, info, isOwnInfo) {
		try {
			var sourcePath = ctx && ctx.sourcePath;
			if (!sourcePath) return;
			var chain = this.getSourceChains(sourcePath);
			if (!chain) return;
			// 该元素覆盖的源码行里只要有横排成员行即参与（懒续行会让 ul 跨更多行）
			var anyMember = false;
			for (var ln = info.lineStart + 1; ln <= info.lineEnd + 1; ln++) {
				if (chain.member[ln]) { anyMember = true; break; }
			}
			if (!anyMember) return;
			// 找到与本元素相交的链（懒续行会让一个 ul 跨更多行，可能跨多条链）：
			// 上边界用首条的 upGap/firstTask，下边界用末条的 downGap/lastTask
			var firstIdx = -1, lastIdx = -1;
			for (var ci = 0; ci < chain.chains.length; ci++) {
				var cLs = chain.chains[ci];
				if (info.lineEnd + 1 >= cLs[0] && info.lineStart + 1 <= cLs[cLs.length - 1]) {
					if (firstIdx < 0) firstIdx = ci;
					lastIdx = ci;
				}
			}
			secEl.classList.add('itd-run');
			// 包裹层判定（结构无关）：父级是预览 sizer 的直接子级 → 整块为包裹层；否则保持元素自身 inline
			var wrap = secEl.parentElement;
			if (wrap && wrap.parentElement && wrap.parentElement.classList && wrap.parentElement.classList.contains('markdown-preview-sizer')) {
				wrap.classList.add('itd-run-wrap');
				// 链 ID 用链的首行号（不能用 section.lineStart）：同一链跨 p/ul 多个元素时才能归组
				wrap.dataset.itdChainId = String(firstIdx >= 0 ? chain.chains[firstIdx][0] : info.lineStart + 1);
				// 空段元数据（供 normalizeChainGaps 计算 N-1 间距）
				var mtFirst = firstIdx >= 0 ? chain.meta[firstIdx] : null;
				var mtLast = lastIdx >= 0 ? chain.meta[lastIdx] : null;
				if (mtFirst) {
					wrap.dataset.itdFirstTask = mtFirst.firstTask ? '1' : '0';
					if (mtFirst.upGap) wrap.dataset.itdUpGap = mtFirst.upGap[0] + ':' + mtFirst.upGap[1];
				}
				if (mtLast) {
					wrap.dataset.itdLastTask = mtLast.lastTask ? '1' : '0';
					if (mtLast.downGap) wrap.dataset.itdDownGap = mtLast.downGap[0] + ':' + mtLast.downGap[1];
				}
				// 流动标记（纯 CSS，不移动任何节点）：
				// 本元素覆盖链首行 → itd-run-start + --itd-break（N 个源空行 = N 个 \A 换行符，显示 N-1 个空行）；
				// 本元素覆盖链末行 → itd-run-end（下一条链的 start 靠 ".itd-run-end + .itd-run-start::before" 接上换行）
				var cFirst = firstIdx >= 0 ? chain.chains[firstIdx][0] : -1;
				var cLast = lastIdx >= 0 ? chain.chains[lastIdx][chain.chains[lastIdx].length - 1] : -1;
				var myLo = info.lineStart + 1, myHi = info.lineEnd + 1;
				// 无自身 section 信息时（回退用整个 section 的行范围）只在整链都落在范围内才打标，避免误标
				var canMark = isOwnInfo || (cFirst >= myLo && cFirst <= myHi && cLast >= myLo && cLast <= myHi);
				if (canMark && cFirst >= myLo && cFirst <= myHi) {
					wrap.classList.add('itd-run-start');
					var nUp = (mtFirst && mtFirst.upGap) ? (mtFirst.upGap[1] - mtFirst.upGap[0] + 1) : 1;
					wrap.style.setProperty('--itd-break', '"' + '\\A'.repeat(nUp) + '"');
				}
				if (canMark && cLast >= myLo && cLast <= myHi) {
					wrap.classList.add('itd-run-end');
				}
			} else {
				secEl.classList.add('itd-chain-loose');
			}
			if (secEl.tagName === 'UL') {
				var lis = secEl.querySelectorAll(':scope > li');
				for (var i = 0; i < lis.length; i++) {
					lis[i].classList.add('itd-run-item'); // 整块横排：所有列表项参与
					if (stripTaskSlash(lis[i])) {
						applyCheckedStrike(lis[i]); // 以 / 结尾的任务：剥 / + 完成样式
					}
				}
				// 链边界落在 li 级：阅读渲染可能把空行分隔的多条链并进同一个 ul
				// （实测 li 的 data-line = 相对 section 首行的源行偏移，空行也占号）
				var secBase = info.lineStart + 1, secEnd = info.lineEnd + 1;
				for (var bi = 0; bi < chain.chains.length; bi++) {
					var bLs = chain.chains[bi];
					var bMeta = chain.meta[bi];
					var bFirst = bLs[0], bLast = bLs[bLs.length - 1];
					if (bFirst >= secBase && bFirst <= secEnd) {
						var liS = this._findLiBySrcLine(lis, bFirst - secBase);
						if (liS) {
							liS.classList.add('itd-run-start');
							var nUp2 = (bMeta && bMeta.upGap) ? (bMeta.upGap[1] - bMeta.upGap[0] + 1) : 1;
							liS.style.setProperty('--itd-break', '"' + '\\A'.repeat(nUp2) + '"');
						}
					}
					if (bLast >= secBase && bLast <= secEnd) {
						var liE = this._findLiBySrcLine(lis, bLast - secBase);
						if (liE) liE.classList.add('itd-run-end');
					}
				}
			}
			// 全程幂等：同一元素被后处理器多次处理也不会产生重复效果
		} catch (err) {
			console.error('[inline-todo] 横排样式失败:', err);
			console.error('[inline-todo] 横排样式失败:', err);
		}
	}
};

module.exports = InlineTodoPlugin;
