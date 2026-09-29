const fs = require('fs');
const path = require('path');
// mammoth 依赖链较大，只在确实需要解析 Word 时才加载（缓存全命中时启动零开销）

// 「第X条」识别：兼容中文数字、阿拉伯数字（含全角）、字间空格
const CN_NUM = '零〇一二三四五六七八九十百千万两';
const ARTICLE_SOURCE = '第\\s*[0-9０-９' + CN_NUM + ']+\\s*条';
// 条号后紧跟这些字时属于正文里的引用（如「第十五条第一款规定」「依照第七条规定」），不是新条的开头
const REFERENCE_FOLLOW = /[的规所中第款项目和与或之内至及、]/;

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 两: 2 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

// 「第十五条」→ 15
function articleNumber(no) {
  const raw = no
    .replace(/^第/, '')
    .replace(/条$/, '')
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(raw)) return Number(raw);

  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of raw) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        section = (section + digit) * unit;
        total += section;
        section = 0;
      } else {
        section += (digit || 1) * unit;
      }
      digit = 0;
    }
  }
  return total + section + digit;
}

// 条号是否整体递增：真实条文的条号是从第一条起连续递增的
function isArticleSequence(marks) {
  let prev = 0;
  let back = 0;
  for (const mark of marks) {
    const n = articleNumber(mark.no);
    if (n <= prev) back += 1;
    else prev = n;
  }
  return back <= Math.max(1, Math.floor(marks.length * 0.05));
}

// 收集条文的起始位置
// strict = true：只认段首的「第X条」（正确逻辑）；false：全文任意位置（整篇未分段时的兜底）
function collectArticleMarks(text, strict) {
  const re = strict
    ? new RegExp('^[\\s]*(' + ARTICLE_SOURCE + ')', 'gm')
    : new RegExp('(' + ARTICLE_SOURCE + ')', 'g');

  const marks = [];
  let matched;
  while ((matched = re.exec(text)) !== null) {
    const end = matched.index + matched[0].length;
    if (strict) {
      const next = text[end] || '';
      if (REFERENCE_FOLLOW.test(next)) continue; // 段首出现但后接「的/规定/第一款」等 → 判定为引用
    }
    marks.push({ no: matched[1].replace(/\s+/g, ''), start: matched.index, end });
  }
  return marks;
}

// 法规库根目录直接放的 Word 归入「未分类」
const UNCLASSIFIED_ID = '未分类';
const UNCLASSIFIED_LABEL = '未分类（根目录）';

function isDocxFile(name) {
  return /\.docx$/i.test(name) && !name.startsWith('~$');
}

// 列出文件夹中的 .docx（不进入子目录）
function listDocxFiles(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isDocxFile(entry.name))
    .map((entry) => path.join(folder, entry.name));
}

// 递归收集某个二级文件夹下的 .docx（更深层的子目录也算在该范围内）
function walkDocx(dirPath, out = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walkDocx(full, out);
    else if (entry.isFile() && isDocxFile(entry.name)) out.push(full);
  }
  return out;
}

// 收集查询范围：法规库下的二级文件夹 + 根目录文件（未分类，排最后）
function collectGroups(folder) {
  const entries = fs.readdirSync(folder, { withFileTypes: true });
  const groups = [];

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  for (const dir of dirs) {
    const files = walkDocx(path.join(folder, dir.name));
    if (files.length) groups.push({ id: dir.name, label: dir.name, files });
  }

  const rootFiles = entries.filter((entry) => entry.isFile() && isDocxFile(entry.name)).map((entry) => path.join(folder, entry.name));
  if (rootFiles.length) groups.push({ id: UNCLASSIFIED_ID, label: UNCLASSIFIED_LABEL, files: rootFiles });

  return groups;
}

// 法规名：优先取文档开头的标题行，否则用文件名
function guessLawName(rawText, filePath) {
  const lines = String(rawText || '')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ''))
    .filter(Boolean);

  for (const line of lines.slice(0, 5)) {
    if (line.length > 40) continue;
    const matched = line.match(/《([^》]{1,30})》/);
    if (matched) return '《' + matched[1] + '》';
    if (/(法|条例|办法|规定|规则|解释|细则|决定|通知|意见)$/.test(line)) return line;
  }
  return path.basename(filePath, path.extname(filePath));
}

// 按「第X条」把全文拆成一条条法条，返回 [{ no, body }]
function splitArticles(rawText) {
  const text = String(rawText || '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF/, '');

  // 正确逻辑：只有段首的「第X条」才是新条的开头，正文中间的引用（如「出现第十五条第一款情形」）不拆
  let marks = collectArticleMarks(text, true);
  // 兜底：只有「几乎没拆出条、却存在大量条号、且条号连续递增」才说明该文档只是没按条分段，
  // 此时退回全文匹配以免丢内容；函、通知、清单这类没有条文结构的文件会整体存为一条「全文」
  if (marks.length <= 24) {
    const loose = collectArticleMarks(text, false);
    if (loose.length >= 20 && marks.length <= loose.length / 4 && isArticleSequence(loose)) marks = loose;
  }

  // 没有「第X条」的文档：整篇作为一条存入，避免内容查不到
  if (marks.length === 0) {
    const whole = text.trim();
    return whole ? [{ no: '全文', body: whole }] : [];
  }

  const articles = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end; // 去掉条号本身，正文单独存
    const to = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const body = text.slice(from, to).trim();
    if (!body) continue;
    articles.push({ no: marks[i].no, body });
  }
  return articles;
}

// 索引缓存：把拆条结果存到用户数据目录，按文件的修改时间 + 大小增量更新
const CACHE_FORMAT = 1;

function readCache(cachePath, libraryPath) {
  try {
    if (!cachePath || !fs.existsSync(cachePath)) return null;
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!data || data.format !== CACHE_FORMAT || data.library !== libraryPath) return null;
    return data.files || null;
  } catch (err) {
    return null; // 缓存损坏就当作没有缓存
  }
}

function writeCache(cachePath, libraryPath, files) {
  if (!cachePath) return;
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ format: CACHE_FORMAT, library: libraryPath, files }), 'utf8');
  } catch (err) {
    // 缓存写不进去不影响使用
  }
}

// 启动时加载整个法规库（按二级文件夹划分查询范围，命中的缓存直接复用）
async function loadLibrary(folder, folderLabel, cachePath) {
  const result = {
    folder,
    folderLabel: folderLabel || path.basename(folder),
    scopes: [],
    laws: [],
    fileCount: 0,
    totalArticles: 0,
    cacheHits: 0,
    parsedCount: 0,
    failed: [],
    error: '',
  };

  try {
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    result.error = '无法创建法规库文件夹：' + err.message;
    return result;
  }

  let groups = [];
  try {
    groups = collectGroups(folder);
  } catch (err) {
    result.error = '无法读取法规库文件夹：' + err.message;
    return result;
  }

  const cached = readCache(cachePath, folder);
  const nextCache = {};
  let cacheDirty = !cached;

  for (const group of groups) {
    const scope = { id: group.id, label: group.label, fileCount: group.files.length, articleCount: 0 };

    for (const file of group.files) {
      const key = path.relative(folder, file);
      let stat = null;
      try {
        stat = fs.statSync(file);
      } catch (err) {
        stat = null;
      }

      const hit =
        cached && stat && cached[key] && cached[key].size === stat.size && cached[key].mtimeMs === stat.mtimeMs
          ? cached[key]
          : null;

      if (hit) {
        result.cacheHits += 1;
        nextCache[key] = hit;
        result.laws.push({
          name: hit.name,
          file: path.basename(file),
          scope: scope.id,
          scopeLabel: scope.label,
          articles: hit.articles,
          articleCount: hit.articles.length,
        });
        scope.articleCount += hit.articles.length;
        result.totalArticles += hit.articles.length;
        continue;
      }

      try {
        const mammoth = require('mammoth'); // 懒加载：仅缓存未命中、需要解析时才执行
        const { value } = await mammoth.extractRawText({ path: file });
        const articles = splitArticles(value);
        if (!articles.length) {
          result.failed.push(path.basename(file));
          continue;
        }
        const name = guessLawName(value, file);
        result.parsedCount += 1;
        cacheDirty = true;
        nextCache[key] = {
          size: stat ? stat.size : 0,
          mtimeMs: stat ? stat.mtimeMs : 0,
          name,
          articles,
        };
        result.laws.push({
          name,
          file: path.basename(file),
          scope: scope.id,
          scopeLabel: scope.label,
          articles,
          articleCount: articles.length,
        });
        scope.articleCount += articles.length;
        result.totalArticles += articles.length;
      } catch (err) {
        // .doc 等不支持的格式会走到这里
        result.failed.push(path.basename(file));
      }
    }

    result.fileCount += group.files.length;
    result.scopes.push(scope);
  }

  // 文件数量变化（新增/删除）也要刷新缓存
  if (cached && Object.keys(cached).length !== Object.keys(nextCache).length) cacheDirty = true;
  if (cacheDirty) writeCache(cachePath, folder, nextCache);

  return result;
}

module.exports = { loadLibrary, splitArticles, guessLawName, listDocxFiles, collectArticleMarks, collectGroups };