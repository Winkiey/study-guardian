/**
 * src/lib/office.js 的单元测试
 *
 * 不提交真实 Office 文件：用 tests/_zipfixture.js 的最小 zip 打包器，
 * 现场拼出「结构正确但内容极简」的 pptx / docx / xlsx，再验证提取结果。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { extractPptx, extractDocx, extractXlsx, extractOffice } from '../src/lib/office.js';
import { buildZip } from './_zipfixture.js';

const NS = {
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  od: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  ss: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  cp: 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
};

/**
 * 把 { 部件名: 内容 } 打成 zip（默认 deflate，贴近真实 Office 文件）
 * 内容为 null 时生成目录项；内容也可传对象以覆盖 method / crc32 等
 * @param {Record<string, string|Buffer|null|object>} parts 部件表
 * @param {object} [options] 透传给 buildZip
 * @returns {Buffer}
 */
function zipFromParts(parts, options = {}) {
  const entries = Object.entries(parts)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => {
      if (value === null) return { name, dir: true };
      if (typeof value === 'string' || Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return { name, data: value, method: 'deflate' };
      }
      return { name, method: 'deflate', ...value };
    });
  return buildZip(entries, options);
}

/** 通用 docProps/core.xml */
function coreXml({ title = '示例课件', creator = '王老师', created = '2024-09-01T08:00:00Z' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="${NS.cp}" xmlns:dc="${NS.dc}" xmlns:dcterms="${NS.dcterms}" xmlns:xsi="${NS.xsi}">
<dc:title>${title}</dc:title><dc:creator>${creator}</dc:creator><cp:lastModifiedBy>李老师</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>`;
}

/** 一张幻灯片的 XML：标题占位符 + 正文占位符 */
function slideXml({ titleType = 'ctrTitle', titleRuns, bodyParagraphs = [] }) {
  const body = bodyParagraphs
    .map((runs) => `<a:p>${runs}</a:p>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.od}" xmlns:p="${NS.p}">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${titleType}"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${titleRuns}</a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="内容占位符 2"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/** 备注页 XML：含正文备注 + 页码占位符（页码应被忽略） */
function notesXml(text) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="${NS.a}" xmlns:r="${NS.od}" xmlns:p="${NS.p}">
<p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="备注占位符"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="页码"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" sz="quarter" idx="10"/></p:nvPr></p:nvSpPr>
<p:txBody><a:p><a:fld id="{00000000-0000-0000-0000-000000000001}" type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`;
}

/** 组装一个最小但结构完整的 pptx */
function makePptx({ slides, presentation, presentationRels, extras = {} }) {
  return zipFromParts({
    '[Content_Types].xml': `<Types xmlns="${NS.ct}"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${NS.od}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'docProps/core.xml': coreXml(),
    'docProps/app.xml': `<Properties xmlns="${NS.ct}"><Application>Microsoft Office PowerPoint</Application></Properties>`,
    'ppt/': null,
    'ppt/presentation.xml': presentation,
    'ppt/_rels/presentation.xml.rels': presentationRels,
    ...slides,
    ...extras,
  });
}

/** 一份标准的 presentation.xml（sldIdLst 决定幻灯片顺序） */
function presentationXml(relIds) {
  const ids = relIds.map((relId, index) => `<p:sldId id="${256 + index}" r:id="${relId}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="${NS.a}" xmlns:r="${NS.od}" xmlns:p="${NS.p}">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
}

/** 一份标准的 presentation.xml.rels */
function presentationRels(tuples) {
  const items = tuples
    .map(([id, target]) => `<Relationship Id="${id}" Type="${NS.od}/slide" Target="${target}"/>`)
    .join('');
  return `<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${NS.od}/slideMaster" Target="slideMasters/slideMaster1.xml"/>${items}</Relationships>`;
}

/* ------------------------------ PPTX ------------------------------ */

test('extractPptx：提取标题、正文、讲者备注与元数据', () => {
  const buffer = makePptx({
    presentation: presentationXml(['rId2', 'rId3']),
    presentationRels: presentationRels([
      ['rId2', 'slides/slide1.xml'],
      ['rId3', 'slides/slide2.xml'],
    ]),
    slides: {
      'ppt/slides/slide1.xml': slideXml({
        titleRuns: '<a:r><a:rPr lang="zh-CN" dirty="0"/><a:t>第一讲 &amp; 概述</a:t></a:r><a:br/><a:r><a:t>副标题 &#8217;测试</a:t></a:r>',
        bodyParagraphs: [
          '<a:r><a:t>要点一</a:t></a:r>',
          '<a:r><a:t>要点</a:t></a:r><a:r><a:t>二</a:t></a:r>',
        ],
      }),
      'ppt/slides/slide2.xml': slideXml({
        titleRuns: '<a:r><a:t>第二讲</a:t></a:r>',
        bodyParagraphs: ['<a:r><a:t>只有一个要点</a:t></a:r>'],
      }),
    },
    extras: {
      'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${NS.od}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
      'ppt/notesSlides/notesSlide1.xml': notesXml('讲者备注：记得布置作业'),
    },
  });

  const result = extractPptx(buffer);
  assert.equal(result.slideCount, 2);
  assert.deepEqual(result.slides.map((slide) => slide.index), [1, 2]);

  const first = result.slides[0];
  assert.equal(first.title, '第一讲 & 概述\n副标题 \u2019测试');
  assert.deepEqual(first.texts, ['第一讲 & 概述\n副标题 \u2019测试', '要点一\n要点二']);
  assert.equal(first.notes, '讲者备注：记得布置作业');

  const second = result.slides[1];
  assert.equal(second.title, '第二讲');
  assert.deepEqual(second.texts, ['第二讲', '只有一个要点']);
  assert.equal(second.notes, '');

  assert.deepEqual(result.meta, {
    title: '示例课件',
    author: '王老师',
    created: '2024-09-01T08:00:00Z',
    app: 'Microsoft Office PowerPoint',
  });
});

test('extractPptx：幻灯片顺序按 presentation.xml.rels 的 r:id 顺序', () => {
  const buffer = makePptx({
    presentation: presentationXml(['rId2', 'rId3', 'rId4']),
    presentationRels: presentationRels([
      ['rId2', 'slides/slide10.xml'],
      ['rId3', 'slides/slide1.xml'],
      ['rId4', 'slides/slide2.xml'],
    ]),
    slides: {
      'ppt/slides/slide1.xml': slideXml({ titleRuns: '<a:r><a:t>第一讲</a:t></a:r>' }),
      'ppt/slides/slide2.xml': slideXml({ titleRuns: '<a:r><a:t>第二讲</a:t></a:r>' }),
      'ppt/slides/slide10.xml': slideXml({ titleRuns: '<a:r><a:t>第十讲</a:t></a:r>' }),
    },
  });

  const result = extractPptx(buffer);
  assert.deepEqual(result.slides.map((slide) => slide.title), ['第十讲', '第一讲', '第二讲']);
});

test('extractPptx：缺少 rels 时按数字顺序排序（slide10 不排在 slide2 前面）', () => {
  const buffer = zipFromParts({
    'ppt/presentation.xml': presentationXml(['rId2', 'rId3', 'rId4']),
    'ppt/slides/slide1.xml': slideXml({ titleRuns: '<a:r><a:t>第一讲</a:t></a:r>' }),
    'ppt/slides/slide2.xml': slideXml({ titleRuns: '<a:r><a:t>第二讲</a:t></a:r>' }),
    'ppt/slides/slide10.xml': slideXml({ titleRuns: '<a:r><a:t>第十讲</a:t></a:r>' }),
  });

  const result = extractPptx(buffer);
  assert.deepEqual(result.slides.map((slide) => slide.title), ['第一讲', '第二讲', '第十讲']);
  assert.equal(result.meta.title, undefined);
});

test('extractPptx：兼容不同命名空间前缀、单双引号属性、自闭合标签与实体', () => {
  const weirdSlide = `<?xml version='1.0' encoding='UTF-8'?>
<p:sld xmlns:p="${NS.p}" xmlns:r="${NS.od}" xmlns:x="${NS.a}">
<p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="标题"/><p:cNvSpPr/><p:nvPr><p:ph sz='quarter' type='title' idx='0'/></p:nvPr></p:nvSpPr>
<p:txBody><x:bodyPr/><x:p><x:r><x:t>第二讲 &quot;引号&quot; 与 &apos;撇号&apos;</x:t></x:r></x:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="3" name="正文"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:txBody><x:bodyPr/><x:p><x:r><x:t>第一行</x:t></x:r><x:br/><x:r><x:t>第二行</x:t></x:r></x:p><x:p/></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:cNvPr id="4" name="图片"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><x:blipFill/></p:spPr></p:sp>
</p:spTree></p:cSld></p:sld>`;

  const buffer = zipFromParts({ 'ppt/slides/slide1.xml': weirdSlide });
  const result = extractPptx(buffer);

  assert.equal(result.slideCount, 1);
  const slide = result.slides[0];
  assert.equal(slide.title, '第二讲 "引号" 与 \'撇号\'');
  // 只有标题与正文两个文本框有文字；空段落不产生多余条目
  assert.deepEqual(slide.texts, ['第二讲 "引号" 与 \'撇号\'', '第一行\n第二行']);
  assert.equal(slide.notes, '');
});

test('extractPptx：没有标题占位符时 title 为空字符串', () => {
  const slide = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="${NS.a}" xmlns:p="${NS.p}"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:cNvPr id="2" name="正文"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
<p:txBody><a:p><a:r><a:t>只有正文</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
  const result = extractPptx(zipFromParts({ 'ppt/slides/slide1.xml': slide }));
  assert.equal(result.slides[0].title, '');
  assert.deepEqual(result.slides[0].texts, ['只有正文']);
});

test('extractPptx：幻灯片里的表格不会崩，并按表格文本提取', () => {
  const slide = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="${NS.a}" xmlns:p="${NS.p}"><p:cSld><p:spTree>
<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="表格"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>
<a:tr><a:tc><a:txBody><a:p><a:r><a:t>列1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>列2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
<a:tr><a:tc><a:txBody><a:p><a:r><a:t>1</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>2</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>`;
  const result = extractPptx(zipFromParts({ 'ppt/slides/slide1.xml': slide }));
  assert.deepEqual(result.slides[0].texts, ['列1 | 列2\n1 | 2']);
});

test('extractPptx：乱码 zip 与结构不完整都抛中文错误', () => {
  assert.throws(() => extractPptx(Buffer.from('这不是一个 pptx 文件，只是普通文本')), /不是有效的 ZIP 文件/);
  assert.throws(
    () => extractPptx(zipFromParts({ 'word/document.xml': '<w:document/>' })),
    /PPTX 结构异常/,
  );
  assert.throws(
    () =>
      extractPptx(
        zipFromParts({ 'ppt/slides/slide1.xml': { data: '<x/>', crc32: 0x12345678 } }),
      ),
    /CRC32 校验失败/,
  );
});

/* ------------------------------ DOCX ------------------------------ */

/** 组装一个最小但结构完整的 docx */
function makeDocx(documentXml, extras = {}) {
  return zipFromParts({
    '[Content_Types].xml': `<Types xmlns="${NS.ct}"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${NS.od}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'docProps/core.xml': coreXml({ title: '第一章讲义', creator: '李老师', created: '2024-10-01T10:00:00Z' }),
    'word/document.xml': documentXml,
    ...extras,
  });
}

const DOCX_BODY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${NS.w}" xmlns:r="${NS.od}"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 集合</w:t></w:r></w:p>
<w:p><w:r><w:t>这是正文 &amp; 说明。</w:t><w:tab/><w:t>制表后</w:t><w:br/><w:t>换行后</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="heading 2"/></w:pPr><w:r><w:t>1.1 子标题</w:t></w:r></w:p>
<w:p><w:pPr><w:pStyle w:val="3"/></w:pPr><w:r><w:t>1.1.1 三级标题</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>有序项一</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>无序项</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:numId w:val="9"/></w:numPr></w:pPr><w:r><w:t>未知编号</w:t></w:r></w:p>
<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
<w:tr><w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:r><w:t>标题A</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:sdt><w:sdtPr><w:id w:val="1"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>SDT 里的段落</w:t></w:r></w:p></w:sdtContent></w:sdt>
<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>大纲级别标题</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">拼音测试 </w:t></w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>Pīn</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>注</w:t></w:r></w:rubyBase></w:ruby></w:p>
</w:body></w:document>`;

const DOCX_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${NS.w}">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#61548;"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

test('extractDocx：按文档顺序提取标题、段落、列表与表格', () => {
  const buffer = makeDocx(DOCX_BODY, { 'word/numbering.xml': DOCX_NUMBERING });
  const result = extractDocx(buffer);

  // 摘掉空段落，只看有内容的块
  const blocks = result.blocks;

  assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: '第一章 集合' });
  assert.deepEqual(blocks[1], { type: 'paragraph', text: '这是正文 & 说明。\t制表后\n换行后' });
  assert.deepEqual(blocks[2], { type: 'heading', level: 2, text: '1.1 子标题' });
  assert.deepEqual(blocks[3], { type: 'heading', level: 3, text: '1.1.1 三级标题' });
  assert.deepEqual(blocks[4], { type: 'listItem', text: '有序项一', ordered: true });
  assert.deepEqual(blocks[5], { type: 'listItem', text: '无序项', ordered: false });
  // 无法判断编号格式时默认 ordered: true
  assert.deepEqual(blocks[6], { type: 'listItem', text: '未知编号', ordered: true });

  const table = blocks.find((block) => block.type === 'table');
  assert.deepEqual(table.rows, [
    ['标题A', '合并', '合并'],
    ['1\n2', '', 'C'],
  ]);

  // 块顺序与文档顺序一致：表格在 sdt 之前，sdt 内容被就地展开
  assert.equal(blocks[7].type, 'table');
  assert.deepEqual(blocks[8], { type: 'paragraph', text: 'SDT 里的段落' });
  assert.deepEqual(blocks[9], { type: 'heading', level: 1, text: '大纲级别标题' });
  assert.deepEqual(blocks[10], { type: 'paragraph', text: '拼音测试 注' });
});

test('extractDocx：text 字段可用于全量检索，且元数据来自 docProps', () => {
  const result = extractDocx(makeDocx(DOCX_BODY, { 'word/numbering.xml': DOCX_NUMBERING }));
  assert.ok(result.text.includes('第一章 集合'));
  assert.ok(result.text.includes('这是正文 & 说明。\t制表后\n换行后'));
  assert.ok(result.text.includes('标题A\t合并\t合并'));
  assert.ok(result.text.includes('SDT 里的段落'));
  assert.deepEqual(result.meta, {
    title: '第一章讲义',
    author: '李老师',
    created: '2024-10-01T10:00:00Z',
  });
});

test('extractDocx：缺少 numbering.xml 时列表仍可提取（默认有序）', () => {
  const result = extractDocx(makeDocx(DOCX_BODY));
  const lists = result.blocks.filter((block) => block.type === 'listItem');
  assert.deepEqual(lists, [
    { type: 'listItem', text: '有序项一', ordered: true },
    { type: 'listItem', text: '无序项', ordered: true },
    { type: 'listItem', text: '未知编号', ordered: true },
  ]);
});

test('extractDocx：损坏或结构不完整时抛中文错误', () => {
  assert.throws(() => extractDocx(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), /不是有效的 ZIP 文件|ZIP/);
  assert.throws(() => extractDocx(zipFromParts({ 'ppt/slides/slide1.xml': '<x/>' })), /DOCX 结构异常/);
  assert.throws(
    () => extractDocx(zipFromParts({ 'word/document.xml': { data: '<w:document/>', size: 4096 } })),
    /大小校验失败/,
  );
});

test('extractDocx：嵌套表格不会崩，单元格内多段落以换行连接', () => {
  const withNestedTable = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${NS.w}"><w:body>
<w:tbl><w:tr><w:tc>
  <w:p><w:r><w:t>外层</w:t></w:r></w:p>
  <w:tbl><w:tr><w:tc><w:p><w:r><w:t>内层A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>内层B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:tc></w:tr></w:tbl>
</w:body></w:document>`;
  const result = extractDocx(makeDocx(withNestedTable));
  const table = result.blocks.find((block) => block.type === 'table');
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0][0], '外层\n内层A 内层B');
});

/* ------------------------------ XLSX ------------------------------ */

/** 组装一个最小但结构完整的 xlsx */
function makeXlsx(parts = {}) {
  return zipFromParts({
    '[Content_Types].xml': `<Types xmlns="${NS.ct}"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${NS.od}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'docProps/core.xml': coreXml({ title: '成绩表', creator: '张老师' }),
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="${NS.ss}" count="4" uniqueCount="4">
<si><t>姓名</t></si>
<si><t>语文</t></si>
<si><r><rPr><sz val="11"/></rPr><t>张</t></r><r><t>三</t></r></si>
<si><t>带 &amp; 符号</t></si>
</sst>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="${NS.ss}" xmlns:r="${NS.od}"><sheets>
<sheet name="成绩表" sheetId="1" r:id="rId1"/><sheet name="名单" sheetId="2" r:id="rId2"/>
</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${NS.rel}">
<Relationship Id="rId1" Type="${NS.od}/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="${NS.od}/worksheet" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="${NS.ss}"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>备注</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>95</v></c></row>
<row r="4"><c r="C4" t="str"><v>公式结果</v></c><c r="D4" t="b"><v>1</v></c></row>
<row><c><v>7</v></c></row>
</sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="${NS.ss}"><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c></row></sheetData></worksheet>`,
    ...parts,
  });
}

test('extractXlsx：共享字符串、inlineStr、数字与缺失单元格对齐', () => {
  const result = extractXlsx(makeXlsx());

  assert.deepEqual(result.sheets.map((sheet) => sheet.name), ['成绩表', '名单']);
  assert.deepEqual(result.sheets[0].rows, [
    ['姓名', '语文', '', '备注'],
    ['张三', '95', '', ''],
    ['', '', '', ''],
    ['', '', '公式结果', 'TRUE'],
    ['7', '', '', ''],
  ]);
  // rId2 用了绝对路径 Target（/xl/worksheets/sheet2.xml）
  assert.deepEqual(result.sheets[1].rows, [['带 & 符号']]);
  assert.deepEqual(result.meta, { title: '成绩表', author: '张老师' });
});

test('extractXlsx：共享字符串索引越界时留空，不抛错', () => {
  const result = extractXlsx(
    makeXlsx({
      'xl/worksheets/sheet2.xml': `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="${NS.ss}"><sheetData>
<row r="1"><c r="A1" t="s"><v>99</v></c><c r="B1" t="s"><v>abc</v></c><c r="C1" t="s"/></row>
</sheetData></worksheet>`,
    }),
  );
  assert.deepEqual(result.sheets[1].rows, [['', '', '']]);
});

test('extractXlsx：没有 workbook 清单时按工作表文件顺序退化', () => {
  const result = extractXlsx(
    makeXlsx({
      'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS.ss}"/>`,
    }),
  );
  assert.deepEqual(result.sheets.map((sheet) => sheet.name), ['sheet1', 'sheet2']);
  assert.equal(result.sheets[0].rows[0][0], '姓名');
});

test('extractXlsx：损坏或结构不完整时抛中文错误', () => {
  assert.throws(() => extractXlsx(Buffer.from('乱码乱码')), /不是有效的 ZIP 文件/);
  assert.throws(() => extractXlsx(zipFromParts({ 'docProps/core.xml': '<x/>' })), /XLSX 结构异常/);
});

test('extractXlsx：行号异常时抛中文错误而不是分配超大数组', () => {
  const buffer = makeXlsx({
    'xl/worksheets/sheet2.xml': `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="${NS.ss}"><sheetData><row r="999999999"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
  });
  assert.throws(() => extractXlsx(buffer), /行号 .* 超出合理范围/);
});

/* ------------------------------ 统一入口 ------------------------------ */

test('extractOffice：按扩展名分发，未知扩展名返回 null', () => {
  const pptx = makePptx({
    presentation: presentationXml(['rId2']),
    presentationRels: presentationRels([['rId2', 'slides/slide1.xml']]),
    slides: { 'ppt/slides/slide1.xml': slideXml({ titleRuns: '<a:r><a:t>分发测试</a:t></a:r>' }) },
  });
  const docx = makeDocx(DOCX_BODY, { 'word/numbering.xml': DOCX_NUMBERING });
  const xlsx = makeXlsx();

  assert.equal(extractOffice(pptx, '.pptx').slideCount, 1);
  assert.equal(extractOffice(pptx, '.PPTX').slides[0].title, '分发测试');
  assert.ok(Array.isArray(extractOffice(docx, 'docx').blocks));
  assert.equal(extractOffice(xlsx, '.xlsx').sheets.length, 2);

  assert.equal(extractOffice(pptx, '.pdf'), null);
  assert.equal(extractOffice(pptx, '.doc'), null);
  assert.equal(extractOffice(pptx, ''), null);
  assert.equal(extractOffice(pptx, undefined), null);

  // 底层错误不会被吞掉
  assert.throws(() => extractOffice(Buffer.from('不是 zip'), '.docx'), /不是有效的 ZIP 文件/);
});

test('extractOffice：deflate 与 stored 两种打包方式结果一致', () => {
  const slide = slideXml({
    titleRuns: '<a:r><a:t>压缩方式</a:t></a:r>',
    bodyParagraphs: ['<a:r><a:t>内容</a:t></a:r>'],
  });
  const parts = { 'ppt/slides/slide1.xml': slide };

  const deflated = buildZip(Object.entries(parts).map(([name, data]) => ({ name, data, method: 'deflate' })));
  const stored = buildZip(Object.entries(parts).map(([name, data]) => ({ name, data, method: 'store' })));

  assert.deepEqual(extractPptx(deflated), extractPptx(stored));
});
