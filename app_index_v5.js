// Index builder (PDF -> terms -> pages) using pdf.js
// - Keeps the existing UI/IDs from index.html
// - Output format (typeset friendly): "<term>    <pages>"
// - Terms are auto-extracted primarily from TOC, with a conservative "tech token" supplement from body.

document.getElementById('fileInput').addEventListener('change', handleFileSelect);

// Optional: drag and drop onto the dotted file input area
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
    const typedArray = new Uint8Array(this.result);
    runPipeline(typedArray);
  };
}

const DEFAULT_SETTINGS = {
  maxPagesToScan: 2000,
  maxTocScanPages: 60,
  tocEndMark: "찾아보기",
  dropExact: new Set(["CHAPTER", "개요", "요약"]),
  onePagePerChapter: true
};

async function runPipeline(typedArray) {
  const settings = readSettings();
  const OUTPUT = document.getElementById('output');
  OUTPUT.innerHTML = "기다리라우...";
  logPut(); // clear log

  // worker 설정
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs-5.4.530-dist/build/pdf.worker.mjs';
  const loadingTask = pdfjsLib.getDocument({ data: typedArray });

  try {
    const pdf = await loadingTask.promise;
    const totalPages = Math.min(pdf.numPages, settings.maxPagesToScan);
    logPut("PDF 로드 완료. 전체 페이지: " + pdf.numPages + " (이번 실행 스캔: " + totalPages + ")");

    const textCache = createPageTextCache(pdf, totalPages);

    // 1) Identify TOC page range
    const [tocStart, tocEnd] = await findTocRange(textCache, totalPages, settings);
    if (tocStart === null) {
      OUTPUT.innerHTML = "목차(차례) 페이지를 찾지 못했음. 오른쪽에서 수동 지정(목차 페이지 수동 지정) 체크 후 재시도 ㄱㄱ.";
      return;
    }
    logPut("목차 페이지 범위: " + (tocStart + 1) + "~" + (tocEnd + 1) + " (0-index 내부)");

    // 2) Parse TOC (level 1 + level 2)
    const tocItems = await parseTocLevel1And2(pdf, tocStart, tocEnd);
    const level1 = tocItems.filter(x => x.level === 1);
    const level2 = tocItems.filter(x => x.level === 2);

    if (level2.length === 0) {
      OUTPUT.innerHTML = "2단계 목차(1.1 같은 것)를 파싱하지 못했음. 로그를 확인해 주세요.";
      return;
    }
    logPut("목차 파싱: 1단계 " + level1.length + "개, 2단계 " + level2.length + "개");

    const pageTexts = await textCache.loadAll();

    // 3) Build chapter ranges (book pages, not physical pages)
    const chapterRanges = buildChapterRanges(level1, level2, settings.rangeMode);

    // Determine chapter count used for capping pages per term (defaults to parsed chapters).
    const manualChapterCount = getChapterCountOverride();
    let chapterCount = (chapterRanges && chapterRanges.length) ? chapterRanges.length : 0;
    if (manualChapterCount != null) {
      chapterCount = manualChapterCount;
      logPut("챕터 수 수동 지정 사용: " + chapterCount);
    } else {
      logPut("챕터 수 자동 감지 사용: " + chapterCount);
      const chk = document.getElementById('paramManualChapters');
      if (chk && chk.checked) {
        logPut("경고: 챕터 수 수동 지정이 체크되어 있으나 값이 올바르지 않아 자동 감지를 사용함");
      }
    }
    // 4) Build physical->book page mapping.
    const pageMapResult = await buildPhysicalToBookMap(pdf, totalPages, pageTexts, level1, level2, tocEnd);
    const physicalToBook = pageMapResult.physicalToBook;
    logPageMapSummary(pageMapResult);

    // 5) Extract seed terms from TOC titles (level 2 titles)
    const tocTerms = extractTermsFromTocTitles(level2, settings.dropExact);
    logPut("TOC 기반 시드 용어: " + tocTerms.length + "개");

    // 6) Extract conservative tech tokens from body (English-like tokens only)
    const techTerms = extractTechTokensFromBody(pageTexts, totalPages, physicalToBook, settings.dropExact);
    logPut("본문 기반 영문 기술 토큰: " + techTerms.length + "개");

    // 국문(영문) / 영문(국문) 패턴
    const parenKoreanTerms = extractKoreanFromParentheticalPairs(pageTexts, totalPages, physicalToBook, settings.dropExact);

    // 7) Merge terms, dedupe
    const allTerms = dedupeTerms(tocTerms.concat(techTerms).concat(parenKoreanTerms), settings.dropExact);
    logPut("최종 용어 후보(중복 등 제거 후): " + allTerms.length + "개");

    // terms 생성/정제 끝난 직후
    const terms = allTerms.filter(t => isUsefulTerm(t, settings.dropExact));
    logPut("최종 용어 후보(2차 조사 제거 후): " + terms.length + "개");

    // 8) Page matching (exact contains) and compress to earliest per chapter
    const indexLines = buildIndexLines(pageTexts, totalPages, terms, physicalToBook, chapterRanges, {
      maxPagesPerTerm: (chapterCount > 0 ? chapterCount : 11),
      onePagePerChapter: settings.onePagePerChapter
    });

    // 9) Render output (typeset friendly)
    indexLines.sort((a, b) => {
      const ta = a.split("    ")[0];
      const tb = b.split("    ")[0];
      return indexSortComparator(ta, tb);
    });
    OUTPUT.textContent = indexLines.join("\n");
    logPut("완료! 결과 줄 수: " + indexLines.length);
    logPut("팁: '결과 전체 복사' 버튼으로 전체 복사 가능");
  } catch (err) {
    OUTPUT.textContent = "오류: " + String(err);
  }
}

// -----------------------------
// Pipeline helpers
// -----------------------------

function readSettings() {
  return {
    ...DEFAULT_SETTINGS,
    rangeMode: document.getElementById("paramUseTwoLevel")?.checked ? "section" : "chapter"
  };
}

function createPageTextCache(pdf, totalPages) {
  const pageTexts = new Array(totalPages + 1);

  return {
    async get(pageNum1) {
      if (pageTexts[pageNum1] == null) {
        pageTexts[pageNum1] = await getPageText(pdf, pageNum1);
      }
      return pageTexts[pageNum1];
    },

    async loadAll() {
      logPut("본문 텍스트 캐시 생성 중...");
      for (let p = 1; p <= totalPages; p++) {
        if (pageTexts[p] == null) pageTexts[p] = await getPageText(pdf, p);
        if (p % 25 === 0) logPut("... " + p + "쪽 캐시 완료");
      }
      logPut("본문 텍스트 캐시 완료.");
      return pageTexts;
    }
  };
}

function indexSortComparator(a, b) {
    const ta = a.term || a;
    const tb = b.term || b;

    const ca = termCategory(ta);
    const cb = termCategory(tb);

    // 1) 카테고리 우선
    if (ca !== cb) return ca - cb;

    // 2) 같은 카테고리 내부 정렬
    if (ca === 3) {
      // 한글
      return ta.localeCompare(tb, "ko-KR");
    }

    if (ca === 2) {
      // 영문 (대소문자 무시)
      return ta.localeCompare(tb, "en", { sensitivity: "base" });
    }

    // 기호 / 숫자 / 기타
    return ta.localeCompare(tb);

    function termCategory(s) {
      if (!s) return 9;
      const t = s.trim();
      if (!t) return 9;

      const ch = t[0];

      // 기호
      if (!/[A-Za-z0-9가-힣]/.test(ch)) return 0;

      // 숫자
      if (ch >= "0" && ch <= "9") return 1;

      // 영문
      if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z")) return 2;

      // 한글
      if (ch >= "가" && ch <= "힣") return 3;

      return 9;
    }
  }

function shouldDropTrailingParticle(term) {
    if (!term || term.length < 2) return false;
    const t = term.trim();

    // 1글자 조사
    const one = ["은","는","이","가","을","를","의","에","도","만","들","뿐"];
    if (one.includes(t.slice(-1))) return true;

    // 2글자 이상 접미사(조사/표현)
    const multi = ["와","과","부터","까지","이란","란","이라는","라는","등","및",
                  "에서","에게","께서","으로","로서","로써","처럼","보다","밖에","마다","조차","마저","부터는","까지는"];
    for (const s of multi) {
      if (t.length > s.length + 1 && t.endsWith(s)) return true;
    }

    return false;
  }

function isGenericQuantifierPhrase(t) {
    const s = t.trim();

    // 1) 단독/짧은 형태
    if (/^(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|몇|여러)\s*가지$/.test(s)) return true;

    // 2) “가지 + 일반명사” 형태
    // (측면/관점/방법/이유/문제/사례/경우/요소/항목/측정/기준 등)
    if (/^(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|몇|여러)\s*가지\s*(측면|관점|방법|이유|문제|사례|경우|요소|항목|기준|조건|측정|접근|특징)$/.test(s)) return true;

    // 3) 앞이 잘려서 “가지 …”만 남은 경우도 제거
    if (/^가지\s*(측면|관점|방법|이유|문제|사례|경우|요소|항목|기준|조건|접근|특징)$/.test(s)) return true;

    return false;
  }

function shouldDropDanglingModifier(term) {
    const t = term.trim();
    return /(다른|위한|대한|통한|같은|관련|관련된|이외의|등의)$/.test(t);
  }

function isUsefulTerm(term, dropExact) {
    const t = normalizeTerm(term);
    if (!t) return false;
    if (dropExact && dropExact.has(t)) return false;
    if (shouldDropTrailingParticle(t)) return false;
    if (isGenericQuantifierPhrase(t)) return false;
    if (shouldDropDanglingModifier(t)) return false;
    return true;
  }

async function findTocRange(textCache, totalPages, settings) {
    const IS_MANUAL = document.getElementById('paramManualPages').checked;
    if (IS_MANUAL) {
      let s = document.getElementById('paramManualPagesStart').value;
      let e = document.getElementById('paramManualPagesEnd').value;
      if (isNaN(s) || isNaN(e) || parseInt(s) != s || parseInt(e) != e) {
        alert("시작/끝 페이지가 정수가 아님!");
        return [null, null];
      }
      s = parseInt(s) - 1;
      e = parseInt(e) - 1;
      if (s < 0 || e < s || e >= totalPages) {
        alert("목차 페이지 범위가 이상함!");
        return [null, null];
      }
      return [s, e];
    }

    const PAGE_HEADER = document.getElementById('paramPageHeaderStr').value;
    const scanEnd = Math.min(totalPages, settings.maxTocScanPages);

    logPut("목차 자동 탐색: 1~" + scanEnd + "쪽에서 '" + PAGE_HEADER + "' 검색 중...");
    let tocStart = null;
    for (let p = 1; p <= scanEnd; p++) {
      const txt = await textCache.get(p);
      if (txt.indexOf(PAGE_HEADER) > -1) {
        tocStart = p - 1; // 0-index
        logPut("목차 시작 페이지 후보 발견: " + p + "쪽");
        break;
      }
    }
    if (tocStart === null) return [null, null];

    // TOC end heuristics: stop when (a) blank page, (b) page containing tocEndMark, or (c) near max scan
    let tocEnd = tocStart;
    for (let p0 = tocStart; p0 < Math.min(totalPages, tocStart + 50); p0++) {
      const txt = await textCache.get(p0 + 1);
      const stripped = txt.replace(/\s+/g, "");
      if (!stripped) { // blank-ish
        tocEnd = p0 - 1;
        break;
      }
      tocEnd = p0;
      if (txt.indexOf(settings.tocEndMark) > -1) {
        tocEnd = p0;
        break;
      }
    }
    return [tocStart, tocEnd];
  }

async function parseTocLevel1And2(pdf, tocStart, tocEnd) {
    const items = [];
    for (let p0 = tocStart; p0 <= tocEnd; p0++) {
      logPut("목차 파싱 중: " + (p0 + 1) + "쪽");
      const page = await pdf.getPage(p0 + 1);
      const textContent = await page.getTextContent();
      const lines = groupItemsIntoLines(textContent.items);

      for (const line of lines) {
        const parsed = parseTocLine(line.text);
        if (parsed) {
          items.push({
            level: parsed.level,
            number: parsed.number,
            title: parsed.title,
            page: parsed.page
          });
        }
      }
    }
    return items.filter(x => x.title && x.page && x.page > 0);
  }

function parseTocLine(rawLine) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) return null;

    const mPage = line.match(/^(.*?)(\s+)(\d{1,4})\s*$/);
    if (!mPage) return null;

    const left = mPage[1].trim();
    const page = parseInt(mPage[3], 10);
    if (!page || page <= 0) return null;

    
    // Level 1 (chapter) can appear as "CHAPTER 1 ..." or spaced letters "C H A P T E R 1 ..."
    const mChap = left.match(/^(?:CHAPTER|C\s*H\s*A\s*P\s*T\s*E\s*R)\s*(\d+)\s+(.*)$/i);
    if (mChap) {
      return { level: 1, number: mChap[1], title: mChap[2].trim(), page: page };
    }
    const m2 = left.match(/^(\d+\.\d+)\s+(.*)$/);
    if (m2) {
      return { level: 2, number: m2[1], title: m2[2].trim(), page: page };
    }

    const m1 = left.match(/^(\d+)\s+(.*)$/);
    if (m1) {
      return { level: 1, number: m1[1], title: m1[2].trim(), page: page };
    }

    return null;
  }

function groupItemsIntoLines(items) {
    const THRESHOLD_DY = 2.5;
    const buckets = [];
    for (const it of items) {
      const str = (it.str || "").trim();
      if (!str) continue;
      const x = it.transform[4];
      const y = it.transform[5];

      let bucket = null;
      for (const b of buckets) {
        if (Math.abs(b.y - y) <= THRESHOLD_DY) {
          bucket = b;
          break;
        }
      }
      if (!bucket) {
        bucket = { y: y, parts: [] };
        buckets.push(bucket);
      }
      bucket.parts.push({ x: x, str: it.str });
    }

    buckets.sort((a, b) => b.y - a.y);

    const lines = buckets.map(b => {
      b.parts.sort((p, q) => p.x - q.x);
      const text = b.parts.map(p => p.str).join(" ").replace(/\s+/g, " ").trim();
      return { y: b.y, text: text };
    });

    // Merge cases where the page number is extracted as a separate line.
    // If a line is only digits and the previous line has no trailing digits, merge them.
    const merged = [];
    for (let i = 0; i < lines.length; i++) {
      const cur = lines[i];
      const prev = merged.length ? merged[merged.length - 1] : null;
      if (prev && /^\d{1,4}$/.test(cur.text) && !/\d{1,4}\s*$/.test(prev.text)) {
        prev.text = (prev.text + " " + cur.text).replace(/\s+/g, " ").trim();
        continue;
      }
      merged.push({ y: cur.y, text: cur.text });
    }
    return merged;
  }

function buildChapterRanges(level1Items, level2Items, mode) {
    const useSections = mode === "section";
    let chapters = (useSections ? (level2Items || []) : (level1Items || [])).slice().sort((a, b) => a.page - b.page);

    if (!chapters.length && !useSections && (level2Items || []).length) {
      const byChMin = new Map(); // ch -> min level2 page
      for (const it of level2Items) {
        const ch = String(it.number || "").split(".")[0];
        const p = it.page;
        if (!ch || !p) continue;
        if (!byChMin.has(ch) || p < byChMin.get(ch)) byChMin.set(ch, p);
      }
      chapters = Array.from(byChMin.entries())
        .map(([ch, pMin]) => {
          // Heuristic: chapter title page is usually right before the first 1.x section page.
          const start = Math.max(1, pMin - 1);
          return { number: ch, title: "", page: start };
        })
        .sort((a, b) => a.page - b.page);
    }

    const ranges = [];
    for (let i = 0; i < chapters.length; i++) {
      const start = chapters[i].page;
      const end = (i + 1 < chapters.length) ? (chapters[i + 1].page - 1) : 1000000;
      ranges.push({ ch: String(chapters[i].number), start: start, end: end, title: chapters[i].title || "" });
    }
    return ranges;
  }

function chapterForBookPage(chapterRanges, bookPage) {
    for (const r of chapterRanges) {
      if (r.start <= bookPage && bookPage <= r.end) return r.ch;
    }
    return null;
  }

function estimateBookToPhysicalOffset(pageTexts, totalPages, level1Items, tocEnd0, level2Items) {
    // Robust offset estimation:
    // 1) If level1 chapter-1 title exists, try matching it after TOC.
    // 2) Otherwise match multiple level2 titles (with known book pages) and take median offset.
    const startPhys = Math.min(totalPages, Math.max(1, (tocEnd0 || 0) + 2)); // past TOC
    const scanEnd = Math.min(totalPages, startPhys + 260);

    const ch1 = (level1Items || []).find(x => String(x.number) === "1");
    if (ch1 && ch1.title && ch1.title.trim().length >= 2) {
      const title = ch1.title.trim();
      const titlePrefix = title.slice(0, Math.min(10, title.length));
      const reNeedle = new RegExp("\\b" + escapeRegExp(ch1.number) + "\\s+" + escapeRegExp(titlePrefix), "i");

      for (let p = startPhys; p <= scanEnd; p++) {
        const txt = pageTexts[p] || "";
        if (!txt) continue;
        if (txt.indexOf(title) > -1 && reNeedle.test(txt)) return p - ch1.page;
      }
      for (let p = startPhys; p <= scanEnd; p++) {
        const txt = pageTexts[p] || "";
        if (txt && txt.indexOf(title) > -1) return p - ch1.page;
      }
    }

    const cands = (level2Items || []).slice()
      .filter(it => it && it.title && it.title.trim().length >= 4 && it.page && it.page > 0)
      .sort((a, b) => (b.title.length - a.title.length)); // longer titles first

    const offsets = [];
    const MAX_CANDS = 20;

    for (let i = 0; i < Math.min(MAX_CANDS, cands.length); i++) {
      const it = cands[i];
      const title = it.title.trim();
      for (let p = startPhys; p <= scanEnd; p++) {
        const txt = pageTexts[p] || "";
        if (txt && txt.indexOf(title) > -1) {
          offsets.push(p - it.page);
          break;
        }
      }
      if (offsets.length >= 7) break;
    }

    if (!offsets.length) return 0;
    offsets.sort((a, b) => a - b);
    return offsets[Math.floor(offsets.length / 2)];
  }

async function buildPhysicalToBookMap(pdf, totalPages, pageTexts, level1Items, level2Items, tocEnd0) {
    const physicalToBook = new Array(totalPages + 1).fill(null);
    let source = "fallback";
    let offset = 0;

    try {
      if (typeof pdf.getPageLabels === 'function') {
        const labels = await pdf.getPageLabels();
        if (labels && labels.length) {
          let numericCount = 0;
          for (let p = 1; p <= totalPages; p++) {
            const lab = labels[p - 1];
            if (!lab) continue;
            const mNum = String(lab).match(/^\s*(\d{1,6})\s*$/);
            if (mNum) {
              physicalToBook[p] = parseInt(mNum[1], 10);
              numericCount++;
            }
          }
          if (numericCount > 0) source = "labels";
        }
      }
    } catch (e) {
      source = "fallback";
    }

    if (source !== "labels") {
      offset = estimateBookToPhysicalOffset(pageTexts, totalPages, level1Items, tocEnd0, level2Items);
      for (let p = 1; p <= totalPages; p++) {
        const bookPage = p - offset;
        physicalToBook[p] = bookPage > 0 ? bookPage : null;
      }
    }

    return { physicalToBook, source, offset };
  }

function logPageMapSummary(result) {
    const physicalToBook = result.physicalToBook;
    let firstPhys = null, firstBook = null, lastPhys = null, lastBook = null;
    for (let p = 1; p < physicalToBook.length; p++) {
      if (physicalToBook[p] != null) { firstPhys = p; firstBook = physicalToBook[p]; break; }
    }
    for (let p = physicalToBook.length - 1; p >= 1; p--) {
      if (physicalToBook[p] != null) { lastPhys = p; lastBook = physicalToBook[p]; break; }
    }

    if (result.source === "labels") {
      logPut("페이지 라벨 사용: 물리 " + firstPhys + "쪽 -> 본문 " + firstBook + " / 물리 " + lastPhys + "쪽 -> 본문 " + lastBook);
      return;
    }

    logPut("페이지 라벨 없음: 오프셋 추정 사용(book_page = physical_page - " + result.offset + ")");
    logPut("페이지 매핑: 물리 " + firstPhys + "쪽 -> 본문 " + firstBook + " / 물리 " + lastPhys + "쪽 -> 본문 " + lastBook);
  }

function extractTermsFromTocTitles(level2Items, dropExact) {
    const out = [];
    for (const it of level2Items) {
      const title = (it.title || "").trim();
      if (!title) continue;

      const candidates = splitTitleIntoCandidates(title);
      for (const c of candidates) {
        const norm = normalizeTerm(c);
        if (!norm) continue;
        if (dropExact.has(norm)) continue;
        out.push(norm);
      }
    }
    return dedupeTerms(out, dropExact);
  }

function extractTechTokensFromBody(pageTexts, totalPages, physicalToBook, dropExact) {
    const tokens = new Map();
    const MAX_BODY_PAGES_FOR_TECH = Math.min(totalPages, 250);

    for (let p = 1; p <= MAX_BODY_PAGES_FOR_TECH; p++) {
      const bookPage = physicalToBook[p];
      if (bookPage == null || bookPage <= 0) continue;

      const txt = pageTexts[p] || "";
      const found = txt.match(/\b[A-Za-z][A-Za-z0-9][A-Za-z0-9._\-\/]{1,28}\b/g) || [];
      for (const tok of found) {
        if (!tok) continue;
        if (dropExact.has(tok)) continue;

        if (tok.length < 3 || tok.length > 30) continue;
        if (/^\d+$/.test(tok)) continue;
        if ((tok.match(/[._\-\/]/g) || []).length > 3) continue;

        if (!tokens.has(tok)) tokens.set(tok, { count: 0, pages: new Set() });
        tokens.get(tok).count += 1;
        tokens.get(tok).pages.add(bookPage);
      }
    }

    const out = [];
    for (const [tok, info] of tokens.entries()) {
      if (info.pages.size >= 2) out.push(tok);
    }

    out.sort((a, b) => {
      const A = tokens.get(a);
      const B = tokens.get(b);
      if (B.pages.size !== A.pages.size) return B.pages.size - A.pages.size;
      return B.count - A.count;
    });

    return out;
  }

function extractKoreanFromParentheticalPairs(pageTexts, totalPages, physicalToBook, DROP_EXACT) {
    // 튜닝 파라미터
    const MIN_COUNT = 1;   // 괄호 병기는 1회만 나와도 용어일 확률 높음
    const MAX_COUNT = 120; // 너무 흔한 건 제외(필요하면 올리기)
    const MAX_TERMS = 500; // 괄호 병기에서 가져올 국문 후보 상한

    const stats = new Map(); // term -> { count, first }

    // 1) 국문(영문/약어)  예: 관측 가능성(observability), 근본 원인 분석(RCA)
    // - 국문: 한글 2~20 + (공백 포함 2단어까지 허용)
    // - 괄호: 영문/숫자/기호 ._- / 공백 약간
    const reKoEn = /([가-힣]{2,20}(?:\s+[가-힣]{2,20})?)\s*\(\s*([A-Za-z][A-Za-z0-9._\-\/ ]{1,30})\s*\)/g;

    // 2) 영문(국문) 예: observability(관측 가능성)
    const reEnKo = /([A-Za-z][A-Za-z0-9._\-\/ ]{1,30})\s*\(\s*([가-힣]{2,20}(?:\s+[가-힣]{2,20})?)\s*\)/g;

    for (let physical = 1; physical <= totalPages; physical++) {
      const bookPage = physicalToBook[physical];
      if (bookPage == null || bookPage <= 0) continue;

      const text = pageTexts[physical] || "";
      if (!text) continue;

      // (A) 국문(영문)
      let m;
      while ((m = reKoEn.exec(text)) !== null) {
        let ko = m[1];
        let en = m[2];
        ko = normalizeTerm(ko);

        if (!isUsefulTerm(ko, DROP_EXACT)) continue;

        const prev = stats.get(ko);
        if (!prev) stats.set(ko, { count: 1, first: bookPage });
        else {
          prev.count++;
          if (bookPage < prev.first) prev.first = bookPage;
        }

        // 영문은 normalizeTerm(한글 위주) 돌리지 말고, 간단 정리만
        // 너무 길거나 너무 짧은 건 제외(튜닝 가능)
        en = String(en || "").trim();
        if (en && en.length >= 2 && en.length <= 40 && !(DROP_EXACT && DROP_EXACT.has(en))) {
          const prevE = stats.get(en);
          if (!prevE) stats.set(en, { count: 1, first: bookPage });
          else { prevE.count++; if (bookPage < prevE.first) prevE.first = bookPage; }
        }
      }

      // (B) 영문(국문)
      while ((m = reEnKo.exec(text)) !== null) {
        let en = m[1];
        let ko = m[2];
        ko = normalizeTerm(ko);

        if (isUsefulTerm(ko, DROP_EXACT)) {

          const prev = stats.get(ko);
          if (!prev) stats.set(ko, { count: 1, first: bookPage });
          else { prev.count++; if (bookPage < prev.first) prev.first = bookPage; }
        }

        // 영문도 저장(추가)
        en = String(en || "").trim();
        if (en && !(DROP_EXACT && DROP_EXACT.has(en))) {
          //console.log(en, ko);
          // 영문은 shouldDropTrailingParticle(한글 조사) 필터를 적용하지 않는 게 보통 안전
          const prevE = stats.get(en);
          if (!prevE) stats.set(en, { count: 1, first: bookPage });
          else { prevE.count++; if (bookPage < prevE.first) prevE.first = bookPage; }
        }
      }

      if (physical % 80 === 0) logPut("괄호 병기 추출 진행: 물리 " + physical + "/" + totalPages);
    }

    // 빈도 필터링 + first 등장 순
    const arr = [];
    for (const [term, info] of stats.entries()) {
      if (info.count < MIN_COUNT) continue;
      if (info.count > MAX_COUNT) continue;
      arr.push({ term, first: info.first, count: info.count });
    }

    arr.sort((a, b) => a.first - b.first || b.count - a.count || a.term.localeCompare(b.term, "ko-KR"));

    const out = arr.slice(0, MAX_TERMS).map(x => x.term);

    logPut(
      "괄호 병기 국문 후보: 전체 " + stats.size +
      "개 중 필터 후 " + arr.length +
      "개, 최종 채택 " + out.length +
      "개 (MIN " + MIN_COUNT + ", MAX " + MAX_COUNT + ")"
    );

    return out;
  }

function splitTitleIntoCandidates(title) {
    const t = title
      .replace(/[\/:;,\(\)\[\]<>「」『』“”"']/g, "|")
      .replace(/[-–—]/g, "|")
      .replace(/\s+/g, " ")
      .trim();

    const parts = t.split("|").map(x => x.trim()).filter(Boolean);
    const cands = [title.trim()].concat(parts);

    const spaced = title.trim().split(/\s+/).filter(Boolean);
    if (spaced.length >= 2 && spaced.length <= 6) {
      for (let i = 0; i < spaced.length; i++) {
        for (let k = 2; k <= 3; k++) {
          if (i + k <= spaced.length) {
            cands.push(spaced.slice(i, i + k).join(" "));
          }
        }
      }
    }
    return cands;
  }

function normalizeTerm(term) {
    let t = String(term || "").trim();
    if (!t) return "";

    t = t.replace(/\s+/g, " ").trim();
    t = t.replace(/^[\.\-–—:;,\(\)\[\]{}]+/, "").replace(/[\.\-–—:;,\(\)\[\]{}]+$/, "").trim();
    if (!t) return "";

    if (t.indexOf("\n") > -1 || t.indexOf("\r") > -1) return "";

    if (t.length < 2) return "";
    if (t.length > 60) return "";

    return t;
  }

function dedupeTerms(terms, dropExact) {
    const seen = new Set();
    const out = [];
    for (const t of terms) {
      const norm = normalizeTerm(t);
      if (!norm) continue;
      if (dropExact.has(norm)) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(norm);
    }
    return out;
  }

function buildIndexLines(pageTexts, totalPages, terms, physicalToBook, chapterRanges, opts) {
    const maxPagesPerTerm = opts.maxPagesPerTerm || 11;
    const onePagePerChapter = !!opts.onePagePerChapter;

    // Overlap-based dedupe: remove shorter terms that are mostly covered by a longer containing term.
    // Example: "원인 분석" -> removed if pages overlap heavily with "근본 원인 분석".
    const OVERLAP_THRESHOLD = 0.8;

    // 1) First pass: compute chosen pages for every term (after per-chapter compression and capping).
    const termToPages = new Map(); // term -> number[]
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      const pages = findBookPagesForTerm(term, pageTexts, physicalToBook);
      if (pages.length === 0) continue;

      let chosen = pages;
      if (onePagePerChapter && chapterRanges && chapterRanges.length) {
        const perCh = new Map();
        for (const bp of pages) {
          const ch = chapterForBookPage(chapterRanges, bp);
          if (!ch) continue;
          if (!perCh.has(ch) || bp < perCh.get(ch)) perCh.set(ch, bp);
        }
        chosen = Array.from(perCh.values()).sort((a, b) => a - b);
      }

      chosen = chosen.slice(0, maxPagesPerTerm);
      termToPages.set(term, chosen);

      if ((i + 1) % 50 === 0) logPut("... 용어 1차 처리 " + (i + 1) + "/" + terms.length);
    }

    // 2) Dedupe by containment + overlap (deterministic)
    const removed = dedupeTermsByContainmentAndOverlap(terms, termToPages, OVERLAP_THRESHOLD);
    if (removed.size) logPut("포함/겹침 기반 정제: " + removed.size + "개 용어 제거(임계값 " + OVERLAP_THRESHOLD + ")");

    // 3) Format lines (keep original term order)
    const lines = [];
    for (const term of terms) {
      if (removed.has(term)) continue;
      const chosen = termToPages.get(term);
      if (!chosen || !chosen.length) continue;
      lines.push(term + "    " + chosen.join(", "));
    }
    return lines;
  }

function dedupeTermsByContainmentAndOverlap(termsInOrder, termToPages, threshold) {
    // Remove a term T_short if there exists T_long such that:
    // - T_long contains T_short as a substring
    // - overlap(pages(T_short), pages(T_long)) / pages(T_short) >= threshold
    // Deterministic tie-breakers: prefer higher overlap, then longer term length, then earlier appearance.
    const removed = new Set();

    // Precompute page sets for fast intersection
    const pageSets = new Map();
    for (const t of termsInOrder) {
      const pages = termToPages.get(t);
      if (!pages || !pages.length) continue;
      pageSets.set(t, new Set(pages));
    }

    // Index term positions for deterministic ordering
    const pos = new Map();
    for (let i = 0; i < termsInOrder.length; i++) pos.set(termsInOrder[i], i);

    function overlapRatio(shortT, longT) {
      const s = pageSets.get(shortT);
      const l = pageSets.get(longT);
      if (!s || !l || s.size === 0) return 0;
      let inter = 0;
      for (const p of s) if (l.has(p)) inter++;
      return inter / s.size;
    }

    // For each short term, find best containing longer term
    for (const shortT of termsInOrder) {
      if (removed.has(shortT)) continue;
      const sPages = termToPages.get(shortT);
      if (!sPages || sPages.length < 1) continue;

      let best = null;

      for (const longT of termsInOrder) {
        if (longT === shortT) continue;
        if (removed.has(longT)) continue;

        // Only consider "containing" relationship with strictly longer terms
        if (longT.length <= shortT.length) continue;
        if (longT.indexOf(shortT) === -1) continue;

        const r = overlapRatio(shortT, longT);
        if (r < threshold) continue;

        const cand = {
          term: longT,
          ratio: r,
          len: longT.length,
          pos: pos.get(longT) ?? 1e9
        };

        if (!best) {
          best = cand;
          continue;
        }

        // Tie-breaker: higher overlap, then longer term, then earlier appearance
        if (cand.ratio > best.ratio) best = cand;
        else if (cand.ratio === best.ratio && cand.len > best.len) best = cand;
        else if (cand.ratio === best.ratio && cand.len === best.len && cand.pos < best.pos) best = cand;
      }

      if (best) removed.add(shortT);
    }

    return removed;
  }

function findBookPagesForTerm(term, pageTexts, physicalToBook) {
    const pages = [];
    for (let p = 1; p < pageTexts.length; p++) {
      const txt = pageTexts[p];
      if (!txt) continue;
      if (pageContainsTerm(txt, term)) {
        const bp = physicalToBook[p];
        if (bp != null && bp > 0) pages.push(bp);
      }
    }
    pages.sort((a, b) => a - b);
    const out = [];
    let prev = null;
    for (const x of pages) {
      if (x !== prev) out.push(x);
      prev = x;
    }
    return out;
  }

function pageContainsTerm(pageText, term) {
    const needle = normalizeTerm(term);
    if (!needle) return false;
    if (pageText.indexOf(needle) > -1) return true;

    const normalizedPage = normalizeSearchText(pageText);
    const normalizedNeedle = normalizeSearchText(needle);
    if (normalizedPage.indexOf(normalizedNeedle) > -1) return true;

    if (/[A-Za-z]/.test(needle)) {
      const re = new RegExp("\\b" + escapeRegExp(normalizedNeedle) + "\\b", "i");
      if (re.test(normalizedPage)) return true;
    }

    if (/[가-힣]/.test(needle) && /\s/.test(needle)) {
      return normalizedPage.replace(/\s+/g, "").indexOf(normalizedNeedle.replace(/\s+/g, "")) > -1;
    }

    return false;
  }

function normalizeSearchText(text) {
    return String(text || "")
      .replace(/\u00ad/g, "")
      .replace(/-\s+/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

async function getPageText(pdf, pageNum1) {
    const page = await pdf.getPage(pageNum1);
    const tc = await page.getTextContent();
    const strs = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      strs.push(it.str);
    }
    return strs.join(" ");
  }

// -----------------------------
// Util funcs
// -----------------------------

function logPut(str) {
    const log = document.getElementById('log');
    if (!log) return;

    if (str === undefined) {
      log.value = "";
    } else {
      log.value += str + "\n";
    }
    log.scrollTop = log.scrollHeight;
  }

function getChapterCountOverride() {
    // Reads UI controls from index_generated.html (do not modify HTML).
    // If '챕터 수 수동 지정' is checked, uses that value as chapter count.
    const chk = document.getElementById('paramManualChapters');
    const inp = document.getElementById('paramManualChaptersStart');
    if (chk && chk.checked) {
      const raw = (inp && inp.value != null) ? String(inp.value).trim() : "";
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return n;
      return null; // checked but invalid
    }
    return null;
  }
