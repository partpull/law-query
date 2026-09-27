const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');

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

// 启动时加载整个法规库（按二级文件夹划分查询范围）
async function loadLibrary(folder, folderLabel) {
  const result = {
    folder,
    folderLabel: folderLabel || path.basename(folder),
    scopes: [],
    laws: [],
    fileCount: 0,
    totalArticles: 0,
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

  for (const group of groups) {
    const scope = { id: group.id, label: group.label, fileCount: group.files.length, articleCount: 0 };

    for (const file of group.files) {
      try {
        const { value } = await mammoth.extractRawText({ path: file });
        const articles = splitArticles(value);
        if (!articles.length) {
          result.failed.push(path.basename(file));
          continue;
        }
        result.laws.push({
          name: guessLawName(value, file),
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

  return result;
}

module.exports = { loadLibrary, splitArticles, guessLawName, listDocxFiles, collectArticleMarks, collectGroups };