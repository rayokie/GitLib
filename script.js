/* ============================================================
   GitLib — script.js
   Sources: Gutendex (gutendex.com), Open Library (openlibrary.org),
            Google Books (googleapis.com/books)
   Features: Background Download Queue & Native EPUB -> PDF Converter
   ============================================================ */

(() => {
  'use strict';

  /* ---------------------------------------------------------- CONFIG */
  const GUTENDEX   = 'https://gutendex.com/books';
  const OPENLIB    = 'https://openlibrary.org/search.json';
  const OL_COVER   = 'https://covers.openlibrary.org/b/id/';
  const GBOOKS     = 'https://www.googleapis.com/books/v1/volumes';
  const PAGE_SIZE  = 20;

  const LS_HISTORY   = 'gitlib_history';
  const LS_DOWNLOADS = 'gitlib_downloads';
  const LS_MODE      = 'gitlib_mode';

  /* ---------------------------------------------------------- STATE */
  let state = {
    query: '',
    mode: localStorage.getItem(LS_MODE) || 'auto',
    page: { gutendex: 1, openlibrary: 1, google: 1 },
    hasMore: { gutendex: true, openlibrary: true, google: true },
    results: [],
    seen: new Set(),
  };

  let history   = safeParse(localStorage.getItem(LS_HISTORY), []);
  let downloads = safeParse(localStorage.getItem(LS_DOWNLOADS), []);

  // Background Download Queue state
  let downloadQueue = [];
  let isProcessingQueue = false;

  let suggestAbort = null;
  let suggestItems = [];
  let suggestIndex = -1;

  function safeParse(str, fallback){ try{ const v = JSON.parse(str); return Array.isArray(v) ? v : fallback; }catch{ return fallback; } }
  function esc(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function sanitizeFilename(s){ return String(s || 'book').replace(/[/\\?%*:|"<>]/g, '-').trim(); }

  function timeAgo(ts){
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
  function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  /* ---------------------------------------------------------- SPLASH SCREEN */
  window.addEventListener('load', () => {
    const splash = document.getElementById('splash');
    const app = document.getElementById('app');
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 300 : 1900;
    app.classList.add('ready');
    setTimeout(() => {
      splash.classList.add('hide');
      setTimeout(() => splash.remove(), 550);
    }, delay);
  });

  /* ---------------------------------------------------------- TOAST SYSTEM */
  function showToast(title, message, iconClass = 'fa-circle-notch fa-spin'){
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
      <i class="fa-solid ${iconClass} toast-icon"></i>
      <div class="toast-body">
        <div class="toast-title">${esc(title)}</div>
        <div class="toast-msg">${esc(message)}</div>
      </div>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hide');
      setTimeout(() => toast.remove(), 350);
    }, 3800);
  }

  /* ---------------------------------------------------------- CORS & FETCH HELPERS */
  async function fetchWithFallback(url, responseType = 'text'){
    const proxies = [
      url,
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
    ];

    for (const targetUrl of proxies) {
      try {
        const res = await fetch(targetUrl);
        if (res.ok) {
          if (responseType === 'arrayBuffer') return await res.arrayBuffer();
          if (responseType === 'blob') return await res.blob();
          if (responseType === 'json') return await res.json();
          return await res.text();
        }
      } catch (e) {
        /* try next fallback proxy */
      }
    }
    throw new Error('Unable to download stream across CORS origins');
  }

  /* ---------------------------------------------------------- DOWNLOAD QUEUE ENGINE */
  function addToDownloadQueue(book){
    const exists = downloadQueue.some(t => t.book.id === book.id && (t.status === 'queued' || t.status === 'downloading'));
    if (exists) {
      showToast('Already in Queue', `"${book.title}" is already downloading or queued.`, 'fa-circle-info');
      return;
    }

    const task = {
      id: 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      book: book,
      status: 'queued', // queued, downloading, completed, failed
      progress: 0,
      statusText: 'Queued...',
      addedAt: Date.now()
    };

    downloadQueue.push(task);
    showToast('Download Queued', `"${book.title}" added to background queue.`, 'fa-layer-group');
    renderDownloadsQueue();
    updateDockDownloadStatus();
    processDownloadQueue();
  }

  async function processDownloadQueue(){
    if (isProcessingQueue) return;

    const currentTask = downloadQueue.find(t => t.status === 'queued');
    if (!currentTask) {
      isProcessingQueue = false;
      updateDockDownloadStatus();
      return;
    }

    isProcessingQueue = true;
    currentTask.status = 'downloading';
    currentTask.progress = 5;
    currentTask.statusText = 'Starting engine...';
    updateDockDownloadStatus();
    renderDownloadsQueue();

    const book = currentTask.book;

    const onProgress = (pct, text) => {
      currentTask.progress = Math.min(100, Math.max(0, Math.round(pct)));
      if (text) currentTask.statusText = text;
      renderDownloadsQueue();
    };

    try {
      if (book.epubUrl || (book.downloadUrl && book.downloadUrl.endsWith('.epub'))) {
        await executeEpubConversion(book, book.epubUrl || book.downloadUrl, onProgress);
      } else if (book.source === 'openlibrary' || book.iaId) {
        await executeInternetArchiveDownload(book, onProgress);
      } else {
        onProgress(20, 'Downloading PDF stream...');
        const blob = await fetchWithFallback(book.downloadUrl, 'blob');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${sanitizeFilename(book.title)}.pdf`;
        a.click();
      }

      currentTask.status = 'completed';
      currentTask.progress = 100;
      currentTask.statusText = 'Finished & Saved';
      logDownload(book);
      showToast('Download Ready!', `"${book.title}" PDF downloaded.`, 'fa-circle-check');
    } catch (err) {
      console.warn('Queue processing error:', err);
      currentTask.status = 'failed';
      currentTask.statusText = 'Opened browser reader fallback';
      if (book.downloadUrl || book.viewUrl) {
        window.open(book.downloadUrl || book.viewUrl, '_blank', 'noopener');
      }
      showToast('Opened in Browser', `Direct stream active for "${book.title}".`, 'fa-arrow-up-right-from-square');
    }

    isProcessingQueue = false;
    renderDownloadsQueue();
    updateDockDownloadStatus();
    // Process next item in queue
    processDownloadQueue();
  }

  function updateDockDownloadStatus(){
    const activeBtn = document.getElementById('dock-btn-downloads');
    const badge = document.getElementById('dl-badge');
    const hasActive = downloadQueue.some(t => t.status === 'downloading' || t.status === 'queued');

    if (activeBtn) {
      activeBtn.classList.toggle('downloading-active', hasActive);
    }
    if (badge) {
      badge.classList.toggle('hidden', !hasActive);
    }
  }

  /* ---------------------------------------------------------- EPUB -> PDF ENGINE */
  async function executeEpubConversion(book, epubUrl, onProgress){
    onProgress(10, 'Fetching EPUB package...');
    const arrayBuffer = await fetchWithFallback(epubUrl, 'arrayBuffer');

    onProgress(25, 'Unpacking chapters & images...');
    const epub = ePub(arrayBuffer);
    await epub.ready;

    const metadata = await epub.loaded.metadata;
    const title = metadata.title || book.title || 'Book';
    const author = metadata.creator || book.authors || 'Unknown';

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 45;
    const maxLineWidth = pageWidth - margin * 2;

    // Title Page
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(24);
    const titleLines = pdf.splitTextToSize(title, maxLineWidth);
    pdf.text(titleLines, margin, 180);

    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(13);
    pdf.setTextColor(100);
    pdf.text(`Author: ${author}`, margin, 180 + titleLines.length * 28);
    pdf.text(`Converted directly by GitLib Engine`, margin, 180 + titleLines.length * 28 + 22);

    onProgress(40, 'Rendering document pages...');

    const spine = epub.spine;
    const totalSections = spine.items.length;
    let yPos = margin;
    let currentPageNum = 1;

    for (let i = 0; i < totalSections; i++) {
      const item = spine.items[i];
      if (!item) continue;

      const pct = 40 + Math.round((i / totalSections) * 50);
      onProgress(pct, `Converting chapter ${i + 1}/${totalSections}...`);

      try {
        const doc = await item.load(epub.load.bind(epub));
        let text = '';
        if (doc && doc.querySelector) {
          const body = doc.querySelector('body');
          if (body) text = body.innerText || body.textContent || '';
        }

        if (!text.trim()) continue;

        pdf.addPage();
        currentPageNum++;
        yPos = margin;

        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(10);
        pdf.setTextColor(40);

        const paragraphs = text.split(/\n+/);
        for (const p of paragraphs) {
          const cleanP = p.trim();
          if (!cleanP) continue;

          const lines = pdf.splitTextToSize(cleanP, maxLineWidth);
          const neededHeight = lines.length * 14 + 8;

          if (yPos + neededHeight > pageHeight - margin) {
            pdf.setFontSize(8);
            pdf.setTextColor(120);
            pdf.text(`${currentPageNum}`, pageWidth / 2, pageHeight - 20, { align: 'center' });

            pdf.addPage();
            currentPageNum++;
            yPos = margin;
            pdf.setFontSize(10);
            pdf.setTextColor(40);
          }

          pdf.text(lines, margin, yPos);
          yPos += neededHeight;
        }
      } catch (e) {
        /* gracefully skip broken chapters */
      }
    }

    onProgress(95, 'Compiling PDF download...');
    pdf.save(`${sanitizeFilename(title)}.pdf`);
  }

  /* ---------------------------------------------------------- INTERNET ARCHIVE ENGINE */
  async function executeInternetArchiveDownload(book, onProgress){
    onProgress(10, 'Resolving Internet Archive manifest...');
    const iaMatch = book.id.match(/(?:openlibrary_|\/)?([a-zA-Z0-9_\-]+)$/);
    const iaId = iaMatch ? iaMatch[1] : null;

    if (!iaId) throw new Error('Invalid IA ID');

    const metaUrl = `https://archive.org/metadata/${iaId}`;
    const meta = await fetchWithFallback(metaUrl, 'json');

    const files = meta.files || [];
    const pdfFile = files.find(f => f.name && f.name.toLowerCase().endsWith('.pdf'));

    if (pdfFile) {
      onProgress(50, 'Fetching HD PDF stream...');
      const pdfUrl = `https://archive.org/download/${iaId}/${pdfFile.name}`;
      const blob = await fetchWithFallback(pdfUrl, 'blob');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${sanitizeFilename(book.title)}.pdf`;
      a.click();
      return;
    }

    onProgress(25, 'Downloading HD leaf pages...');
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    const totalPages = Math.min(25, parseInt(meta.item_size_count || '15', 10) || 15);
    let pageAdded = 0;

    for (let p = 1; p <= totalPages; p++) {
      const pct = 25 + Math.round((p / totalPages) * 65);
      onProgress(pct, `Fetching HD leaf ${p} of ${totalPages}...`);

      const leafUrl = `https://archive.org/download/${iaId}/page/n${p}_w1200.jpg`;
      try {
        const imgBlob = await fetchWithFallback(leafUrl, 'blob');
        const imgDataUrl = await new Promise((res) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result);
          reader.readAsDataURL(imgBlob);
        });

        if (pageAdded > 0) pdf.addPage();
        pdf.addImage(imgDataUrl, 'JPEG', 0, 0, pageWidth, pageHeight);
        pageAdded++;
      } catch (e) {
        if (pageAdded > 5) break;
      }
    }

    if (pageAdded === 0) throw new Error('No accessible leaf pages');

    onProgress(95, 'Building PDF document...');
    pdf.save(`${sanitizeFilename(book.title)}.pdf`);
  }

  /* ---------------------------------------------------------- NAV / DOCK */
  document.querySelectorAll('.dock-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dock-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('view-' + btn.dataset.view).classList.add('active');
      if (btn.dataset.view === 'history') renderHistory();
      if (btn.dataset.view === 'library') renderLibrary();
      if (btn.dataset.view === 'downloads') renderDownloadsQueue();
      if (btn.dataset.view === 'trending' && !document.getElementById('trending-grid').children.length) loadTrending();
    });
  });

  function goToSearchTab(){
    document.querySelectorAll('.dock-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'search'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-search').classList.add('active');
  }

  /* ---------------------------------------------------------- SOURCE SELECT DROPDOWN */
  const sourceDropdown = document.getElementById('source-mode-select');
  sourceDropdown.value = state.mode;
  sourceDropdown.addEventListener('change', () => {
    state.mode = sourceDropdown.value;
    localStorage.setItem(LS_MODE, state.mode);
  });

  /* ---------------------------------------------------------- SEARCH INPUT + SUGGESTIONS */
  const input      = document.getElementById('search-input');
  const clearBtn    = document.getElementById('clear-btn');
  const suggestPanel = document.getElementById('suggest-panel');

  input.addEventListener('input', () => {
    clearBtn.classList.toggle('hidden', !input.value);
    debouncedSuggest(input.value.trim());
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.add('hidden');
    closeSuggest();
    input.focus();
  });

  document.getElementById('search-btn').addEventListener('click', () => runSearch());

  input.addEventListener('keydown', e => {
    if (suggestPanel.classList.contains('open') && suggestItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); suggestIndex = Math.min(suggestIndex + 1, suggestItems.length - 1); paintSuggestActive(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); suggestIndex = Math.max(suggestIndex - 1, 0); paintSuggestActive(); return; }
      if (e.key === 'Enter' && suggestIndex >= 0) { e.preventDefault(); pickSuggestion(suggestItems[suggestIndex]); return; }
      if (e.key === 'Escape') { closeSuggest(); return; }
    }
    if (e.key === 'Enter') { closeSuggest(); runSearch(); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) closeSuggest();
  });

  function closeSuggest(){ suggestPanel.classList.remove('open'); suggestPanel.innerHTML = ''; suggestItems = []; suggestIndex = -1; }

  function paintSuggestActive(){
    [...suggestPanel.children].forEach((el, i) => el.classList.toggle('active', i === suggestIndex));
  }

  const debouncedSuggest = debounce(fetchSuggestions, 260);

  async function fetchSuggestions(q){
    if (q.length < 2) { closeSuggest(); return; }

    const historyMatches = history
      .filter(h => h.query.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 3)
      .map(h => ({ type: 'history', title: h.query, sub: 'searched before' }));

    if (suggestAbort) suggestAbort.abort();
    suggestAbort = new AbortController();

    let liveMatches = [];
    try {
      const url = `${OPENLIB}?q=${encodeURIComponent(q)}&limit=6&fields=title,author_name`;
      const res = await fetch(url, { signal: suggestAbort.signal });
      if (res.ok) {
        const data = await res.json();
        liveMatches = (data.docs || [])
          .filter(d => d.title)
          .slice(0, 6)
          .map(d => ({ type: 'live', title: d.title, sub: (d.author_name && d.author_name[0]) || '' }));
      }
    } catch (_) { /* aborted or offline */ }

    const merged = [...historyMatches, ...liveMatches].filter((v, i, arr) =>
      arr.findIndex(x => x.title.toLowerCase() === v.title.toLowerCase()) === i
    ).slice(0, 8);

    suggestItems = merged;
    suggestIndex = -1;
    if (!merged.length) { closeSuggest(); return; }

    suggestPanel.innerHTML = merged.map(m => `
      <div class="suggest-item" data-title="${esc(m.title)}">
        <i class="fa-solid ${m.type === 'history' ? 'fa-clock-rotate-left' : 'fa-magnifying-glass'}"></i>
        <span class="st">${esc(m.title)}</span>
        ${m.sub ? `<span class="sa">${esc(m.sub)}</span>` : ''}
      </div>`).join('');
    suggestPanel.classList.add('open');

    [...suggestPanel.children].forEach((el, i) => {
      el.addEventListener('click', () => pickSuggestion(suggestItems[i]));
    });
  }

  function pickSuggestion(item){
    input.value = item.title;
    closeSuggest();
    runSearch();
  }

  /* ---------------------------------------------------------- SOURCE FETCHERS */
  async function fetchGutendex(query, page){
    const params = new URLSearchParams({ page });
    if (query) params.set('search', query);
    const res = await fetch(`${GUTENDEX}?${params}`);
    if (!res.ok) throw new Error('Gutendex unavailable');
    const data = await res.json();
    const items = (data.results || []).map(b => {
      const formats = b.formats || {};
      const epubUrl = formats['application/epub+zip'] || null;
      const dl = epubUrl || formats['text/plain; charset=utf-8'] || formats['text/plain'] || null;
      return {
        id: 'gutendex_' + b.id,
        source: 'gutendex',
        title: b.title || 'Untitled',
        authors: (b.authors || []).map(a => a.name).join(', ') || 'Unknown author',
        publisher: 'Project Gutenberg',
        year: '',
        cover: formats['image/jpeg'] || null,
        downloadUrl: dl,
        epubUrl: epubUrl,
        viewUrl: formats['text/html'] || dl || `https://www.gutenberg.org/ebooks/${b.id}`,
        formatLabel: epubUrl ? 'EPUB → PDF' : 'TXT',
      };
    });
    return { items, hasMore: !!data.next };
  }

  async function fetchOpenLibrary(query, page){
    const params = new URLSearchParams({ q: query, page, limit: PAGE_SIZE, fields: 'key,title,author_name,first_publish_year,publisher,cover_i,ia' });
    const res = await fetch(`${OPENLIB}?${params}`);
    if (!res.ok) throw new Error('Open Library unavailable');
    const data = await res.json();
    const items = (data.docs || []).map(d => {
      const hasIa = d.ia && d.ia.length > 0;
      const iaId = hasIa ? d.ia[0] : null;
      return {
        id: 'openlibrary_' + d.key,
        iaId: iaId,
        source: 'openlibrary',
        title: d.title || 'Untitled',
        authors: (d.author_name || []).join(', ') || 'Unknown author',
        publisher: (d.publisher && d.publisher[0]) || '',
        year: d.first_publish_year || '',
        cover: d.cover_i ? `${OL_COVER}${d.cover_i}-M.jpg` : null,
        downloadUrl: iaId ? `https://archive.org/download/${iaId}` : null,
        viewUrl: `https://openlibrary.org${d.key}`,
        formatLabel: iaId ? 'Archive PDF' : '',
      };
    });
    return { items, hasMore: page * PAGE_SIZE < (data.numFound || 0) };
  }

  async function fetchGoogleBooks(query, page){
    const startIndex = (page - 1) * PAGE_SIZE;
    const params = new URLSearchParams({ q: query, startIndex, maxResults: PAGE_SIZE });
    const res = await fetch(`${GBOOKS}?${params}`);
    if (!res.ok) throw new Error('Google Books unavailable');
    const data = await res.json();
    const items = (data.items || []).map(it => {
      const vi = it.volumeInfo || {};
      const ai = it.accessInfo || {};
      let dl = null, fmt = '', epubUrl = null;
      if (ai.epub && ai.epub.isAvailable && ai.epub.downloadLink) { dl = ai.epub.downloadLink; epubUrl = dl; fmt = 'EPUB → PDF'; }
      else if (ai.pdf && ai.pdf.isAvailable && ai.pdf.downloadLink) { dl = ai.pdf.downloadLink; fmt = 'PDF'; }
      const cover = vi.imageLinks && (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail);
      return {
        id: 'google_' + it.id,
        source: 'google',
        title: vi.title || 'Untitled',
        authors: (vi.authors || []).join(', ') || 'Unknown author',
        publisher: vi.publisher || '',
        year: (vi.publishedDate || '').slice(0, 4),
        cover: cover ? cover.replace('http://', 'https://') : null,
        downloadUrl: dl,
        epubUrl: epubUrl,
        viewUrl: vi.previewLink || vi.infoLink || null,
        formatLabel: fmt,
      };
    });
    const total = data.totalItems || 0;
    return { items, hasMore: startIndex + PAGE_SIZE < total };
  }

  const SOURCE_FETCHERS = { gutendex: fetchGutendex, openlibrary: fetchOpenLibrary, google: fetchGoogleBooks };

  /* ---------------------------------------------------------- SEARCH ORCHESTRATION */
  async function runSearch(){
    const query = input.value.trim();
    if (query.length < 2) return;

    state.query = query;
    state.page = { gutendex: 1, openlibrary: 1, google: 1 };
    state.hasMore = { gutendex: true, openlibrary: true, google: true };
    state.results = [];
    state.seen = new Set();

    saveHistoryEntry(query, state.mode);

    const grid = document.getElementById('results-grid');
    grid.innerHTML = '';
    document.getElementById('results-meta').classList.add('hidden');
    document.getElementById('empty-search').classList.remove('show');
    document.getElementById('load-more').classList.add('hidden');
    showLoader('search-loader', true);

    await fetchAndRender(true);
    showLoader('search-loader', false);
  }

  async function fetchAndRender(isFirstPage){
    const sources = state.mode === 'auto' ? ['gutendex', 'openlibrary', 'google'] : [state.mode];
    const active = sources.filter(s => state.hasMore[s]);

    const settled = await Promise.allSettled(
      active.map(s => SOURCE_FETCHERS[s](state.query, state.page[s]))
    );

    let anyOk = false, freshItems = [];
    settled.forEach((res, i) => {
      const source = active[i];
      if (res.status === 'fulfilled') {
        anyOk = true;
        state.hasMore[source] = res.value.hasMore;
        state.page[source] += 1;
        res.value.items.forEach(b => {
          const key = (b.title + '|' + b.authors).toLowerCase().replace(/\s+/g, ' ').trim();
          if (state.seen.has(key)) return;
          state.seen.add(key);
          freshItems.push(b);
        });
      } else {
        state.hasMore[source] = false;
      }
    });

    if (state.mode === 'auto') freshItems = interleave(freshItems);

    state.results.push(...freshItems);
    const grid = document.getElementById('results-grid');

    if (!state.results.length) {
      if (!anyOk) {
        grid.innerHTML = `<div class="error-box"><i class="fa-solid fa-triangle-exclamation"></i>Couldn't reach the book sources. Check your connection and try again.</div>`;
      } else {
        document.getElementById('empty-search').classList.add('show');
      }
      return;
    }

    freshItems.forEach(b => grid.appendChild(bookCard(b)));

    document.getElementById('results-meta').classList.remove('hidden');
    document.getElementById('results-count').textContent = `${state.results.length} results for "${state.query}"`;

    const canLoadMore = Object.values(state.hasMore).some(Boolean);
    document.getElementById('load-more').classList.toggle('hidden', !canLoadMore);
  }

  function interleave(items){
    const bySource = { gutendex: [], openlibrary: [], google: [] };
    items.forEach(b => bySource[b.source] && bySource[b.source].push(b));
    const out = [];
    let i = 0;
    while (bySource.gutendex[i] || bySource.openlibrary[i] || bySource.google[i]) {
      if (bySource.gutendex[i]) out.push(bySource.gutendex[i]);
      if (bySource.openlibrary[i]) out.push(bySource.openlibrary[i]);
      if (bySource.google[i]) out.push(bySource.google[i]);
      i++;
    }
    return out;
  }

  document.getElementById('load-more').addEventListener('click', async () => {
    showLoader('search-loader', true);
    await fetchAndRender(false);
    showLoader('search-loader', false);
  });

  /* ---------------------------------------------------------- CARD RENDERING */
  const SOURCE_LABEL = { gutendex: 'Gutenberg', openlibrary: 'Open Library', google: 'Google Books' };

  function bookCard(b){
    const card = document.createElement('div');
    card.className = 'card glass';

    const coverHtml = b.cover
      ? `<img src="${esc(b.cover)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<i class=\\'fa-solid fa-book cover-fallback\\'></i>'">`
      : `<i class="fa-solid fa-book cover-fallback"></i>`;

    const metaBits = [b.year, b.publisher].filter(Boolean);

    let actionHtml = '';
    if (b.downloadUrl || b.iaId || b.epubUrl) {
      actionHtml = `<button class="btn-primary" data-action="download"><i class="fa-solid fa-file-pdf"></i> Download PDF</button>`;
    } else if (b.viewUrl) {
      actionHtml = `<button class="btn-ghost" data-action="view"><i class="fa-solid fa-arrow-up-right-from-square"></i> View</button>`;
    }

    card.innerHTML = `
      <div class="card-cover">${coverHtml}</div>
      <div class="card-body">
        <div class="card-body-inner">
          <span class="badge badge-${b.source}">${SOURCE_LABEL[b.source]}</span>
          <div class="card-title" title="${esc(b.title)}">${esc(b.title)}</div>
          <div class="card-line"><i class="fa-solid fa-user"></i>${esc(b.authors)}</div>
          ${metaBits.length ? `<div class="card-line"><i class="fa-solid fa-building-columns"></i>${esc(metaBits.join(' · '))}</div>` : ''}
        </div>
        <div class="btn-row">${actionHtml}</div>
      </div>`;

    const actionBtn = card.querySelector('[data-action]');
    if (actionBtn) {
      actionBtn.addEventListener('click', () => {
        if (actionBtn.dataset.action === 'download') {
          addToDownloadQueue(b);
        } else {
          window.open(b.viewUrl, '_blank', 'noopener');
        }
      });
    }
    return card;
  }

  /* ---------------------------------------------------------- HISTORY */
  function saveHistoryEntry(query, mode){
    history = history.filter(h => h.query.toLowerCase() !== query.toLowerCase());
    history.unshift({ query, mode, ts: Date.now() });
    history = history.slice(0, 40);
    localStorage.setItem(LS_HISTORY, JSON.stringify(history));
  }

  function renderHistory(){
    const list = document.getElementById('history-list');
    const empty = document.getElementById('empty-history');
    list.innerHTML = '';
    if (!history.length) { empty.classList.add('show'); return; }
    empty.classList.remove('show');

    history.forEach(h => {
      const row = document.createElement('div');
      row.className = 'row-item';
      row.innerHTML = `
        <i class="fa-solid fa-clock-rotate-left row-icon"></i>
        <div class="row-main">
          <div class="row-title">${esc(h.query)}</div>
          <div class="row-sub">${MODE_LABEL[h.mode] || 'All sources'}</div>
        </div>
        <span class="row-time">${timeAgo(h.ts)}</span>
        <button class="row-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.row-remove')) return;
        input.value = h.query;
        sourceDropdown.value = h.mode;
        state.mode = h.mode;
        goToSearchTab();
        runSearch();
      });
      row.querySelector('.row-remove').addEventListener('click', () => {
        history = history.filter(x => x.ts !== h.ts);
        localStorage.setItem(LS_HISTORY, JSON.stringify(history));
        renderHistory();
      });
      list.appendChild(row);
    });
  }

  const MODE_LABEL = { auto: 'All sources', gutendex: 'Gutenberg', openlibrary: 'Open Library', google: 'Google Books' };

  document.getElementById('clear-history-btn').addEventListener('click', () => {
    history = [];
    localStorage.setItem(LS_HISTORY, '[]');
    renderHistory();
  });

  /* ---------------------------------------------------------- LIBRARY / DOWNLOADS */
  function logDownload(b){
    downloads = downloads.filter(d => d.id !== b.id);
    downloads.unshift({ id: b.id, title: b.title, authors: b.authors, source: b.source, cover: b.cover, link: b.downloadUrl || b.viewUrl, ts: Date.now() });
    downloads = downloads.slice(0, 100);
    localStorage.setItem(LS_DOWNLOADS, JSON.stringify(downloads));
  }

  function renderLibrary(){
    const list = document.getElementById('library-list');
    const empty = document.getElementById('empty-library');
    list.innerHTML = '';
    if (!downloads.length) { empty.classList.add('show'); return; }
    empty.classList.remove('show');

    downloads.forEach(d => {
      const row = document.createElement('div');
      row.className = 'row-item';
      const coverHtml = d.cover
        ? `<img src="${esc(d.cover)}" alt="" onerror="this.parentElement.innerHTML='<i class=\\'fa-solid fa-book\\'></i>'">`
        : `<i class="fa-solid fa-book"></i>`;
      row.innerHTML = `
        <div class="row-cover">${coverHtml}</div>
        <div class="row-main">
          <div class="row-title">${esc(d.title)}</div>
          <div class="row-sub">${esc(d.authors)} · ${SOURCE_LABEL[d.source] || ''}</div>
        </div>
        <span class="row-time">${timeAgo(d.ts)}</span>
        <button class="row-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.row-remove')) return;
        window.open(d.link, '_blank', 'noopener');
      });
      row.querySelector('.row-remove').addEventListener('click', () => {
        downloads = downloads.filter(x => x.id !== d.id);
        localStorage.setItem(LS_DOWNLOADS, JSON.stringify(downloads));
        renderLibrary();
      });
      list.appendChild(row);
    });
  }

  document.getElementById('clear-library-btn').addEventListener('click', () => {
    downloads = [];
    localStorage.setItem(LS_DOWNLOADS, '[]');
    renderLibrary();
  });

  /* ---------------------------------------------------------- DOWNLOADS QUEUE VIEW RENDER */
  function renderDownloadsQueue(){
    const list = document.getElementById('downloads-queue-list');
    const empty = document.getElementById('empty-downloads');
    if (!list) return;

    list.innerHTML = '';
    if (!downloadQueue.length) { empty.classList.add('show'); return; }
    empty.classList.remove('show');

    downloadQueue.forEach(t => {
      const row = document.createElement('div');
      row.className = 'row-item';
      const coverHtml = t.book.cover
        ? `<img src="${esc(t.book.cover)}" alt="" onerror="this.parentElement.innerHTML='<i class=\\'fa-solid fa-book\\'></i>'">`
        : `<i class="fa-solid fa-book"></i>`;

      let iconStatus = '<i class="fa-solid fa-hourglass-start row-icon"></i>';
      if (t.status === 'downloading') iconStatus = '<i class="fa-solid fa-spinner fa-spin row-icon" style="color:var(--cyan)"></i>';
      if (t.status === 'completed') iconStatus = '<i class="fa-solid fa-circle-check row-icon" style="color:var(--emerald)"></i>';
      if (t.status === 'failed') iconStatus = '<i class="fa-solid fa-triangle-exclamation row-icon" style="color:var(--danger)"></i>';

      row.innerHTML = `
        <div class="row-cover">${coverHtml}</div>
        <div class="row-main">
          <div class="row-title">${esc(t.book.title)}</div>
          <div class="row-sub">${iconStatus} ${esc(t.statusText)}</div>
          ${t.status === 'downloading' ? `
            <div class="task-progress-wrap">
              <div class="task-progress-bar" style="width:${t.progress}%"></div>
            </div>` : ''}
        </div>
        <span class="row-time">${timeAgo(t.addedAt)}</span>
        <button class="row-remove" title="Cancel/Remove"><i class="fa-solid fa-xmark"></i></button>`;

      row.querySelector('.row-remove').addEventListener('click', () => {
        downloadQueue = downloadQueue.filter(x => x.id !== t.id);
        renderDownloadsQueue();
        updateDockDownloadStatus();
      });

      list.appendChild(row);
    });
  }

  document.getElementById('clear-queue-btn').addEventListener('click', () => {
    downloadQueue = downloadQueue.filter(t => t.status === 'downloading');
    renderDownloadsQueue();
    updateDockDownloadStatus();
  });

  /* ---------------------------------------------------------- TRENDING */
  async function loadTrending(){
    showLoader('trending-loader', true);
    document.getElementById('empty-trending').classList.remove('show');
    const grid = document.getElementById('trending-grid');
    grid.innerHTML = '';
    try {
      const { items } = await fetchGutendex('', 1);
      showLoader('trending-loader', false);
      if (!items.length) { document.getElementById('empty-trending').classList.add('show'); return; }
      items.forEach(b => grid.appendChild(bookCard(b)));
    } catch (err) {
      showLoader('trending-loader', false);
      grid.innerHTML = `<div class="error-box"><i class="fa-solid fa-triangle-exclamation"></i>Couldn't load trending books right now.</div>`;
    }
  }
  document.getElementById('trending-refresh').addEventListener('click', loadTrending);

  /* ---------------------------------------------------------- UTIL */
  function showLoader(id, on){ document.getElementById(id).classList.toggle('show', on); }

})();