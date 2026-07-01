// Original-book index extractor using pdf.js.
// Current target: Manning Publications two-column index pages.

document.getElementById('fileInput').addEventListener('change', handleFileSelect);

(function enableDragDrop() {
  const box = document.getElementById('fileInput');
  if (!box) return;

  box.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    box.style.borderStyle = 'solid';
  });
  box.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    box.style.borderStyle = 'dotted';
  });
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    box.style.borderStyle = 'dotted';
    const f = (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) || null;
    runPipelineForFile(f);
  });
})();

function handleFileSelect(e) {
  const f = e.target.files[0];
  if (!f) return;
  runPipelineForFile(f);
}

function runPipelineForFile(f) {
  if (!f) return;

  const fileReader = new FileReader();
  fileReader.readAsArrayBuffer(f);
  fileReader.onload = function() {
    runPipeline(new Uint8Array(this.result));
  };
}

async function runPipeline(typedArray) {
  const OUTPUT = document.getElementById('output');
  OUTPUT.textContent = '기다리라우...';
  logPut();

  try {
    const pdfjs = await waitForPdfJsLib();
    let pageBoxes = detectPdfBoxes(typedArray);
    pdfjs.GlobalWorkerOptions.workerSrc = 'pdfjs-5.4.530-dist/build/pdf.worker.mjs';
    const loadingTask = pdfjs.getDocument({ data: typedArray });
    const pdf = await loadingTask.promise;
    const labels = await readPageLabels(pdf);
    pageBoxes = await fillPageBoxFallback(pdf, pageBoxes);

    logPut('PDF 로드 완료. 전체 물리 페이지: ' + pdf.numPages);
    logPageBoxes(pageBoxes);
    logPageLabels(labels, pdf.numPages);

    const selectedPublisher = readPublisherSetting();
    const publisher = await detectPublisher(pdf, selectedPublisher);
    logPut('출판사: ' + publisher.label);
    if (publisher.key !== 'manning') {
      OUTPUT.textContent = '아직 Manning Publications만 지원함.';
      sendCapture('unsupported-publisher');
      return;
    }

    const tocRange = await findManningTocRange(pdf);
    if (!tocRange) {
      OUTPUT.textContent = '목차 페이지 범위를 못 찾았음.';
      sendCapture('toc-not-found');
      return;
    }
    logPut('목차 범위: 물리 ' + tocRange.start + '~' + tocRange.end + '쪽' + labelRangeSuffix(labels, tocRange.start, tocRange.end));

    let indexLogicalStart = await findIndexLogicalStartFromToc(pdf, tocRange.end);
    if (indexLogicalStart) {
      logPut('목차 마지막 페이지에서 찾은 인덱스 시작 논리 쪽수: ' + indexLogicalStart);
    } else {
      logPut('목차에서 인덱스 시작 쪽수를 못 찾아 역순 탐색으로 보정함.');
    }

    const manualRange = readManualIndexRange(pdf.numPages);
    const indexRange = manualRange || await findManningIndexRange(pdf, labels, indexLogicalStart);
    if (!indexRange) {
      OUTPUT.textContent = '인덱스 페이지 범위를 못 찾았음.';
      sendCapture('index-not-found');
      return;
    }
    logPut((manualRange ? '수동' : '자동') + ' 인덱스 범위: 물리 ' + indexRange.start + '~' + indexRange.end + '쪽' + labelRangeSuffix(labels, indexRange.start, indexRange.end));

    const xProfiles = await buildManningXProfiles(pdf, indexRange, pageBoxes, labels);
    logManningXProfiles(xProfiles);

    const lines = await extractManningIndex(pdf, indexRange, pageBoxes, labels, xProfiles);
    OUTPUT.textContent = lines.join('\n');
    logPut('완료! 추출 줄 수: ' + lines.length);
    sendCapture('ok');
  } catch (err) {
    OUTPUT.textContent = '오류: ' + (err && err.stack ? err.stack : String(err));
    sendCapture('error');
  }
}

function waitForPdfJsLib() {
  if (globalThis.pdfjsLib) return Promise.resolve(globalThis.pdfjsLib);

  return new Promise((resolve, reject) => {
    let tries = 0;
    const check = () => {
      if (globalThis.pdfjsLib) {
        resolve(globalThis.pdfjsLib);
        return;
      }
      tries++;
      if (tries >= 100) {
        reject(new Error('pdf.js를 로드하지 못했음. original_index_extract.html을 다시 열어봐.'));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function sendCapture(status) {
  const output = document.getElementById('output')?.textContent || '';
  const log = document.getElementById('log')?.value || '';
  fetch('/__capture', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status,
      href: window.location.href,
      output,
      log
    })
  }).catch(() => {});
}

function readPublisherSetting() {
  const el = document.getElementById('paramPublisher');
  return el ? el.value : 'auto';
}

function readManualIndexRange(totalPages) {
  const chk = document.getElementById('paramManualPages');
  if (!chk || !chk.checked) return null;

  const sRaw = document.getElementById('paramManualPagesStart')?.value;
  const eRaw = document.getElementById('paramManualPagesEnd')?.value;
  const start = parseInt(sRaw, 10);
  const end = parseInt(eRaw, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start || end > totalPages) {
    alert('인덱스 시작/끝 페이지가 이상함!');
    return null;
  }
  return { start, end };
}

async function readPageLabels(pdf) {
  try {
    if (typeof pdf.getPageLabels !== 'function') return null;
    const labels = await pdf.getPageLabels();
    return labels && labels.length ? labels : null;
  } catch (e) {
    return null;
  }
}

function logPageLabels(labels, totalPages) {
  if (!labels || !labels.length) {
    logPut('논리 쪽수: PDF PageLabels 없음. 필요하면 물리 쪽수로 보정함.');
    return;
  }

  const first = labels[0];
  const last = labels[labels.length - 1];
  const firstArabicIndex = labels.findIndex(x => /^\d+$/.test(String(x || '')));
  if (firstArabicIndex >= 0) {
    logPut('논리 쪽수: 물리 1쪽=' + first + ', 물리 ' + (firstArabicIndex + 1) + '쪽=' + labels[firstArabicIndex] + ', 물리 ' + totalPages + '쪽=' + last);
  } else {
    logPut('논리 쪽수: 물리 1쪽=' + first + ', 물리 ' + totalPages + '쪽=' + last);
  }
}

function labelRangeSuffix(labels, start, end) {
  if (!labels || !labels[start - 1] || !labels[end - 1]) return '';
  return ' (논리 ' + labels[start - 1] + '~' + labels[end - 1] + '쪽)';
}

function detectPdfBoxes(typedArray) {
  const raw = new TextDecoder('latin1').decode(typedArray);
  const mediaBox = extractMostCommonBox(raw, 'MediaBox');
  const cropBox = extractMostCommonBox(raw, 'CropBox');
  const trimBox = extractMostCommonBox(raw, 'TrimBox');
  const preferred = trimBox || cropBox || mediaBox || null;
  return { mediaBox, cropBox, trimBox, preferred };
}

async function fillPageBoxFallback(pdf, boxes) {
  if (boxes && boxes.preferred) return boxes;
  const page = await pdf.getPage(1);
  const view = page.view || null;
  if (!view) return boxes;
  const mediaBox = [view[0], view[1], view[2], view[3]];
  return {
    mediaBox,
    cropBox: null,
    trimBox: null,
    preferred: mediaBox,
    source: 'page.view'
  };
}

function extractMostCommonBox(raw, name) {
  const re = new RegExp('\\/' + name + '\\s*\\[\\s*([-+\\d.]+)\\s+([-+\\d.]+)\\s+([-+\\d.]+)\\s+([-+\\d.]+)\\s*\\]', 'g');
  const counts = new Map();
  let m;
  while ((m = re.exec(raw)) !== null) {
    const box = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
    if (!box.every(Number.isFinite)) continue;
    const key = box.map(n => String(Math.round(n * 1000) / 1000)).join(',');
    const prev = counts.get(key);
    if (prev) prev.count++;
    else counts.set(key, { box, count: 1 });
  }

  let best = null;
  for (const item of counts.values()) {
    if (!best || item.count > best.count) best = item;
  }
  return best ? best.box : null;
}

function logPageBoxes(boxes) {
  if (!boxes || !boxes.preferred) {
    logPut('판형: PDF 박스 정보를 못 읽음.');
    return;
  }

  if (boxes.trimBox) logPut('TrimBox 판형: ' + formatBoxMm(boxes.trimBox) + ' (재단선 기준)');
  else if (boxes.cropBox) logPut('판형: TrimBox 없음. CropBox 판형: ' + formatBoxMm(boxes.cropBox));
  else if (boxes.mediaBox) logPut('판형: TrimBox 없음. MediaBox 판형: ' + formatBoxMm(boxes.mediaBox));
  if (boxes.source === 'page.view') logPut('판형: PDF.js page.view 기준 사용.');
}

function formatBoxMm(box) {
  const width = (box[2] - box[0]) / 2.834645669;
  const height = (box[3] - box[1]) / 2.834645669;
  return round1(width) + ' * ' + round1(height) + 'mm';
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

async function detectPublisher(pdf, selected) {
  if (selected === 'manning') return { key: 'manning', label: 'Manning Publications (수동)' };

  const scanEnd = Math.min(pdf.numPages, 20);
  logPut('출판사 자동 탐색: 앞 ' + scanEnd + '쪽 판권지 문자열 검색 중...');
  for (let p = 1; p <= scanEnd; p++) {
    const text = await getPagePlainText(pdf, p);
    if (/Manning Publications Co\.\s+All rights reserved/i.test(text)) {
      return { key: 'manning', label: 'Manning Publications (자동, 물리 ' + p + '쪽)' };
    }
  }
  return { key: 'unknown', label: '알 수 없음' };
}

async function findManningTocRange(pdf) {
  const scanEnd = Math.min(pdf.numPages, 80);
  let start = null;
  let end = null;

  logPut('목차 탐색: 앞 ' + scanEnd + '쪽 상단 contents 검색 중...');
  for (let p = 1; p <= scanEnd; p++) {
    const page = await readPageLayout(pdf, p);
    if (start == null) {
      if (isLargePageTitle(page, 'contents')) {
        start = p;
        end = p;
        logPut('목차 시작 후보: 물리 ' + p + '쪽');
      }
      continue;
    }

    if (hasTopHeader(page, 'contents')) {
      end = p;
    } else if (start != null) {
      break;
    }
  }

  if (start == null || end == null) return null;
  return { start, end };
}

async function findIndexLogicalStartFromToc(pdf, tocEndPage) {
  const page = await readPageLayout(pdf, tocEndPage);
  const matches = [];
  for (const line of page.lines) {
    const m = line.text.match(/\bindex\s+(\d{1,5})\b/i);
    if (m) matches.push(parseInt(m[1], 10));
  }
  return matches.length ? matches[matches.length - 1] : null;
}

async function findManningIndexRange(pdf, labels, indexLogicalStart) {
  let start = null;

  if (indexLogicalStart && labels) {
    const idx = labels.findIndex(x => String(x) === String(indexLogicalStart));
    if (idx >= 0) {
      const candidate = idx + 1;
      const page = await readPageLayout(pdf, candidate);
      if (hasTopHeader(page, 'index') || isLargePageTitle(page, 'index')) {
        start = candidate;
        logPut('PageLabels로 인덱스 시작 물리 페이지 확인: ' + start);
      } else {
        logPut('PageLabels 후보 물리 ' + candidate + '쪽 상단에서 index를 확인하지 못함.');
      }
    }
  }

  if (start == null) {
    logPut('인덱스 시작 역순 탐색 중...');
    for (let p = pdf.numPages; p >= 1; p--) {
      const page = await readPageLayout(pdf, p);
      if (hasTopHeader(page, 'index')) {
        start = p;
      } else if (start != null) {
        break;
      }
    }
  }

  if (start == null) return null;

  let end = start;
  for (let p = start; p <= pdf.numPages; p++) {
    const page = await readPageLayout(pdf, p);
    const isIndexPage = hasTopHeader(page, 'index') || (p === start && isLargePageTitle(page, 'index'));
    if (!isIndexPage) {
      if (p === start) return null;
      break;
    }
    end = p;
  }

  return { start, end };
}

async function getPagePlainText(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const tc = await page.getTextContent();
  return tc.items.map(it => it.str || '').join(' ');
}

async function readPageLayout(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const tc = await page.getTextContent();
  const items = [];

  for (const it of tc.items) {
    const str = it.str || '';
    if (!str.trim()) continue;
    items.push({
      str,
      x: it.transform[4],
      y: it.transform[5],
      width: it.width || 0,
      height: it.height || 0,
      fontName: it.fontName || ''
    });
  }

  const view = page.view || [0, 0, 0, 0];
  return {
    pageNum,
    width: view[2] - view[0],
    height: view[3] - view[1],
    view,
    items,
    lines: groupItemsIntoLines(items, view[2] - view[0])
  };
}

function groupItemsIntoLines(items, pageWidth) {
  const buckets = [];
  const THRESHOLD_Y = 2.4;

  for (const item of items) {
    let bucket = null;
    for (const b of buckets) {
      if (Math.abs(b.y - item.y) <= THRESHOLD_Y) {
        bucket = b;
        break;
      }
    }
    if (!bucket) {
      bucket = { y: item.y, parts: [] };
      buckets.push(bucket);
    }
    bucket.parts.push(item);
  }

  buckets.sort((a, b) => b.y - a.y);
  const lines = [];
  for (const bucket of buckets) {
    lines.push.apply(lines, makeLinesFromBucket(bucket.parts, bucket.y, pageWidth));
  }
  return lines;
}

function makeLinesFromBucket(parts, y, pageWidth) {
  const sorted = parts.slice().sort((a, b) => a.x - b.x);
  const groups = [];
  let cur = [];
  let prevRight = null;
  const midpoint = pageWidth / 2;

  for (const part of sorted) {
    const gap = prevRight == null ? 0 : part.x - prevRight;
    const crossesColumnGutter = cur.length && cur[0].x < midpoint && part.x >= midpoint;
    if (cur.length && (gap > 24 || crossesColumnGutter)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(part);
    prevRight = part.x + (part.width || 0);
  }
  if (cur.length) groups.push(cur);

  return groups.map(group => makeLine(group, y));
}

function makeLine(parts, y) {
  const sorted = parts.slice().sort((a, b) => a.x - b.x);
  let text = '';
  let prevRight = null;
  for (const part of sorted) {
    const gap = prevRight == null ? 0 : part.x - prevRight;
    if (text && gap > 1.5) text += ' ';
    text += part.str;
    prevRight = part.x + (part.width || 0);
  }
  text = text.replace(/\s+/g, ' ').trim();
  const minX = Math.min.apply(null, sorted.map(p => p.x));
  const maxX = Math.max.apply(null, sorted.map(p => p.x + (p.width || 0)));
  return { text, x: minX, y, maxX, parts: sorted };
}

function hasTopHeader(page, word) {
  const needle = String(word || '').toLowerCase();
  const topCut = page.height * 0.78;
  if (page.items.some(item => {
    const t = String(item.str || '').trim().toLowerCase();
    return item.y >= topCut && t === needle;
  })) {
    return true;
  }

  return page.lines.some(line => {
    const t = line.text.trim().toLowerCase();
    return line.y >= topCut && (t === needle || t.indexOf(needle) >= 0);
  });
}

function isLargePageTitle(page, word) {
  const needle = String(word || '').toLowerCase();
  return page.items.some(item => {
    const t = String(item.str || '').trim().toLowerCase();
    return t === needle && item.height >= 18;
  });
}

async function extractManningIndex(pdf, range, pageBoxes, labels, xProfiles) {
  const rows = [];

  for (let p = range.start; p <= range.end; p++) {
    logPut('인덱스 추출 중: 물리 ' + p + '쪽');
    const page = await readPageLayout(pdf, p);
    const parity = getPageParity(p, labels);
    const pageRows = extractManningPageRows(page, pageBoxes, xProfiles[parity]);
    logPut('  행 후보 ' + pageRows.rawCount + '개, 항목 ' + pageRows.rows.length + '개');
    rows.push.apply(rows, pageRows.rows);
  }

  return rows.map(row => {
    const prefix = row.level === 2 ? '__ ' : row.level === 3 ? '____ ' : '';
    if (!row.pages) return prefix + row.title;
    return prefix + row.title + ' ||| ' + row.pages;
  });
}

function extractManningPageRows(page, pageBoxes, xProfile) {
  const usable = trimToPreferredBox(page.lines, pageBoxes);
  const contentLines = usable.filter(line => !isManningIndexNoise(line, page));
  const columns = splitIntoColumns(contentLines, page.width);
  const rows = [];

  for (const col of columns) {
    const rawRows = [];
    for (const line of col.lines) {
      const parsed = parseIndexLine(line, col.left, xProfile);
      if (parsed) rawRows.push(parsed);
    }
    rows.push.apply(rows, mergeWrappedRows(rawRows, xProfile));
  }

  return {
    rawCount: contentLines.length,
    rows
  };
}

function trimToPreferredBox(lines, pageBoxes) {
  const box = pageBoxes && pageBoxes.trimBox;
  if (!box) return lines;
  return lines.filter(line => line.y >= box[1] && line.y <= box[3] && line.x >= box[0] && line.x <= box[2]);
}

function splitIntoColumns(lines, pageWidth) {
  const midpoint = pageWidth / 2;
  const leftLines = [];
  const rightLines = [];

  for (const line of lines) {
    if (line.x < midpoint) leftLines.push(line);
    else rightLines.push(line);
  }

  const makeColumn = (colLines) => {
    colLines.sort((a, b) => b.y - a.y);
    const left = inferColumnLeft(colLines);
    return { left, lines: colLines };
  };

  return [makeColumn(leftLines), makeColumn(rightLines)];
}

async function buildManningXProfiles(pdf, range, pageBoxes, labels) {
  const samples = { odd: [], even: [] };

  for (let p = range.start; p <= range.end; p++) {
    const page = await readPageLayout(pdf, p);
    const usable = trimToPreferredBox(page.lines, pageBoxes);
    const contentLines = usable.filter(line => !isManningIndexNoise(line, page));
    const midpoint = page.width / 2;

    for (const line of contentLines) {
      if (line.x >= midpoint) continue;
      const parity = getPageParity(p, labels);
      samples[parity].push(Math.round(line.x));
    }
  }

  return {
    odd: buildSingleParityProfile(samples.odd),
    even: buildSingleParityProfile(samples.even)
  };
}

function buildSingleParityProfile(xs) {
  const base = findModeInRange(xs, -Infinity, Infinity);
  const level2 = findModeInRange(xs, base + 4, base + 14) ?? (base + 9);
  const level3 = findModeInRange(xs, base + 14, base + 24) ?? (level2 + 9);
  const continuation = findModeInRange(xs, base + 24, base + 40) ?? (level3 + 12);

  return {
    abs: {
      level1: base,
      level2,
      level3,
      continuation
    },
    rel: {
      level1: 0,
      level2: level2 - base,
      level3: level3 - base,
      continuation: continuation - base
    }
  };
}

function findModeInRange(xs, minExclusive, maxInclusive) {
  const counts = new Map();
  for (const x of xs) {
    if (!(x > minExclusive && x <= maxInclusive)) continue;
    counts.set(x, (counts.get(x) || 0) + 1);
  }
  let bestX = null;
  let bestCount = -1;
  for (const [x, count] of counts.entries()) {
    if (count > bestCount || (count === bestCount && x < bestX)) {
      bestX = x;
      bestCount = count;
    }
  }
  return bestX;
}

function logManningXProfiles(profiles) {
  logSingleProfile('홀수 페이지', profiles.odd);
  logSingleProfile('짝수 페이지', profiles.even);
}

function logSingleProfile(label, profile) {
  if (!profile || !profile.abs) return;
  logPut(
    label + ' 1/2/3/이어짐 x 위치: ' +
    profile.abs.level1 + ', ' +
    profile.abs.level2 + ', ' +
    profile.abs.level3 + ', ' +
    profile.abs.continuation
  );
}

function getPageParity(pageNum, labels) {
  const logical = labels && labels[pageNum - 1] ? pageLabelToNumber(labels[pageNum - 1]) : null;
  const basis = logical != null ? logical : pageNum;
  return basis % 2 ? 'odd' : 'even';
}

function pageLabelToNumber(label) {
  const raw = String(label || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^[ivxlcdm]+$/i.test(raw)) return romanToInt(raw);
  return null;
}

function romanToInt(raw) {
  const map = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const s = String(raw || '').toLowerCase();
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = map[s[i]] || 0;
    const next = map[s[i + 1]] || 0;
    total += cur < next ? -cur : cur;
  }
  return total || null;
}

function inferColumnLeft(lines) {
  const xs = lines
    .map(line => Math.round(line.x))
    .filter(x => Number.isFinite(x));
  if (!xs.length) return 0;
  return Math.min.apply(null, xs);
}

function isManningIndexNoise(line, page) {
  const text = line.text.trim();
  if (!text) return true;
  if (/^\d+$/.test(text) && line.y > page.height * 0.92) return true;
  if (/^index$/i.test(text) && line.y > page.height * 0.78) return true;
  if (/^index$/i.test(text) && line.parts.some(part => part.height >= 18)) return true;
  if (/^(numbers|symbols)$/i.test(text)) return true;
  if (/^[A-Z]$/.test(text)) return true;
  return false;
}

function parseIndexLine(line, columnLeft, xProfile) {
  const text = line.text.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const pageRefs = '(?:\\d+)(?:\\s*(?:,|[-–—])\\s*(?:\\d+))*\\s*(?:,|[-–—])?';
  const pageOnly = new RegExp('^' + pageRefs + '$').test(text);
  const indent = line.x - columnLeft;
  const role = classifyLineRole(indent, xProfile);
  const level = role === 'level1' ? 1 : role === 'level2' ? 2 : 3;

  if (pageOnly) {
    return {
      title: '',
      pages: cleanupPages(text),
      level,
      indent,
      y: line.y,
      role,
      wrapped: true,
      pageOnly: true
    };
  }

  const match = text.match(new RegExp('^(.*?)(?:\\s+)(' + pageRefs + ')$'));

  if (!match) {
    return {
      title: text,
      pages: '',
      level,
      indent,
      y: line.y,
      role,
      wrapped: true,
      pagesOpen: false,
      pageOnly: false
    };
  }

  return {
    title: cleanupIndexTitle(match[1]),
    pages: cleanupPages(match[2]),
    level,
    indent,
    y: line.y,
    role,
    wrapped: false,
    pagesOpen: /(?:,|[-–—])\s*$/.test(match[2]),
    pageOnly: false
  };
}

function classifyLineRole(indent, xProfile) {
  if (!xProfile || !xProfile.rel) {
    if (indent < 7) return 'level1';
    if (indent < 15) return 'level2';
    if (indent < 24) return 'level3';
    return 'continuation';
  }

  const rel = xProfile.rel;
  const values = [
    ['level1', rel.level1],
    ['level2', rel.level2],
    ['level3', rel.level3],
    ['continuation', rel.continuation]
  ];

  let best = values[0][0];
  let bestDist = Math.abs(indent - values[0][1]);
  for (let i = 1; i < values.length; i++) {
    const dist = Math.abs(indent - values[i][1]);
    if (dist < bestDist) {
      best = values[i][0];
      bestDist = dist;
    }
  }
  return best;
}

function mergeWrappedRows(rows, xProfile) {
  const out = [];
  let pending = null;
  let lastPaged = null;

  for (const row of rows) {
    if (row.pageOnly) {
      if (pending) {
        const merged = {
          title: cleanupIndexTitle(pending.title),
          pages: row.pages,
          level: pending.level
        };
        out.push(merged);
        lastPaged = merged;
        pending = null;
      } else if (lastPaged && shouldAppendPageContinuation(lastPaged, row, xProfile)) {
        lastPaged.pages = appendPageContinuation(lastPaged.pages, row.pages);
        lastPaged.pagesOpen = false;
      }
      continue;
    }

    if (!row.pages) {
      if (pending) {
        if (isContinuationRow(pending, row, xProfile)) {
          pending.title = joinIndexTitleParts(pending.title, row.title);
          pending.y = row.y;
          pending.indent = row.indent;
          pending.role = row.role;
        } else {
          const flushed = {
            title: cleanupIndexTitle(pending.title),
            pages: pending.pages || '',
            level: pending.level
          };
          out.push(flushed);
          if (flushed.pages) lastPaged = flushed;
          pending = { ...row };
        }
      } else {
        pending = { ...row };
      }
      continue;
    }

    if (pending) {
      if (isContinuationRow(pending, row, xProfile)) {
        const merged = {
          title: joinIndexTitleParts(pending.title, row.title),
          pages: row.pages,
          level: pending.level
        };
        out.push(merged);
        lastPaged = merged;
      } else {
        const flushed = {
          title: cleanupIndexTitle(pending.title),
          pages: '',
          level: pending.level
        };
        out.push(flushed);
        out.push(row);
        lastPaged = row;
      }
      pending = null;
      continue;
    }

    out.push(row);
    lastPaged = row;
  }

  if (pending) {
    out.push({
      title: cleanupIndexTitle(pending.title),
      pages: pending.pages || '',
      level: pending.level
    });
  }

  return out.filter(row => row.title);
}

function isContinuationRow(prev, row, xProfile) {
  if (!prev || !row) return false;
  const dy = Math.abs((prev.y || 0) - (row.y || 0));
  return dy <= 13.2 && row.role === 'continuation';
}

function shouldAppendPageContinuation(prev, row, xProfile) {
  if (!prev || !row) return false;
  if (prev.pagesOpen) return true;
  const dy = Math.abs((prev.y || 0) - (row.y || 0));
  const continuationIndent = xProfile && xProfile.rel ? xProfile.rel.continuation : 24;
  return dy <= 13.2 && row.indent >= (continuationIndent - 3);
}

function appendPageContinuation(left, right) {
  const a = cleanupPages(left);
  const b = cleanupPages(right);
  if (!a) return b;
  if (!b) return a;
  if (/[-–—]$/.test(a)) return cleanupPages(a + b);
  return cleanupPages(a + ', ' + b);
}

function joinIndexTitleParts(left, right) {
  const a = cleanupIndexTitle(left);
  const b = cleanupIndexTitle(right);
  if (!a) return b;
  if (!b) return a;

  const leftWords = a.split(' ');
  const rightWords = b.split(' ');
  const maxOverlap = Math.min(leftWords.length, rightWords.length);
  for (let n = maxOverlap; n >= 1; n--) {
    const leftTail = leftWords.slice(leftWords.length - n).join(' ').toLowerCase();
    const rightHead = rightWords.slice(0, n).join(' ').toLowerCase();
    if (leftTail === rightHead) {
      return cleanupIndexTitle(leftWords.concat(rightWords.slice(n)).join(' '));
    }
  }

  return cleanupIndexTitle(a + ' ' + b);
}

function cleanupIndexTitle(title) {
  return String(title || '')
    .replace(/\u00ad/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanupPages(pages) {
  return String(pages || '')
    .replace(/\s+/g, ' ')
    .replace(/,\s*/g, ', ')
    .replace(/,\s*$/, '')
    .trim();
}

function logPut(str) {
  const log = document.getElementById('log');
  if (!log) return;

  if (str === undefined) {
    log.value = '';
  } else {
    log.value += str + '\n';
  }
  log.scrollTop = log.scrollHeight;
}
