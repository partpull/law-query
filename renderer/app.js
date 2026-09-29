// 法规查询 v4.1 —— 界面逻辑：查询范围勾选、遍历匹配、标红、按法规分组、原文窗口
(() => {
  'use strict';

  const PREVIEW_LIMIT = 150; // 结果列表里每条法条展示的字数
  const FOLD_AFTER = 5; // 每组默认最多展开条数，其余折叠
  const DEBOUNCE_MS = 300; // 输入防抖间隔

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
    selectedIdx: -1, // 当前选中的 hit 索引
    lastSelEl: null, // 上一个选中的 DOM 节点，避免 querySelectorAll 全量遍历
    expandedGroups: new Set(), // 已展开的法规名（默认折叠，点击后展开）
    searchTimer: null, // 防抖定时器，也用于防止连点【遍历】
    lawNameNormCache: new Map(), // 法规名归一化缓存，避免逐条重复计算
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

  // 条文的归一化结果按条文缓存：条文加载后内容不变，算一次即可反复使用
  function articleNorm(article) {
    if (!article.normCache) article.normCache = normalize(article.body);
    return article.normCache;
  }

  // 在已归一化的条文里找目标词，返回 [start, end) 区间（基于原文下标）
  function rangesIn(cached, target) {
    if (!target) return [];
    const { norm, map } = cached;
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

  /* ---------- 检索条件解析：空格＝同时满足、-词＝排除、第X条＝条号直达 ---------- */

  const CN_NUM = '零〇一二三四五六七八九十百千万两';
  const ARTICLE_NO_RE = new RegExp('^第\\s*[0-9０-９' + CN_NUM + ']+\\s*条$');
  const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 };
  const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

  // 「第二十一条」→ 21
  function articleNoValue(no) {
    const raw = String(no)
      .replace(/^第/, '')
      .replace(/条$/, '')
      .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
    if (/^\d+$/.test(raw)) return Number(raw);

    let total = 0;
    let section = 0;
    let digit = 0;
    for (const ch of raw) {
      if (ch in CN_DIGITS) digit = CN_DIGITS[ch];
      else if (ch in CN_UNITS) {
        const unit = CN_UNITS[ch];
        if (unit === 10000) {
          section = (section + digit) * unit;
          total += section;
          section = 0;
        } else section += (digit || 1) * unit;
        digit = 0;
      }
    }
    return total + section + digit;
  }

  function parseQuery(raw) {
    const tokens = String(raw || '')
      .split(/[\s\u3000]+/)
      .filter(Boolean);

    const required = [];
    const excluded = [];
    let articleNo = '';

    for (const token of tokens) {
      if (token.length > 1 && token.startsWith('-')) {
        excluded.push(token.slice(1));
        continue;
      }
      if (ARTICLE_NO_RE.test(token)) {
        articleNo = token.replace(/\s+/g, '');
        continue;
      }
      required.push(token);
    }

    return {
      raw: String(raw || '').trim(),
      required,
      excluded,
      articleNo,
      // 预先把检索词归一化，避免在逐条匹配时反复计算
      requiredNorm: required.map((word) => ({ word, norm: normalize(word).norm })).filter((item) => item.norm),
      excludedNorm: excluded.map((word) => normalize(word).norm).filter(Boolean),
      articleNoValue: articleNo ? articleNoValue(articleNo) : 0,
      articleNoNorm: articleNo ? normalize(articleNo).norm : '',
    };
  }

  // 合并重叠的标红区间，保证区间有序且不重叠
  function mergeRanges(ranges) {
    if (ranges.length < 2) return ranges;
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [sorted[0].slice()];
    for (let i = 1; i < sorted.length; i += 1) {
      const last = merged[merged.length - 1];
      const [start, end] = sorted[i];
      if (start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    return merged;
  }

  // 法规名归一化缓存（按法规提升出循环，避免逐条重复计算）
  function getLawNameNorm(name) {
    let cached = state.lawNameNormCache.get(name);
    if (!cached) {
      cached = normalize(name).norm;
      state.lawNameNormCache.set(name, cached);
    }
    return cached;
  }

  // 一条法条是否命中；命中则返回需要标红的位置
  function matchArticle(article, lawName, query) {
    if (query.articleNoValue && articleNoValue(article.no) !== query.articleNoValue) return null;

    const cached = articleNorm(article); // 复用条文已缓存的归一化结果

    for (const target of query.excludedNorm) {
      if (cached.norm.indexOf(target) >= 0) return null; // 含排除词 → 丢弃（直接用 indexOf 判断存在性，避免建数组）
    }

    const ranges = [];
    const lawNorm = query.articleNo ? getLawNameNorm(lawName) : ''; // 条号直达时才需要法规名归一化
    for (const item of query.requiredNorm) {
      const inBody = rangesIn(cached, item.norm);
      if (inBody.length) {
        ranges.push(...inBody);
        continue;
      }
      // 条号直达时，其余词允许匹配法规名（不必出现在条文里）
      if (query.articleNo && lawNorm.includes(item.norm)) continue;
      return null;
    }
    if (query.articleNoNorm) ranges.push(...rangesIn(cached, query.articleNoNorm));

    return { ranges: mergeRanges(ranges) };
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

  function searchAll(query, laws) {
    const groups = [];
    const hits = [];
    let total = 0;

    for (const law of laws) {
      const lawHits = [];
      for (let i = 0; i < law.articles.length; i += 1) {
        const article = law.articles[i];
        const matched = matchArticle(article, law.name, query);
        if (!matched) continue; // 每条都检查，命中即收录
        const nextNo = law.articles[i + 1] ? law.articles[i + 1].no : ''; // 下一条的条号，用于说明本条范围
        const hit = { law: law.name, no: article.no, body: article.body, ranges: matched.ranges, nextNo };
        lawHits.push(hit);
        hits.push(hit);
      }
      if (lawHits.length) {
        groups.push({ name: law.name, hits: lawHits });
        total += lawHits.length;
      }
    }

    // 条号直达时，法规名匹配检索词的法规排前面（更接近「直接定位」的预期）
    let orderedHits = hits;
    if (query.articleNo && groups.length > 1) {
      const required = query.required.map((word) => normalize(word).norm).filter(Boolean);
      if (required.length) {
        const rank = (name) => {
          const norm = getLawNameNorm(name);
          return required.some((word) => norm.includes(word)) ? 0 : 1;
        };
        groups.sort((a, b) => rank(a.name) - rank(b.name));
        orderedHits = groups.reduce((list, group) => list.concat(group.hits), []);
      }
    }

    return { groups, hits: orderedHits, total, lawCount: groups.length };
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

  /* ---------- 结果渲染（每组默认折叠，点击展开） ---------- */

  function renderResults(result, query, laws) {
    el.list.innerHTML = '';

    const scopeText = '范围 ' + state.selected.size + '/' + state.scopes.length + ' · 遍历 ' + summaryOf(laws);

    if (!result.total) {
      el.pill.textContent = '0 条';
      el.sub.textContent = '检索条件「' + query.raw + '」· ' + scopeText + ' · 无匹配';
      el.emptyTitle.textContent = '未找到匹配「' + query.raw + '」的法条';
      el.emptySub.textContent = query.articleNo
        ? '已遍历 ' + summaryOf(laws) + '；可确认该法规是否有「' + query.articleNo + '」，或去掉条号改用关键字'
        : '已遍历 ' + summaryOf(laws) + '；可减少条件（空格表示同时满足）或调整查询范围';
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

      const isExpanded = state.expandedGroups.has(group.name);
      const visibleHits = isExpanded ? group.hits : group.hits.slice(0, FOLD_AFTER);

      for (const hit of visibleHits) {
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

      // 超出默认显示条数时，提供展开/收起按钮
      if (group.hits.length > FOLD_AFTER) {
        const toggleEl = document.createElement('button');
        toggleEl.className = 'fold-toggle';
        toggleEl.type = 'button';
        toggleEl.dataset.group = group.name;
        if (isExpanded) {
          toggleEl.textContent = '收起（仅显示前 ' + FOLD_AFTER + ' 条）';
        } else {
          toggleEl.textContent = '展开其余 ' + (group.hits.length - FOLD_AFTER) + ' 条';
        }
        groupEl.appendChild(toggleEl);
      }

      frag.appendChild(groupEl);
    }

    el.list.appendChild(frag);
    state.hits = result.hits;

    el.pill.textContent = result.total + ' 条';
    el.sub.textContent =
      '检索条件「' + query.raw + '」· ' + scopeText + ' · 命中 ' + result.lawCount + ' 部 / 共 ' + result.total + ' 条';
    showView('results');

    selectHit(0);
    el.viewResults.scrollTop = 0;
  }

  function selectHit(index) {
    const hit = state.hits[index];
    if (!hit) return;

    // O(1)：只操作上一个和新选中的两个节点，不再 querySelectorAll 全量遍历
    if (state.lastSelEl) state.lastSelEl.classList.remove('is-sel');
    const newEl = el.list.querySelector('.item[data-idx="' + index + '"]');
    if (newEl) newEl.classList.add('is-sel');
    state.lastSelEl = newEl || null;
    state.selectedIdx = index;

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

  function performSearch() {
    const query = parseQuery(el.query.value);

    if (!state.scopes.length) {
      showDefaultEmpty();
      return;
    }
    if (!state.selected.size) {
      showScopeEmpty();
      return;
    }
    // 只写了排除词时没有可匹配的内容
    if (!query.required.length && !query.articleNo) {
      showDefaultEmpty();
      el.query.focus();
      return;
    }

    const laws = scopedLaws();
    state.keyword = query.raw;
    state.expandedGroups.clear(); // 每次新搜索重置折叠状态
    el.pill.textContent = '…';
    el.sub.textContent = '检索条件「' + query.raw + '」· 遍历中…';
    el.loadingText.textContent = '正在遍历 ' + summaryOf(laws) + '…';
    showView('loading');

    // 让「遍历中」的界面先画出来，再做同步匹配
    setTimeout(() => {
      const result = searchAll(query, laws);
      renderResults(result, query, laws);
    }, 30);
  }

  function runSearch() {
    // 取消上一次的防抖/遍历，防止连点叠加
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.searchTimer = null;
    performSearch();
  }

  function scheduleSearch() {
    if (state.searchTimer) clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.searchTimer = null;
      performSearch();
    }, DEBOUNCE_MS);
  }

  function bindEvents() {
    el.run.addEventListener('click', runSearch);

    el.query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        runSearch();
        return;
      }
      // 键盘导航：↑/↓ 在结果间移动，原文窗口联动刷新
      if (!el.viewResults.classList.contains('is-off') && state.hits.length) {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          const next = Math.max(0, state.selectedIdx - 1);
          selectHit(next);
          scrollItemIntoView(next);
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          const next = Math.min(state.hits.length - 1, state.selectedIdx + 1);
          selectHit(next);
          scrollItemIntoView(next);
          return;
        }
      }
    });

    el.query.addEventListener('input', () => {
      const val = el.query.value.trim();
      if (!val) {
        if (state.searchTimer) clearTimeout(state.searchTimer);
        state.searchTimer = null;
        showDefaultEmpty();
        return;
      }
      scheduleSearch();
    });

    el.query.addEventListener('focus', () => el.field.classList.add('is-focus'));
    el.query.addEventListener('blur', () => el.field.classList.remove('is-focus'));

    el.clear.addEventListener('click', () => {
      el.query.value = '';
      if (state.searchTimer) clearTimeout(state.searchTimer);
      state.searchTimer = null;
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

    // 结果点击：切换选中 + 刷新法规原文窗口；展开/收起折叠
    el.list.addEventListener('click', (event) => {
      const toggle = event.target.closest('.fold-toggle');
      if (toggle) {
        const name = toggle.dataset.group;
        if (state.expandedGroups.has(name)) state.expandedGroups.delete(name);
        else state.expandedGroups.add(name);
        // 就地重新渲染当前搜索（保留 query 和 laws）
        const query = parseQuery(el.query.value);
        const laws = scopedLaws();
        const result = searchAll(query, laws);
        renderResults(result, query, laws);
        return;
      }
      const item = event.target.closest('.item');
      if (!item) return;
      selectHit(Number(item.dataset.idx));
    });
  }

  function scrollItemIntoView(index) {
    const item = el.list.querySelector('.item[data-idx="' + index + '"]');
    if (!item) return;
    const container = el.viewResults;
    const itemTop = item.offsetTop - container.offsetTop;
    const itemBottom = itemTop + item.offsetHeight;
    if (itemTop < container.scrollTop) container.scrollTop = itemTop - 8;
    else if (itemBottom > container.scrollTop + container.clientHeight) container.scrollTop = itemBottom - container.clientHeight + 8;
  }

  /* ---------- 启动：读取法规库 ---------- */

  async function init() {
    bindEvents();

    if (!window.lawAPI) {
      el.loadNote.textContent = '初始化失败：未加载到主进程接口';
      return;
    }

    const startedAt = performance.now();
    const result = await window.lawAPI.loadLibrary();
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);

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
      const cacheText = result.parsedCount
        ? '缓存命中 ' + (result.cacheHits || 0) + '，本次解析 ' + result.parsedCount
        : '全部命中缓存';
      el.loadNote.textContent =
        '已读取 ' + (result.fileCount || 0) + ' 个 Word 文件（' + cacheText + '）· ' + seconds + ' 秒';
    }

    showDefaultEmpty();
    el.query.focus();

    // 空闲时预归一化：让首次搜索直接达到全速（不依赖懒计算）
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback((deadline) => preNormalizeBatch(deadline), { timeout: 2000 });
    } else {
      setTimeout(preNormalizeAll, 500);
    }
  }

  // 空闲时间分批预归一化，避免一次性阻塞主线程
  function preNormalizeBatch(deadline) {
    let done = 0;
    for (const law of state.laws) {
      for (const article of law.articles) {
        articleNorm(article);
        done += 1;
        if (deadline.timeRemaining() <= 0) {
          requestIdleCallback((d) => preNormalizeBatch(d), { timeout: 2000 });
          return;
        }
      }
    }
  }

  function preNormalizeAll() {
    for (const law of state.laws) {
      for (const article of law.articles) articleNorm(article);
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
