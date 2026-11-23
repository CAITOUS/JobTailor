// Dependency-free .docx writer: builds the WordprocessingML parts and stores
// them in an uncompressed zip. Contact links are real hyperlinks; the print
// version adds QR codes for the LinkedIn and portfolio URLs.

import { qrPng } from './qr.js';

const enc = new TextEncoder();

// ---------- zip (store method) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = content instanceof Uint8Array ? content : enc.encode(content);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true);
    cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const parts = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// ---------- WordprocessingML ----------
// Letter page, 0.7" margins → 10224 twips of text width.
const PAGE_W = 12240, MARGIN = 1008, TEXT_W = PAGE_W - 2 * MARGIN;
const ACCENT = '2F3A4F';

const esc = (s) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function run(text, { b, i, size, color, caps } = {}) {
  const pr = [
    b && '<w:b/>', i && '<w:i/>', caps && '<w:caps/>',
    color && `<w:color w:val="${color}"/>`,
    size && `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
  ].filter(Boolean).join('');
  // Split on tabs so a "\t" in text becomes a real tab.
  return String(text ?? '').split('\t').map((seg, idx) =>
    (idx ? `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:tab/></w:r>` : '') +
    (seg ? `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(seg)}</w:t></w:r>` : '')
  ).join('');
}

function para(runs, { align, before = 0, after = 60, tabs, indent, border, keepNext, line } = {}) {
  const pr = [
    keepNext && '<w:keepNext/>',
    border && `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="${ACCENT}"/></w:pBdr>`,
    tabs && `<w:tabs>${tabs.map((t) => `<w:tab w:val="${t.val}" w:pos="${t.pos}"/>`).join('')}</w:tabs>`,
    `<w:spacing w:before="${before}" w:after="${after}"${line ? ` w:line="${line}" w:lineRule="auto"` : ''}/>`,
    indent && `<w:ind w:left="${indent.left}" w:hanging="${indent.hanging}"/>`,
    align && `<w:jc w:val="${align}"/>`,
  ].filter(Boolean).join('');
  return `<w:p><w:pPr>${pr}</w:pPr>${Array.isArray(runs) ? runs.join('') : runs}</w:p>`;
}

const RIGHT_TAB = [{ val: 'right', pos: TEXT_W }];

function heading(text) {
  return para(run(text, { b: true, size: 21, color: ACCENT, caps: true }), { before: 160, after: 60, border: true, keepNext: true });
}
function bullet(text) {
  return para(run(`•\t${text}`), { indent: { left: 302, hanging: 216 }, tabs: [{ val: 'left', pos: 302 }], after: 30 });
}

// Collects the relationships (hyperlinks, images) and media a document needs.
function newDoc() {
  const rels = [];
  const media = [];
  return {
    rels, media,
    link(url) {
      const id = `rId${rels.length + 10}`;
      rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(url)}" TargetMode="External"/>`);
      return id;
    },
    image(bytes) {
      const id = `rId${rels.length + 10}`;
      const name = `image${media.length + 1}.png`;
      media.push([`word/media/${name}`, bytes]);
      rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
      return { id, n: media.length };
    },
  };
}

const LINK_COLOR = '1F4E79';
// The visible text is the URL itself (without https:// or www.), so applicant
// tracking systems, which read text and ignore link targets, still get it.
const displayUrl = (u) => String(u).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
const fullUrl = (u) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);

function hyperlink(doc, url, text, size) {
  const id = doc.link(url);
  const pr = `<w:rPr><w:color w:val="${LINK_COLOR}"/><w:u w:val="single"/>${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}</w:rPr>`;
  return `<w:hyperlink r:id="${id}" w:history="1"><w:r>${pr}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:hyperlink>`;
}

// Two lines: email | phone | location, then the web links, so long URLs never wrap mid-address.
function contactLines(doc, profile, size) {
  const join = (parts) => parts.flatMap((p, i) => (i ? [run('  |  ', { size }), p] : [p]));
  const first = [];
  if (profile.email) first.push(hyperlink(doc, `mailto:${profile.email}`, profile.email, size));
  if (profile.phone) first.push(run(profile.phone, { size }));
  if (profile.location) first.push(run(profile.location, { size }));
  const second = [profile.linkedin, profile.website].filter(Boolean).map((u) => hyperlink(doc, fullUrl(u), displayUrl(u), size));
  return [join(first), join(second)].filter((l) => l.length);
}

// Inline (not floating) picture, so it sits in the text flow.
function picture(doc, bytes, inches, descr) {
  const { id, n } = doc.image(bytes);
  const emu = Math.round(inches * 914400);
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${emu}" cy="${emu}"/><wp:docPr id="${n}" name="QR code ${n}" descr="${esc(descr)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="qr${n}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu}" cy="${emu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

// A borderless row of QR codes with captions, centered, for printed copies.
function qrRow(doc, items) {
  const cellW = 1700;
  const none = '<w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>';
  const cells = items.map(({ url, label }) =>
    `<w:tc><w:tcPr><w:tcW w:w="${cellW}" w:type="dxa"/></w:tcPr>${
      para(picture(doc, qrPng(url, 10), 0.8, `QR code: ${label}, ${url}`), { align: 'center', after: 0 })
    }${para(run(label, { size: 16, color: ACCENT }), { align: 'center', after: 0 })}</w:tc>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${cellW * items.length}" w:type="dxa"/><w:jc w:val="center"/><w:tblBorders>${none}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${items.map(() => `<w:gridCol w:w="${cellW}"/>`).join('')}</w:tblGrid><w:tr>${cells}</w:tr></w:tbl>`;
}

function documentXml(body) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>${body}<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="15840"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="432" w:footer="432" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`;

function packageDocx(body, title, doc) {
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${doc.rels.join('\n')}
</Relationships>`],
    ['word/styles.xml', STYLES],
    ['word/document.xml', documentXml(body)],
    ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title><dc:creator>${esc(title.split(' - ')[0])}</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created>
</cp:coreProperties>`],
    ...doc.media,
  ];
  return zip(files);
}

// ---------- public builders ----------
// opts.qr: add QR codes for the LinkedIn and portfolio URLs (for printed copies;
// leave them off versions you upload to an applicant tracking system).
export function buildResumeDocx(profile, r, opts = {}) {
  const doc = newDoc();
  const out = [];
  out.push(para(run(profile.fullName || 'Your Name', { b: true, size: 34, color: ACCENT }), { align: 'center', after: 20 }));
  const lines = contactLines(doc, profile, 18);
  lines.forEach((l, i) => out.push(para(l, { align: 'center', after: i === lines.length - 1 ? 40 : 0 })));
  if (r.headline) out.push(para(run(r.headline, { b: true, size: 21 }), { align: 'center', after: 80 }));
  if (opts.qr) {
    const items = [
      profile.website && { url: fullUrl(profile.website), label: 'Portfolio' },
      profile.linkedin && { url: fullUrl(profile.linkedin), label: 'LinkedIn' },
    ].filter(Boolean);
    if (items.length) out.push(qrRow(doc, items), para('', { after: 40 }));
  }

  if (r.summary) {
    out.push(heading('Summary'));
    out.push(para(run(r.summary), { after: 40 }));
  }
  if (r.skills && r.skills.length) {
    out.push(heading('Core Skills'));
    for (const g of r.skills) {
      out.push(para([run(`${g.label}: `, { b: true }), run(g.items.join(' · '))], { after: 30 }));
    }
  }
  if (r.experience && r.experience.length) {
    out.push(heading('Experience'));
    for (const job of r.experience) {
      out.push(para(
        [run(job.title, { b: true }), run(`  |  ${job.company}`), run(`\t${job.dates}`, { b: true })],
        { tabs: RIGHT_TAB, before: 100, after: 0, keepNext: true },
      ));
      if (job.location) out.push(para(run(job.location, { i: true, size: 19 }), { after: 30, keepNext: true }));
      for (const b of job.bullets) out.push(bullet(b));
    }
  }
  if (r.education && r.education.length) {
    out.push(heading('Education'));
    for (const e of r.education) {
      out.push(para([run(e.credential, { b: true }), run(e.school ? `  |  ${e.school}` : ''), run(e.dates ? `\t${e.dates}` : '')], { tabs: RIGHT_TAB, after: 30 }));
    }
  }
  if (r.certifications && r.certifications.length) {
    out.push(heading('Certifications'));
    for (const c of r.certifications) out.push(bullet(c));
  }
  return packageDocx(out.join(''), `${profile.fullName || 'Resume'} - Resume`, doc);
}

export function buildCoverLetterDocx(profile, letter) {
  const doc = newDoc();
  const out = [];
  out.push(para(run(profile.fullName || 'Your Name', { b: true, size: 30, color: ACCENT }), { after: 20 }));
  const lines = contactLines(doc, profile, 18);
  lines.forEach((l, i) => out.push(i === lines.length - 1 ? para(l, { after: 120, border: true }) : para(l, { after: 0 })));
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  out.push(para(run(date), { before: 200, after: 200 }));
  out.push(para(run(letter.greeting), { after: 160 }));
  for (const p of letter.paragraphs) out.push(para(run(p), { after: 160, line: 264 }));
  out.push(para(run(letter.closing || 'Sincerely,'), { before: 80, after: 360 }));
  out.push(para(run(profile.fullName || ''), { after: 0 }));
  return packageDocx(out.join(''), `${profile.fullName || 'Cover Letter'} - Cover Letter`, doc);
}

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
