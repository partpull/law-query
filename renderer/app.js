// 法规查询 v2.0 —— 界面逻辑：查询范围勾选、遍历匹配、标红、按法规分组、原文窗口
(() => {
  'use strict';

  const PREVIEW_LIMIT = 150; // 结果列表里每条法条展示的字数

  const el = {
    field: document.getElementById('field'),
    query: document.getElementById('query'),
    clear: document.getElementById('clear'),
    run: document.getElementById('run'),
    menu: document.getElementById('scope-menu'),
    rangeTitle: document.getElementById('range-title'),
    rangeAll: document.getElementById('range-all'),
    scopeNote: document.getElementById('scope-note'),
    statLaw: document.getElementById('stat-law'),
    statArt: document.getElementById('stat-art'),
    statDir: document.getElementById('stat-dir'),
    loadNote: document.getElementById('load-note'),
    pill: document.getElementById('pill'),
    sub: document.getElementById('sub'),
    list: document.getElementById('list'),
    viewResults: document.getElementById('view-results'),
    viewLoading: document.getElementById('view-loading'),
    viewEmpty: document.getElementById('view-empty'),
    loadingText: document.getElementById('loading-text'),
    emptyTitle: document.getElementById('empty-title'),
    emptySub: document.getElementById('empty-sub'),
    originLoc: document.getElementById('origin-loc'),
    originCount: document.getElementById('origin-count'),
    originFoot: document.getElementById('origin-foot'),
    originBody: document.getElementById('origin-body'),
  };

  const state = {
    laws: [], // 全部法规（含 scope 字段）
    scopes: [], // 查询范围：法规库下的二级文件夹 + 未分类
    selected: new Set(), // 已勾选的范围 id
    hits: [], // 扁平化的命中列表，供点击时取数据
    keyword: '',
  };

  const CHECK_SVG =
    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2l2.4 2.4 4.6-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ---------- 查询范围 ---------- */

  function scopedLaws() {
    return state.laws.filter((law) => state.selected.has(law.scope));
  }

  function statsOf(laws) {
    return { lawCount: laws.length, articleCount: laws.reduce((sum, law) => sum + law.articleCount, 0) };
  }

  function summaryOf(laws) {
    const stats = statsOf(laws);
    return stats.lawCount + ' 部法规 / ' + stats.articleCount + ' 条法条';
  }

  function renderScopeMenu() {
    el.menu.innerHTML = '';

    if (!state.scopes.length) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = '「法规库」下暂无分类，请把 Word 法规放进文件夹后重新启动';
      el.menu.appendChild(hint);
      el.rangeTitle.textContent = '查询范围';
      el.rangeAll.hidden = true;
      return;
    }

    el.rangeAll.hidden = false;
    for (const scope of state.scopes) {
      const row = document.createElement('div');
      row.className = 'row' + (state.selected.has(scope.id) ? ' is-on' : '');
      row.dataset.scope = scope.id;
      row.title = scope.fileCount + ' 个文件 / ' + scope.articleCount + ' 条法条';
      row.innerHTML =
        '<span class="ck" aria-hidden="true">' + CHECK_SVG + '</span>' +
        '<span class="nm"></span>' +
        '<span class="n"></span>';
      row.querySelector('.nm').textContent = scope.label;
      row.querySelector('.n').textContent = String(scope.fileCount);
      el.menu.appendChild(row);
    }
    updateRangeHeader();
  }

  function updateRangeHeader() {
    const total = state.scopes.length;
    const picked = state.selected.size;
    el.rangeTitle.textContent = '查询范围（已选 ' + picked + '/' + total + '）';
    el.rangeAll.textContent = total && picked === total ? '全不选' : '全选';
  }

  function toggleScope(id) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    renderScopeMenu();
  }

  function toggleAll() {
    if (state.selected.size === state.scopes.length) state.selected.clear();
    else state.scopes.forEach((scope) => state.selected.add(scope.id));
    renderScopeMenu();
  }

  /* ---------- 文本归一化：去空白 + 全角转半角 + 转小写，并保留原文字符位置 ---------- */

  function toHalf(ch) {
    const code = ch.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
    return ch;
  }

  function normalize(text) {
    let norm = '';
    const map = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) continue; // 忽略空格、换行等，避免关键字被换行拆开而漏检
      norm += toHalf(ch).toLowerCase();
      map.push(i);
    }
    return { norm, map };
  }

  // 在原文中找出关键字出现的所有位置，返回 [start, end) 区间（基于原文下标）
  function findRanges(text, keyword) {
    const { norm, map } = normalize(text);
    const target = normalize(keyword).norm;
    if (!target) return [];

    const ranges = [];
    let from = 0;
    for (;;) {
      const idx = norm.indexOf(target, from);
      if (idx < 0) break;
      ranges.push([map[idx], map[idx + target.length - 1] + 1]);
      from = idx + target.length;
    }
    return ranges;
  }

  /* ---------- HTML 拼装 ---------- */

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function markHtml(text, ranges) {
    let out = '';
    let pos = 0;
    for (const [start, end] of ranges) {
      if (start < pos) continue;
      out += escapeHtml(text.slice(pos, start)) + '<mark>' + escapeHtml(text.slice(start, end)) + '</mark>';
      pos = end;
    }
    return out + escapeHtml(text.slice(pos));
  }

  // 结果列表摘要：太长时围绕首个命中截取一段
  function previewHtml(text, ranges) {
    if (text.length <= PREVIEW_LIMIT) return markHtml(text, ranges);

    let start = 0;
    if (ranges.length && ranges[0][0] > PREVIEW_LIMIT - 40) start = Math.max(0, ranges[0][0] - 40);
    const end = Math.min(text.length, start + PREVIEW_LIMIT);

    const clipped = ranges
      .map(([s, e]) => [Math.max(s, start) - start, Math.min(e, end) - start])
      .filter(([s, e]) => s < e);

    const head = start > 0 ? '……' : '';
    const tail = end < text.length ? '……' : '';
    return head + markHtml(text.slice(start, end), clipped) + tail;
  }

  /* ---------- 遍历匹配 ---------- */

  function searchAll(keyword, laws) {
    const groups = [];
    const hits = [];
    let total = 0;

    for (const law of laws) {
      const lawHits = [];
      for (let i = 0; i < law.articles.length; i += 1) {
        const article = law.articles[i];
        const ranges = findRanges(article.body, keyword);
        if (!ranges.length) continue; // 每条都检查，命中即收录
        const nextNo = law.articles[i + 1] ? law.articles[i + 1].no : ''; // 下一条的条号，用于说明本条范围
        const hit = { law: law.name, no: article.no, body: article.body, ranges, nextNo };
        lawHits.push(hit);
        hits.push(hit);
      }
      if (lawHits.length) {
        groups.push({ name: law.name, hits: lawHits });
        total += lawHits.length;
      }
    }
    return { groups, hits, total, lawCount: groups.length };
  }

  /* ---------- 视图切换 ---------- */

  function showView(name) {
    el.viewResults.classList.toggle('is-off', name !== 'results');
    el.viewLoading.classList.toggle('is-off', name !== 'loading');
    el.viewEmpty.classList.toggle('is-off', name !== 'empty');
  }

  function showDefaultEmpty() {
    el.pill.textContent = '0 条';
    el.sub.textContent = state.scopes.length
      ? '尚未遍历 · 已选范围 ' + state.selected.size + '/' + state.scopes.length + ' · ' + summaryOf(scopedLaws())
      : '法规库中还没有法规';
    el.emptyTitle.textContent = '请输入法规关键字，然后点击【遍历】';
    el.emptySub.textContent = state.scopes.length
      ? '将在 ' + summaryOf(scopedLaws()) + ' 中查找匹配内容'
      : '把 .docx 法规文件按分类放入「程序根目录\\' + state.folderLabel + '」后重新启动程序';
    showView('empty');
    resetOrigin();
  }

  function showScopeEmpty() {
    el.pill.textContent = '0 条';
    el.sub.textContent = '尚未遍历 · 未勾选查询范围';
    el.emptyTitle.textContent = '请至少勾选一个查询范围';
    el.emptySub.textContent = '在左侧「查询范围」里勾选后再点【遍历】';
    showView('empty');
    resetOrigin();
  }

  function resetOrigin() {
    el.originLoc.textContent = '未选择法条';
    el.originCount.textContent = '';
    el.originFoot.hidden = true;
    el.originBody.classList.add('is-empty');
    el.originBody.textContent = '点击上方任意一条匹配结果，此处显示该条法条的完整原文。';
  }

  /* ---------- 结果渲染 ---------- */

  function renderResults(result, keyword, laws) {
    el.list.innerHTML = '';

    const scopeText = '范围 ' + state.selected.size + '/' + state.scopes.length + ' · 遍历 ' + summaryOf(laws);

    if (!result.total) {
      el.pill.textContent = '0 条';
      el.sub.textContent = '关键字「' + keyword + '」· ' + scopeText + ' · 无匹配';
      el.emptyTitle.textContent = '未找到包含「' + keyword + '」的法条';
      el.emptySub.textContent = '已遍历 ' + summaryOf(laws) + '，可以换个关键字或调整查询范围';
      showView('empty');
      resetOrigin();
      return;
    }

    const frag = document.createDocumentFragment();
    let index = 0;

    for (const group of result.groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'group';

      const headEl = document.createElement('div');
      headEl.className = 'group-h';
      const lawEl = document.createElement('span');
      lawEl.className = 'law';
      lawEl.textContent = group.name;
      const cntEl = document.createElement('span');
      cntEl.className = 'cnt';
      cntEl.textContent = '命中 ' + group.hits.length + ' 条';
      headEl.appendChild(lawEl);
      headEl.appendChild(cntEl);
      groupEl.appendChild(headEl);

      for (const hit of group.hits) {
        const itemEl = document.createElement('div');
        itemEl.className = 'item';
        itemEl.dataset.idx = String(index);
        index += 1;

        const titleEl = document.createElement('div');
        titleEl.className = 'item-h';
        const noEl = document.createElement('span');
        noEl.className = 'loc';
        noEl.textContent = hit.no;

        const bodyEl = document.createElement('div');
        bodyEl.className = 'item-b';
        bodyEl.innerHTML = previewHtml(hit.body, hit.ranges);

        titleEl.appendChild(noEl);
        itemEl.appendChild(titleEl);
        itemEl.appendChild(bodyEl);
        groupEl.appendChild(itemEl);
      }
      frag.appendChild(groupEl);
    }

    el.list.appendChild(frag);
    state.hits = result.hits;

    el.pill.textContent = result.total + ' 条';
    el.sub.textContent =
      '关键字「' + keyword + '」· ' + scopeText + ' · 命中 ' + result.lawCount + ' 部 / 共 ' + result.total + ' 条';
    showView('results');

    selectHit(0);
    el.viewResults.scrollTop = 0;
  }

  function selectHit(index) {
    const hit = state.hits[index];
    if (!hit) return;

    const items = el.list.querySelectorAll('.item');
    items.forEach((node) => node.classList.toggle('is-sel', node.dataset.idx === String(index)));

    // 原文窗口：条号 + 完整条文 + 本条范围说明，方便一眼确认没有截断
    const chars = hit.body.replace(/\s/g, '').length;
    el.originLoc.innerHTML = escapeHtml(hit.law) + ' - <span class="loc">' + escapeHtml(hit.no) + '</span>';
    el.originCount.textContent = '完整条文 · 共 ' + chars + ' 字';
    el.originFoot.hidden = false;
    el.originFoot.textContent = hit.nextNo
      ? '本条范围：从段首「' + hit.no + '」到下一个段首「' + hit.nextNo + '」之前的全部文本'
      : '本条范围：从段首「' + hit.no + '」到文末的全部文本';

    el.originBody.classList.remove('is-empty');
    el.originBody.innerHTML =
      '<span class="origin-no">' + escapeHtml(hit.no) + '</span> ' + markHtml(hit.body, hit.ranges);
    el.originBody.scrollTop = 0;
  }

  /* ---------- 交互 ---------- */

  function runSearch() {
    const keyword = el.query.value.trim();

    if (!state.scopes.length) {
      showDefaultEmpty();
      return;
    }
    if (!state.selected.size) {
      showScopeEmpty();
      return;
    }
    if (!keyword) {
      showDefaultEmpty();
      el.query.focus();
      return;
    }

    const laws = scopedLaws();
    state.keyword = keyword;
    el.pill.textContent = '…';
    el.sub.textContent = '关键字「' + keyword + '」· 遍历中…';
    el.loadingText.textContent = '正在遍历 ' + summaryOf(laws) + '…';
    showView('loading');

    // 让「遍历中」的界面先画出来，再做同步匹配
    setTimeout(() => {
      const result = searchAll(keyword, laws);
      renderResults(result, keyword, laws);
    }, 30);
  }

  function bindEvents() {
    el.run.addEventListener('click', runSearch);

    el.query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runSearch();
    });

    el.query.addEventListener('input', () => {
      if (!el.query.value.trim()) showDefaultEmpty();
    });

    el.query.addEventListener('focus', () => el.field.classList.add('is-focus'));
    el.query.addEventListener('blur', () => el.field.classList.remove('is-focus'));

    el.clear.addEventListener('click', () => {
      el.query.value = '';
      showDefaultEmpty();
      el.query.focus();
    });

    // 查询范围：点击行切换勾选，表头一键全选/全不选
    el.menu.addEventListener('click', (event) => {
      const row = event.target.closest('.row');
      if (!row) return;
      toggleScope(row.dataset.scope);
      if (state.selected.size) showDefaultEmpty();
      else showScopeEmpty();
    });

    el.rangeAll.addEventListener('click', () => {
      toggleAll();
      if (state.selected.size) showDefaultEmpty();
      else showScopeEmpty();
    });

    // 结果点击：切换选中 + 刷新法规原文窗口
    el.list.addEventListener('click', (event) => {
      const item = event.target.closest('.item');
      if (!item) return;
      selectHit(Number(item.dataset.idx));
    });
  }

  /* ---------- 启动：读取法规库 ---------- */

  async function init() {
    bindEvents();

    if (!window.lawAPI) {
      el.loadNote.textContent = '初始化失败：未加载到主进程接口';
      return;
    }

    const result = await window.lawAPI.loadLibrary();
    state.laws = result.laws || [];
    state.scopes = result.scopes || [];
    state.scopes.forEach((scope) => state.selected.add(scope.id)); // 默认全选

    el.statLaw.textContent = state.laws.length + ' 部';
    el.statArt.textContent = (result.totalArticles || 0) + ' 条';
    el.statDir.textContent = '程序根目录\\' + (result.folderLabel || '法规库');
    el.statDir.title = result.folder || '';

    renderScopeMenu();

    if (result.error) {
      el.loadNote.textContent = result.error;
    } else if (result.failed && result.failed.length) {
      el.loadNote.textContent = result.failed.length + ' 个文件未解析（仅支持 .docx）：' + result.failed.join('、');
      el.loadNote.title = result.failed.join('\n');
    } else if (!state.laws.length) {
      el.loadNote.textContent = '法规库为空：请放入 .docx 法规文件后重新启动';
    } else {
      el.loadNote.textContent =
        '已读取 ' + (result.fileCount || 0) + ' 个 Word 文件，分 ' + state.scopes.length + ' 个查询范围';
    }

    showDefaultEmpty();
    el.query.focus();
  }

  window.addEventListener('DOMContentLoaded', init);
})();