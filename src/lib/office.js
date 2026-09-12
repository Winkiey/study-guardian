/**
 * 零第三方依赖的 Office 文档（pptx / docx / xlsx）内容提取模块
 *
 * 这些格式都是 OOXML，本质是「一个 zip + 一堆 XML」。
 * 本模块自己写了一个极简 XML 扫描器（不依赖任何 XML 库），
 * 只做「按标签名取文本」这一件事，因此对命名空间前缀、自闭合标签、
 * 属性顺序、单双引号、XML 实体都做了处理。
 *
 * 设计约定：
 * - 提取失败时抛出带中文说明的 Error（例如结构不完整、zip 损坏），不返回半截错误数据。
 * - 无法判断的可选信息（例如列表是否有序号）退化为合理的默认值。
 * - 文本一律保留 XML 中的原始空白与换行，由调用方决定如何渲染。
 */

import { readZip, normalizeZipPath } from './zip.js';

/** 通用位：不需要的占位符类型（备注页里的页码 / 页眉页脚 / 日期） */
const NOTES_IGNORED_PLACEHOLDERS = new Set(['sldNum', 'ftr', 'hdr', 'dt']);
/** 形状容器标签（局部名） */
const SHAPE_NAMES = new Set(['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp', 'contentPart']);
/** XML 最大嵌套深度（防御异常文件导致的爆栈） */
const MAX_XML_DEPTH = 2000;
/** 工作表行号上限（防御异常文件导致的超大数组） */
const MAX_SHEET_ROW = 200000;

/* ------------------------------ XML 小工具 ------------------------------ */

/**
 * 取标签 / 属性的局部名（去掉命名空间前缀），例如 'x:a:t' -> 't'
 * @param {string} rawName 原始名
 * @returns {string}
 */
function localName(rawName) {
  if (typeof rawName !== 'string') return '';
  const index = rawName.indexOf(':');
  return index >= 0 ? rawName.slice(index + 1) : rawName;
}

/** 判断字符是否可作为标签 / 属性名的结束符 */
function isNameEnd(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '/' || ch === '>' || ch === '=';
}

/** 判断字符是否为空白 */
function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';
}

/**
 * 解码 XML 实体：命名实体与十进制 / 十六进制数字实体，单次扫描避免二次解码
 * @param {string} text 原始文本
 * @returns {string}
 */
function unescapeXml(text) {
  if (typeof text !== 'string' || text.indexOf('&') < 0) return text || '';
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9._-]*);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      case 'nbsp':
        return '\u00a0';
      default:
        return match;
    }
  });
}

/**
 * 创建 XML 节点
 * @param {string} rawName 原始标签名（含前缀）
 * @param {Array<{name: string, local: string, value: string}>} attrs 属性
 * @param {object|null} parent 父节点
 * @returns {object}
 */
function createNode(rawName, attrs, parent) {
  return {
    rawName,
    name: localName(rawName),
    attrs,
    text: '',
    children: [],
    parent: parent || null,
  };
}

/**
 * 追加文本内容（自动解码 XML 实体）
 * @param {object} node 目标节点
 * @param {string} raw 原始文本
 * @returns {void}
 */
function appendText(node, raw) {
  node.text += unescapeXml(raw);
}

/**
 * 极简 XML 解析（手写扫描器）
 * 支持：命名空间前缀、自闭合标签、属性顺序任意、属性值单双引号、
 * 注释、CDATA、处理指令、DOCTYPE、命名实体与数字实体。
 * 不做校验，遇到无法理解的内容尽量跳过而不是抛错（OOXML 由 Office 生成，畸形概率低）。
 * @param {string} xml XML 文本
 * @returns {object} 文档根节点（name 为 '#document'）
 */
function parseXml(xml) {
  if (typeof xml !== 'string') throw new Error('XML 解析失败：内容不是字符串');
  const root = createNode('#document', [], null);
  const stack = [root];
  const len = xml.length;
  let i = 0;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      appendText(stack[stack.length - 1], xml.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], xml.slice(i, lt));
    const marker = xml[lt + 1];

    if (marker === '!') {
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        i = end < 0 ? len : end + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        // CDATA 内是原始文本，不做实体解码
        const end = xml.indexOf(']]>', lt + 9);
        stack[stack.length - 1].text += xml.slice(lt + 9, end < 0 ? len : end);
        i = end < 0 ? len : end + 3;
        continue;
      }
      const end = xml.indexOf('>', lt + 2);
      i = end < 0 ? len : end + 1;
      continue;
    }
    if (marker === '?') {
      const end = xml.indexOf('?>', lt + 2);
      i = end < 0 ? len : end + 2;
      continue;
    }
    if (marker === '/') {
      const end = xml.indexOf('>', lt + 2);
      if (stack.length > 1) stack.pop();
      i = end < 0 ? len : end + 1;
      continue;
    }

    // 开始标签
    let j = lt + 1;
    const nameStart = j;
    while (j < len && !isNameEnd(xml[j])) j++;
    const rawName = xml.slice(nameStart, j);
    if (!rawName) {
      i = lt + 1;
      continue;
    }
    const attrs = [];
    while (j < len) {
      while (j < len && isSpace(xml[j])) j++;
      if (j >= len || xml[j] === '>' || xml[j] === '/') break;
      const attrStart = j;
      while (j < len && !isNameEnd(xml[j])) j++;
      const attrName = xml.slice(attrStart, j);
      while (j < len && isSpace(xml[j])) j++;
      let value = '';
      if (xml[j] === '=') {
        j++;
        while (j < len && isSpace(xml[j])) j++;
        const quote = xml[j];
        if (quote === '"' || quote === "'") {
          const end = xml.indexOf(quote, j + 1);
          value = xml.slice(j + 1, end < 0 ? len : end);
          j = end < 0 ? len : end + 1;
        } else {
          const valueStart = j;
          while (j < len && !isNameEnd(xml[j])) j++;
          value = xml.slice(valueStart, j);
        }
      }
      if (attrName) attrs.push({ name: attrName, local: localName(attrName), value: unescapeXml(value) });
    }
    let selfClosing = false;
    if (xml[j] === '/') {
      selfClosing = true;
      j++;
    }
    const gt = xml.indexOf('>', j);
    i = gt < 0 ? len : gt + 1;

    const parent = stack[stack.length - 1];
    const node = createNode(rawName, attrs, parent);
    parent.children.push(node);
    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) {
        throw new Error(`XML 结构异常：嵌套层级超过 ${MAX_XML_DEPTH} 层，疑似文件损坏`);
      }
      stack.push(node);
    }
  }
  return root;
}

/**
 * 读取属性值：先按完整名（含前缀）匹配，再按局部名匹配
 * @param {object|null} node 节点
 * @param {string} name 属性名（可以是 'r:id' 或 'val'）
 * @returns {string|undefined}
 */
function attrOf(node, name) {
  if (!node || !Array.isArray(node.attrs)) return undefined;
  for (const attr of node.attrs) if (attr.name === name) return attr.value;
  const local = localName(name);
  for (const attr of node.attrs) if (attr.local === local) return attr.value;
  return undefined;
}

/**
 * 取直接子节点中指定名字的节点
 * @param {object|null} node 节点
 * @param {string} name 局部名
 * @returns {object|null}
 */
function firstChild(node, name) {
  if (!node) return null;
  for (const child of node.children) if (child.name === name) return child;
  return null;
}

/**
 * 取直接子节点中指定名字的全部节点
 * @param {object|null} node 节点
 * @param {string} name 局部名
 * @returns {object[]}
 */
function childrenOf(node, name) {
  if (!node) return [];
  return node.children.filter((child) => child.name === name);
}

/**
 * 深度优先收集所有指定局部名的后代节点（文档顺序）
 * @param {object|null} node 节点
 * @param {string} name 局部名
 * @param {object[]} [out] 结果累积数组
 * @returns {object[]}
 */
function descendants(node, name, out = []) {
  if (!node) return out;
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    descendants(child, name, out);
  }
  return out;
}

/**
 * 取第一个指定局部名的后代节点
 * @param {object|null} node 节点
 * @param {string} name 局部名
 * @returns {object|null}
 */
function firstDescendant(node, name) {
  if (!node) return null;
  for (const child of node.children) {
    if (child.name === name) return child;
    const found = firstDescendant(child, name);
    if (found) return found;
  }
  return null;
}

/**
 * 拼接节点所有后代文本（含自身文本）
 * @param {object|null} node 节点
 * @returns {string}
 */
function textContent(node) {
  if (!node) return '';
  let text = node.text;
  for (const child of node.children) text += textContent(child);
  return text;
}

/**
 * 按文档顺序深度优先遍历子树
 * @param {object} node 起始节点（遍历它的后代）
 * @param {(node: object) => (string|undefined)} visit 访问函数，返回 'skip' 表示不进入该节点子树
 * @returns {void}
 */
function walk(node, visit) {
  for (const child of node.children) {
    if (visit(child) !== 'skip') walk(child, visit);
  }
}

/**
 * 向上查找最近的形状容器节点
 * @param {object|null} node 起始节点
 * @returns {object|null}
 */
function ancestorShape(node) {
  let current = node ? node.parent : null;
  while (current) {
    if (SHAPE_NAMES.has(current.name)) return current;
    current = current.parent;
  }
  return null;
}

/**
 * 取形状的占位符类型（如 title / ctrTitle / body / sldNum）
 * @param {object|null} shape 形状节点
 * @returns {string} 没有占位符时返回空字符串
 */
function placeholderTypeOf(shape) {
  const nvPr = firstDescendant(shape, 'nvPr');
  const ph = firstChild(nvPr, 'ph');
  return ph ? attrOf(ph, 'type') || '' : '';
}

/* ------------------------------ zip / 关系工具 ------------------------------ */

/**
 * 在 zip 中宽松解析路径（兼容开头的斜杠与 URL 编码）
 * @param {ReturnType<typeof readZip>} zip zip 读取器
 * @param {string} path 目标路径
 * @returns {string|null} 实际存在的条目名
 */
function resolveZipName(zip, path) {
  if (!path) return null;
  const candidates = [path];
  try {
    const decoded = decodeURIComponent(path);
    if (decoded !== path) candidates.push(decoded);
  } catch {
    /* 非法百分号编码：忽略 */
  }
  for (const candidate of candidates) {
    const trimmed = candidate.replace(/^\/+/, '');
    if (zip.has(trimmed)) return trimmed;
  }
  return null;
}

/**
 * 列出 zip 中匹配给定正则的条目（返回规范化后的路径）
 * @param {ReturnType<typeof readZip>} zip zip 读取器
 * @param {RegExp} pattern 匹配正则（不要带 g 标志）
 * @returns {Array<{ name: string, match: RegExpExecArray }>}
 */
function findEntries(zip, pattern) {
  const found = [];
  for (const raw of zip.list()) {
    const name = raw.replace(/^\/+/, '');
    const match = pattern.exec(name);
    if (match) found.push({ name, match });
  }
  return found;
}

/**
 * 由部件路径推出其关系文件路径，例如 'ppt/slides/slide1.xml' -> 'ppt/slides/_rels/slide1.xml.rels'
 * @param {string} part 部件路径
 * @returns {string}
 */
function relsPathFor(part) {
  const index = part.lastIndexOf('/');
  const dir = index < 0 ? '' : part.slice(0, index + 1);
  const file = index < 0 ? part : part.slice(index + 1);
  return `${dir}_rels/${file}.rels`;
}

/**
 * 由部件路径推出其所在目录，例如 'ppt/slides/slide1.xml' -> 'ppt/slides'
 * @param {string} part 部件路径
 * @returns {string}
 */
function dirOf(part) {
  const index = part.lastIndexOf('/');
  return index < 0 ? '' : part.slice(0, index);
}

/**
 * 读取一份 .rels 关系文件
 * @param {ReturnType<typeof readZip>} zip zip 读取器
 * @param {string} relsPath 关系文件路径
 * @returns {Map<string, { type: string, target: string, external: boolean }>} Id -> 关系
 */
function readRels(zip, relsPath) {
  const map = new Map();
  const actual = resolveZipName(zip, relsPath);
  if (!actual) return map;
  let root;
  try {
    root = parseXml(zip.readText(actual));
  } catch {
    return map;
  }
  for (const rel of descendants(root, 'Relationship')) {
    const id = attrOf(rel, 'Id');
    if (!id) continue;
    map.set(id, {
      type: attrOf(rel, 'Type') || '',
      target: attrOf(rel, 'Target') || '',
      external: (attrOf(rel, 'TargetMode') || '').toLowerCase() === 'external',
    });
  }
  return map;
}

/**
 * 读取 docProps 元数据
 * @param {ReturnType<typeof readZip>} zip zip 读取器
 * @returns {{ title?: string, author?: string, created?: string, app?: string }}
 */
function readDocumentProps(zip) {
  /** @type {{ title?: string, author?: string, created?: string, app?: string }} */
  const meta = {};
  const corePath = resolveZipName(zip, 'docProps/core.xml');
  if (corePath) {
    try {
      const root = parseXml(zip.readText(corePath));
      const pairs = [
        ['title', 'title'],
        ['author', 'creator'],
        ['created', 'created'],
      ];
      for (const [key, tag] of pairs) {
        const node = firstDescendant(root, tag);
        const value = node ? textContent(node).trim() : '';
        if (value) meta[key] = value;
      }
    } catch {
      /* 元数据损坏不影响正文提取 */
    }
  }
  const appPath = resolveZipName(zip, 'docProps/app.xml');
  if (appPath) {
    try {
      const app = firstDescendant(parseXml(zip.readText(appPath)), 'Application');
      const value = app ? textContent(app).trim() : '';
      if (value) meta.app = value;
    } catch {
      /* 同上 */
    }
  }
  return meta;
}

/* ------------------------------ PPTX ------------------------------ */

/**
 * 按演示文稿顺序列出幻灯片部件路径
 * 优先使用 ppt/_rels/presentation.xml.rels 的 r:id 顺序（sldIdLst 的顺序），
 * 缺失的幻灯片再按文件名中的数字顺序补齐（不会出现 slide10 排在 slide2 前面）。
 * @param {ReturnType<typeof readZip>} zip zip 读取器
 * @returns {string[]} 幻灯片路径列表
 */
function listSlideParts(zip) {
  const rels = readRels(zip, 'ppt/_rels/presentation.xml.rels');
  const ordered = [];
  const used = new Set();

  const presentationPath = resolveZipName(zip, 'ppt/presentation.xml');
  if (presentationPath) {
    let root = null;
    try {
      root = parseXml(zip.readText(presentationPath));
    } catch {
      root = null;
    }
    const sldIdLst = root ? firstDescendant(root, 'sldIdLst') : null;
    if (sldIdLst) {
      for (const sldId of childrenOf(sldIdLst, 'sldId')) {
        const relId = attrOf(sldId, 'r:id');
        const rel = relId ? rels.get(relId) : null;
        if (!rel || rel.external || !rel.target) continue;
        const part = resolveZipName(zip, normalizeZipPath(rel.target, 'ppt'));
        if (part && !used.has(part)) {
          used.add(part);
          ordered.push(part);
        }
      }
    }
  }

  // 未被引用的幻灯片按数字顺序补齐
  const rest = findEntries(zip, /^ppt\/slides\/slide([0-9]+)\.xml$/i)
    .map(({ name, match }) => ({ name, number: Number(match[1]) }))
    .filter((item) => !used.has(item.name))
    .sort((a, b) => a.number - b.number)
    .map((item) => item.name);

  return [...ordered, ...rest];
}

/**
 * 把 a:tbl 转成二维文本
 * @param {object} tbl 表格节点
 * @returns {string[][]}
 */
function tableToRows(tbl) {
  const rows = [];
  for (const tr of childrenOf(tbl, 'tr')) {
    const cells = [];
    for (const tc of childrenOf(tr, 'tc')) {
      const paragraphs = [];
      for (const txBody of descendants(tc, 'txBody')) paragraphs.push(...paragraphTexts(txBody));
      cells.push(paragraphs.join('\n'));
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * 提取 a:txBody 中的段落文本，同一段内的多个 a:t 会拼接在一起，a:br 作为换行
 * @param {object} txBody 文本框体节点
 * @returns {string[]} 每段一行
 */
function paragraphTexts(txBody) {
  const paragraphs = [];
  for (const p of childrenOf(txBody, 'p')) {
    let line = '';
    walk(p, (node) => {
      if (node.name === 't') {
        line += textContent(node);
        return 'skip';
      }
      if (node.name === 'br') {
        line += '\n';
        return 'skip';
      }
      if (node.name === 'tab') {
        line += '\t';
        return 'skip';
      }
      return undefined;
    });
    paragraphs.push(line);
  }
  return paragraphs;
}

/**
 * 按 XML 出现顺序收集页面上的文本框 / 表格
 * @param {object} root 幻灯片 XML 根节点
 * @param {Set<string>} [ignoredPlaceholders] 需要忽略的占位符类型
 * @returns {Array<{ text: string, placeholderType: string }>}
 */
function collectFrames(root, ignoredPlaceholders = new Set()) {
  const frames = [];
  walk(root, (node) => {
    if (node.name === 'tbl') {
      const rows = tableToRows(node);
      frames.push({
        text: rows.map((row) => row.join(' | ')).join('\n'),
        placeholderType: '',
      });
      return 'skip';
    }
    if (node.name !== 'txBody') return undefined;
    const shape = ancestorShape(node);
    const placeholderType = placeholderTypeOf(shape);
    if (ignoredPlaceholders.has(placeholderType)) return 'skip';
    frames.push({
      text: paragraphTexts(node).join('\n'),
      placeholderType,
    });
    return 'skip';
  });
  return frames;
}

/**
 * 找到某张幻灯片对应的备注页部件
 * @param {ReturnType<typeof readZip>} zip zip 读取器
 * @param {string} slidePart 幻灯片路径
 * @returns {string|null}
 */
function findNotesPart(zip, slidePart) {
  const rels = readRels(zip, relsPathFor(slidePart));
  for (const rel of rels.values()) {
    if (rel.external || !rel.target) continue;
    if (!/\/notesSlide$/i.test(rel.type)) continue;
    const part = resolveZipName(zip, normalizeZipPath(rel.target, dirOf(slidePart)));
    if (part) return part;
  }
  // 退化策略：同名数字的备注页
  const match = /slide([0-9]+)\.xml$/i.exec(slidePart);
  if (match) {
    const part = resolveZipName(zip, `ppt/notesSlides/notesSlide${match[1]}.xml`);
    if (part) return part;
  }
  return null;
}

/**
 * 提取 PPTX：按幻灯片顺序返回标题、正文文本与讲者备注
 * @param {Buffer|Uint8Array} buffer pptx 文件内容
 * @returns {{
 *   slides: Array<{ index: number, title: string, texts: string[], notes: string }>,
 *   slideCount: number,
 *   meta: { title?: string, author?: string, app?: string, created?: string }
 * }}
 * 说明：
 * - 幻灯片顺序优先按 ppt/_rels/presentation.xml.rels + presentation.xml 的 sldIdLst 顺序，
 *   缺失时退化为按 ppt/slides/slideN.xml 的数字顺序。
 * - texts 为页面内所有文本框（含标题形状）的文本，按 XML 中出现顺序，同一文本框内段落以 \n 连接；
 *   标题另外由 title 字段给出（没有标题占位符时为空字符串）。
 * - notes 为讲者备注（已忽略页码 / 页眉页脚 / 日期占位符）。
 * @throws {Error} zip 损坏或找不到任何幻灯片时抛出中文错误
 */
export function extractPptx(buffer) {
  const zip = readZip(buffer);
  const slideParts = listSlideParts(zip);
  if (slideParts.length === 0) {
    throw new Error('PPTX 结构异常：找不到任何幻灯片（ppt/slides/slideN.xml）');
  }

  const slides = slideParts.map((part, position) => {
    const root = parseXml(zip.readText(part));
    const frames = collectFrames(root);

    // 标题取标题占位符所在形状的文本
    const titleFrame = frames.find(
      (frame) => frame.placeholderType === 'title' || frame.placeholderType === 'ctrTitle',
    );
    // texts 保留文本框原始换行，只去掉末尾空白（空段落产生的尾换行对渲染没意义）
    const texts = frames
      .map((frame) => frame.text.replace(/[\s\u00a0]+$/, ''))
      .filter((text) => text !== '');

    let notes = '';
    const notesPart = findNotesPart(zip, part);
    if (notesPart) {
      const notesRoot = parseXml(zip.readText(notesPart));
      const notesFrames = collectFrames(notesRoot, NOTES_IGNORED_PLACEHOLDERS);
      notes = notesFrames
        .map((frame) => frame.text.trim())
        .filter((text) => text !== '')
        .join('\n');
    }

    return {
      index: position + 1,
      title: titleFrame ? titleFrame.text.trim() : '',
      texts,
      notes,
    };
  });

  const meta = readDocumentProps(zip);
  return { slides, slideCount: slides.length, meta };
}

/* ------------------------------ DOCX ------------------------------ */

/**
 * 由段落样式名推断标题层级
 * 支持 'Heading1' / 'heading 1' / '1' / '标题 1' / 'Title'
 * @param {string|undefined} styleValue w:pStyle 的 w:val
 * @returns {number} 层级（1-9），不是标题时返回 0
 */
function headingLevelOf(styleValue) {
  if (!styleValue) return 0;
  const value = String(styleValue).trim();
  const patterns = [/^heading\s*([1-9])\b/i, /^([1-9])$/, /^标题\s*([1-9])$/, /^h([1-9])$/i];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match) return Number(match[1]);
  }
  if (/^title$/i.test(value) || /^标题$/.test(value)) return 1;
  return 0;
}

/**
 * 解析 word/numbering.xml，得到 numId -> 抽象编号 id，以及抽象编号的各级编号格式
 * @param {ReturnType<typeof readZip>} zip zip 读取器
 * @returns {{ numToAbstract: Map<string, string>, abstractFormats: Map<string, Map<string, string>> }}
 */
function parseNumbering(zip) {
  const numToAbstract = new Map();
  const abstractFormats = new Map();
  const path = resolveZipName(zip, 'word/numbering.xml');
  if (!path) return { numToAbstract, abstractFormats };
  let root;
  try {
    root = parseXml(zip.readText(path));
  } catch {
    return { numToAbstract, abstractFormats };
  }
  for (const num of descendants(root, 'num')) {
    const numId = attrOf(num, 'numId');
    const abstractId = attrOf(firstChild(num, 'abstractNumId'), 'val');
    if (numId && abstractId) numToAbstract.set(String(numId), String(abstractId));
  }
  for (const abstract of descendants(root, 'abstractNum')) {
    const abstractId = attrOf(abstract, 'abstractNumId');
    if (!abstractId) continue;
    const levels = new Map();
    for (const lvl of childrenOf(abstract, 'lvl')) {
      const ilvl = attrOf(lvl, 'ilvl') || '0';
      const numFmt = attrOf(firstChild(lvl, 'numFmt'), 'val') || '';
      levels.set(String(ilvl), numFmt);
    }
    abstractFormats.set(String(abstractId), levels);
  }
  return { numToAbstract, abstractFormats };
}

/**
 * 判断某个 numId / ilvl 是否为有序编号（无法判断时默认 true）
 * @param {string|undefined} numId 编号 id
 * @param {string|undefined} ilvl 层级
 * @param {{ numToAbstract: Map<string, string>, abstractFormats: Map<string, Map<string, string>> }} numbering 编号定义
 * @returns {boolean}
 */
function isOrderedList(numId, ilvl, numbering) {
  if (!numId) return true;
  const abstractId = numbering.numToAbstract.get(String(numId));
  if (!abstractId) return true;
  const levels = numbering.abstractFormats.get(String(abstractId));
  if (!levels) return true;
  const fmt = levels.get(String(ilvl || '0')) ?? levels.get('0');
  if (!fmt) return true;
  return fmt !== 'bullet' && fmt !== 'none';
}

/**
 * 提取段落内的文本：w:t 取文本、w:tab 制表符、w:br / w:cr 换行，
 * 跳过拼音注音、域代码与删除文本
 * @param {object} paragraph w:p 节点
 * @returns {string}
 */
function paragraphText(paragraph) {
  let text = '';
  const skipped = new Set(['rPh', 'rt', 'instrText', 'delText', 'pPr', 'rPr']);
  walk(paragraph, (node) => {
    if (skipped.has(node.name)) return 'skip';
    if (node.name === 't') {
      text += textContent(node);
      return 'skip';
    }
    if (node.name === 'tab') {
      text += '\t';
      return 'skip';
    }
    if (node.name === 'br' || node.name === 'cr') {
      text += '\n';
      return 'skip';
    }
    if (node.name === 'noBreakHyphen') {
      text += '-';
      return 'skip';
    }
    if (node.name === 'softHyphen') return 'skip';
    return undefined;
  });
  return text;
}

/**
 * 把一个 w:p 节点转成块对象
 * @param {object} paragraph w:p 节点
 * @param {ReturnType<typeof parseNumbering>} numbering 编号定义
 * @returns {{ type: string, level?: number, text: string, ordered?: boolean }}
 */
function buildParagraphBlock(paragraph, numbering) {
  const text = paragraphText(paragraph);
  const pPr = firstChild(paragraph, 'pPr');
  const styleValue = attrOf(firstChild(pPr, 'pStyle'), 'val');
  const level = headingLevelOf(styleValue);
  if (level > 0) return { type: 'heading', level, text };

  const numPr = firstChild(pPr, 'numPr');
  if (numPr) {
    const numId = attrOf(firstChild(numPr, 'numId'), 'val');
    const ilvl = attrOf(firstChild(numPr, 'ilvl'), 'val');
    return { type: 'listItem', text, ordered: isOrderedList(numId, ilvl, numbering) };
  }

  // 段落自带大纲级别时也当作标题
  const outlineLevel = attrOf(firstChild(pPr, 'outlineLvl'), 'val');
  const outlineNumber = Number(outlineLevel);
  if (Number.isInteger(outlineNumber) && outlineNumber >= 0 && outlineNumber <= 8) {
    return { type: 'heading', level: outlineNumber + 1, text };
  }
  return { type: 'paragraph', text };
}

/**
 * 提取 w:tbl 的行列文本，按 w:gridSpan 复制被合并的单元格值
 * @param {object} tbl w:tbl 节点
 * @returns {string[][]}
 */
function buildTableRows(tbl) {
  const rows = [];
  for (const tr of childrenOf(tbl, 'tr')) {
    const cells = [];
    for (const tc of childrenOf(tr, 'tc')) {
      const gridSpanValue = Number(attrOf(firstChild(firstChild(tc, 'tcPr'), 'gridSpan'), 'val'));
      const gridSpan = Number.isInteger(gridSpanValue) && gridSpanValue > 1 ? gridSpanValue : 1;

      const parts = [];
      for (const child of tc.children) {
        if (child.name === 'p') parts.push(paragraphText(child));
        else if (child.name === 'tbl') {
          // 嵌套表格：拍平成文本，保证不崩
          parts.push(buildTableRows(child).map((row) => row.join(' ')).join('\n'));
        }
      }
      const value = parts.join('\n');
      for (let i = 0; i < gridSpan; i++) cells.push(value);
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * 按文档顺序把 body 的子节点转成块列表（w:sdt 会被就地展开）
 * @param {object} node 容器节点
 * @param {ReturnType<typeof parseNumbering>} numbering 编号定义
 * @param {object[]} blocks 结果累积数组
 * @returns {void}
 */
function collectDocxBlocks(node, numbering, blocks) {
  for (const child of node.children) {
    if (child.name === 'p') {
      blocks.push(buildParagraphBlock(child, numbering));
    } else if (child.name === 'tbl') {
      blocks.push({ type: 'table', rows: buildTableRows(child) });
    } else if (child.name === 'sdt') {
      const content = firstChild(child, 'sdtContent');
      if (content) collectDocxBlocks(content, numbering, blocks);
    }
  }
}

/**
 * 块的纯文本表示
 * @param {{ type: string, text?: string, rows?: string[][] }} block 块
 * @returns {string}
 */
function blockPlainText(block) {
  if (block.type === 'table') {
    return (block.rows || []).map((row) => row.join('\t')).join('\n');
  }
  return block.text || '';
}

/**
 * 提取 DOCX：按文档顺序返回段落、标题、列表项与表格
 * @param {Buffer|Uint8Array} buffer docx 文件内容
 * @returns {{
 *   blocks: Array<{ type: string, level?: number, text?: string, ordered?: boolean, rows?: string[][] }>,
 *   text: string,
 *   meta: { title?: string, author?: string, created?: string }
 * }}
 * @throws {Error} zip 损坏或缺少 word/document.xml 时抛出中文错误
 */
export function extractDocx(buffer) {
  const zip = readZip(buffer);
  const documentPath = resolveZipName(zip, 'word/document.xml');
  if (!documentPath) throw new Error('DOCX 结构异常：缺少 word/document.xml');

  const root = parseXml(zip.readText(documentPath));
  const numbering = parseNumbering(zip);
  const body = firstDescendant(root, 'body') || root;

  /** @type {object[]} */
  const blocks = [];
  collectDocxBlocks(body, numbering, blocks);

  const text = blocks.map(blockPlainText).join('\n');
  const meta = readDocumentProps(zip);
  return {
    blocks,
    text,
    meta: {
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.author ? { author: meta.author } : {}),
      ...(meta.created ? { created: meta.created } : {}),
    },
  };
}

/* ------------------------------ XLSX ------------------------------ */

/**
 * 读取共享字符串表
 * @param {ReturnType<typeof readZip>} zip zip 读取器
 * @returns {string[]} 下标即共享字符串索引
 */
function readSharedStrings(zip) {
  const path = resolveZipName(zip, 'xl/sharedStrings.xml');
  if (!path) return [];
  const root = parseXml(zip.readText(path));
  return descendants(root, 'si').map((si) => collectRunText(si));
}

/**
 * 拼接 <si> / <is> 里的富文本（跳过注音 rPh）
 * @param {object} node 容器节点
 * @returns {string}
 */
function collectRunText(node) {
  let text = '';
  walk(node, (child) => {
    if (child.name === 'rPh' || child.name === 'phoneticPr' || child.name === 'rPr') return 'skip';
    if (child.name === 't') {
      text += textContent(child);
      return 'skip';
    }
    return undefined;
  });
  return text;
}

/**
 * 由单元格引用（如 'AB12'）解析列号（从 0 开始）
 * @param {string} ref 单元格引用
 * @returns {number} 列号，无法解析时返回 -1
 */
function columnIndexOf(ref) {
  const match = /^([A-Za-z]+)/.exec(String(ref || ''));
  if (!match) return -1;
  let index = 0;
  for (const ch of match[1].toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * 取单元格的显示值
 * @param {object} cell c 节点
 * @param {string[]} sharedStrings 共享字符串表
 * @returns {string}
 */
function cellDisplayValue(cell, sharedStrings) {
  const type = attrOf(cell, 't') || '';
  if (type === 'inlineStr') {
    const inline = firstChild(cell, 'is');
    return inline ? collectRunText(inline) : '';
  }
  const valueNode = firstChild(cell, 'v');
  const raw = valueNode ? textContent(valueNode) : '';
  if (type === 's') {
    // 注意：Number('') === 0，必须先排除空值，否则空单元格会取到第 0 个共享字符串
    if (raw === '') return '';
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index < sharedStrings.length
      ? sharedStrings[index]
      : '';
  }
  if (type === 'b') {
    if (raw === '') return '';
    return raw === '1' || raw.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
  }
  // 'str'（公式字符串）、'e'（错误值）、'n' / 'd'（数值、日期）都直接取 <v>
  return raw;
}

/**
 * 读取一张工作表的显示值矩阵，缺失单元格补空字符串以对齐列
 * @param {ReturnType<typeof readZip>} zip zip 读取器
 * @param {string} sheetPath 工作表路径
 * @param {string[]} sharedStrings 共享字符串表
 * @returns {string[][]}
 */
function readSheetRows(zip, sheetPath, sharedStrings) {
  const root = parseXml(zip.readText(sheetPath));
  const sheetData = firstDescendant(root, 'sheetData');
  if (!sheetData) return [];

  /** @type {Array<{ index: number, cells: string[] }>} */
  const collected = [];
  let implicitRow = 0;
  let maxColumn = 0;

  for (const rowNode of childrenOf(sheetData, 'row')) {
    const declaredRow = Number(attrOf(rowNode, 'r'));
    const rowIndex = Number.isInteger(declaredRow) && declaredRow > 0 ? declaredRow : implicitRow + 1;
    implicitRow = rowIndex;
    if (rowIndex > MAX_SHEET_ROW) {
      throw new Error(`XLSX 结构异常：工作表行号 ${rowIndex} 超出合理范围（可能存在稀疏填充攻击）`);
    }
    const cells = [];
    let implicitColumn = 0;
    for (const cellNode of childrenOf(rowNode, 'c')) {
      const ref = attrOf(cellNode, 'r');
      const column = ref ? columnIndexOf(ref) : implicitColumn;
      if (column < 0) continue;
      implicitColumn = column + 1;
      while (cells.length < column) cells.push('');
      const value = cellDisplayValue(cellNode, sharedStrings);
      if (cells.length === column) cells.push(value);
      else cells[column] = value;
      if (column + 1 > maxColumn) maxColumn = column + 1;
    }
    collected.push({ index: rowIndex, cells });
  }

  collected.sort((a, b) => a.index - b.index);
  /** @type {string[][]} */
  const rows = [];
  for (const row of collected) {
    while (rows.length < row.index - 1) rows.push([]);
    rows.push(row.cells);
  }
  // 按整张表的最大列数补齐，保证所有行的列对齐
  for (const row of rows) {
    while (row.length < maxColumn) row.push('');
  }
  return rows;
}

/**
 * 提取 XLSX：按工作簿中的顺序返回每张工作表的二维显示值
 * @param {Buffer|Uint8Array} buffer xlsx 文件内容
 * @returns {{
 *   sheets: Array<{ name: string, rows: string[][] }>,
 *   meta: { title?: string, author?: string }
 * }}
 * @throws {Error} zip 损坏或缺少 xl/workbook.xml 时抛出中文错误
 */
export function extractXlsx(buffer) {
  const zip = readZip(buffer);
  const workbookPath = resolveZipName(zip, 'xl/workbook.xml');
  if (!workbookPath) throw new Error('XLSX 结构异常：缺少 xl/workbook.xml');

  const sharedStrings = readSharedStrings(zip);
  const rels = readRels(zip, 'xl/_rels/workbook.xml.rels');
  const root = parseXml(zip.readText(workbookPath));
  const sheetsNode = firstDescendant(root, 'sheets') || root;

  const worksheetFiles = findEntries(zip, /^xl\/worksheets\/sheet[0-9]+\.xml$/i)
    .map(({ name, match }) => ({ name, number: Number(/sheet([0-9]+)\.xml$/i.exec(match[0])[1]) }))
    .sort((a, b) => a.number - b.number);

  /** @type {Array<{ name: string, rows: string[][] }>} */
  const sheets = [];
  const usedFiles = new Set();
  let spareIndex = 0;

  /** 取一张还没被用过的工作表文件 */
  const takeSpareFile = () => {
    while (spareIndex < worksheetFiles.length && usedFiles.has(worksheetFiles[spareIndex].name)) {
      spareIndex++;
    }
    const file = worksheetFiles[spareIndex];
    if (!file) return null;
    spareIndex++;
    return file.name;
  };

  for (const sheetNode of childrenOf(sheetsNode, 'sheet')) {
    const name = attrOf(sheetNode, 'name') || `Sheet${sheets.length + 1}`;
    const relId = attrOf(sheetNode, 'r:id');
    const rel = relId ? rels.get(relId) : null;

    let sheetPath = null;
    if (rel && !rel.external && rel.target) {
      sheetPath = resolveZipName(zip, normalizeZipPath(rel.target, 'xl'));
    }
    if (!sheetPath) {
      const sheetId = attrOf(sheetNode, 'sheetId');
      if (sheetId) sheetPath = resolveZipName(zip, `xl/worksheets/sheet${sheetId}.xml`);
    }
    if (!sheetPath) sheetPath = takeSpareFile();
    if (!sheetPath) {
      // 清单里列了但文件不存在：给出空表而不是抛错，让预览仍可用
      sheets.push({ name, rows: [] });
      continue;
    }
    usedFiles.add(sheetPath);
    sheets.push({ name, rows: readSheetRows(zip, sheetPath, sharedStrings) });
  }

  // 完全没有清单时退化为按文件名顺序读取
  if (sheets.length === 0) {
    for (const file of worksheetFiles) {
      sheets.push({
        name: file.name.replace(/^.*\//, '').replace(/\.xml$/i, ''),
        rows: readSheetRows(zip, file.name, sharedStrings),
      });
    }
  }

  const meta = readDocumentProps(zip);
  return {
    sheets,
    meta: {
      ...(meta.title ? { title: meta.title } : {}),
      ...(meta.author ? { author: meta.author } : {}),
    },
  };
}

/* ------------------------------ 统一入口 ------------------------------ */

/**
 * 按扩展名分发到对应的提取函数
 * @param {Buffer|Uint8Array} buffer 文件内容
 * @param {string} ext 扩展名，形如 '.pptx'（大小写不敏感，允许不带点）
 * @returns {object|null} 提取结果；扩展名不受支持时返回 null；
 *   zip 损坏或结构异常时抛出带中文说明的 Error（不返回错误数据）
 */
export function extractOffice(buffer, ext) {
  const normalized = typeof ext === 'string' ? ext.trim().toLowerCase() : '';
  const key = normalized.startsWith('.') ? normalized : `.${normalized}`;
  switch (key) {
    case '.pptx':
    case '.pptm':
    case '.potx':
      return extractPptx(buffer);
    case '.docx':
    case '.docm':
      return extractDocx(buffer);
    case '.xlsx':
    case '.xlsm':
      return extractXlsx(buffer);
    default:
      return null;
  }
}
