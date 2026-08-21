// Local Storage Keys
const STORAGE_HISTORY_KEY = 'student_lib_download_history';
const STORAGE_SEARCHES_KEY = 'student_lib_search_history';

window.searchHistory = JSON.parse(localStorage.getItem(STORAGE_SEARCHES_KEY)) || [];
window.downloadHistory = JSON.parse(localStorage.getItem(STORAGE_HISTORY_KEY)) || [];
let debounceTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  updateHistoryBadge();
  const searchSubmit = document.getElementById('search-submit');
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search');
  const autocompleteDropdown = document.getElementById('autocomplete-dropdown');
  
  if (searchSubmit) searchSubmit.addEventListener('click', executeSearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (autocompleteDropdown) autocompleteDropdown.classList.add('hidden');
        executeSearch();
      }
    });
    searchInput.addEventListener('input', handleInputChange);
    searchInput.addEventListener('focus', handleInputFocus);
  }

  document.addEventListener('click', (e) => {
    if (autocompleteDropdown && !e.target.closest('.search-box-wrapper')) {
      autocompleteDropdown.classList.add('hidden');
    }
  });

  if (clearSearchBtn) {
    clearSearchBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      clearSearchBtn.classList.add('hidden');
      if (autocompleteDropdown) autocompleteDropdown.classList.add('hidden');
      if (searchInput) searchInput.focus();
    });
  }
});

function setProgress(percent) {
  const bar = document.getElementById('progress-bar');
  if (bar) bar.style.width = percent + '%';
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

function updateHistoryBadge() {
  const badge = document.getElementById('history-count');
  if (badge) badge.textContent = window.downloadHistory.length;
}

function handleInputChange() {
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search');
  if (!searchInput) return;
  
  const query = searchInput.value.trim();
  if (clearSearchBtn) clearSearchBtn.classList.toggle('hidden', query.length === 0);
  
  clearTimeout(debounceTimer);
  if (query.length < 2) { showRecentSearches(); return; }
  debounceTimer = setTimeout(() => fetchLiveSuggestions(query), 300);
}

function handleInputFocus() {
  const searchInput = document.getElementById('search-input');
  if (searchInput && searchInput.value.trim().length === 0) showRecentSearches();
}

function showRecentSearches() {
  const dropdown = document.getElementById('autocomplete-dropdown');
  if (!dropdown) return;
  if (window.searchHistory.length === 0) { dropdown.classList.add('hidden'); return; }
  
  let html = `<div class="autocomplete-header"><i class="fa-solid fa-clock"></i> Recent Searches</div>`;
  window.searchHistory.slice(0, 5).forEach((term) => {
    html += `<div class="autocomplete-item" onclick="selectSuggestion('${escapeHTML(term)}')">
      <i class="fa-solid fa-magnifying-glass"></i><span>${escapeHTML(term)}</span></div>`;
  });
  dropdown.innerHTML = html;
  dropdown.classList.remove('hidden');
}

async function fetchLiveSuggestions(query) {
  const dropdown = document.getElementById('autocomplete-dropdown');
  if (!dropdown || location.protocol === 'file:') return; 
  
  try {
    const res = await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5&fields=title,author_name`);
    const data = await res.json();
    if (!data.docs || data.docs.length === 0) { dropdown.classList.add('hidden'); return; }
    
    let html = `<div class="autocomplete-header"><i class="fa-solid fa-lightbulb"></i> Book Suggestions</div>`;
    data.docs.forEach((doc) => {
      const author = doc.author_name ? doc.author_name[0] : '';
      const exactSearch = author ? `${doc.title} ${author}` : doc.title;
      
      html += `<div class="autocomplete-item" onclick="selectSuggestion('${escapeHTML(exactSearch)}')">
        <i class="fa-solid fa-book"></i>
        <span><b>${escapeHTML(doc.title)}</b> <small style="color:var(--text-muted);">${escapeHTML(author ? `by ${author}` : '')}</small></span>
      </div>`;
    });
    dropdown.innerHTML = html;
    dropdown.classList.remove('hidden');
  } catch (err) {
    console.warn('Suggestions failed:', err.message);
  }
}

window.selectSuggestion = function (term) {
  const searchInput = document.getElementById('search-input');
  const dropdown = document.getElementById('autocomplete-dropdown');
  const clearSearchBtn = document.getElementById('clear-search');
  
  if (searchInput) searchInput.value = term;
  if (dropdown) dropdown.classList.add('hidden');
  if (clearSearchBtn) clearSearchBtn.classList.remove('hidden');
  executeSearch();
};
// -------------------------------------------------------------
// ASYNC WATERFALL SEARCH LOGIC
// -------------------------------------------------------------
async function executeSearch() {
  const input = document.getElementById('search-input');
  if (!input) return;
  const query = input.value.trim();
  if (!query) return;

  window.searchHistory = window.searchHistory.filter(q => q.toLowerCase() !== query.toLowerCase());
  window.searchHistory.unshift(query);
  if (window.searchHistory.length > 10) window.searchHistory.pop();
  localStorage.setItem(STORAGE_SEARCHES_KEY, JSON.stringify(window.searchHistory));

  const radio = document.querySelector('input[name="api-source"]:checked');
  const selectedSource = radio ? radio.value : 'auto';
  
  const grid = document.getElementById('book-grid');
  const loader = document.getElementById('loader');
  const resultsHeader = document.getElementById('results-header');
  const resultsCount = document.getElementById('results-count');
  
  if (grid) grid.innerHTML = '';
  if (resultsHeader) resultsHeader.classList.add('hidden');
  if (loader) loader.classList.remove('hidden');
  setProgress(10);

  let totalBooksFound = 0;
  
  const appendBooks = (newBooks) => {
    if (!newBooks || newBooks.length === 0) return;
    totalBooksFound += newBooks.length;
    if (resultsHeader) resultsHeader.classList.remove('hidden');
    if (resultsCount) resultsCount.textContent = `${totalBooksFound} found`;
    if (grid) grid.insertAdjacentHTML('beforeend', newBooks.map(b => createBookCard(b)).join(''));
  };

  let completedTasks = 0;
  const targetTasks = selectedSource === 'auto' ? 4 : 1;
  
  const markTaskDone = () => {
    completedTasks++;
    setProgress(10 + (completedTasks / targetTasks) * 90);
    if (completedTasks === targetTasks) {
      if (loader) loader.classList.add('hidden');
      if (totalBooksFound === 0 && grid) grid.innerHTML = `<div class="empty-state"><i class="fa-solid fa-ghost"></i><p>No books found.</p></div>`;
    }
  };

  try {
    if (selectedSource === 'auto') {
      fetchGutendex(query).then(b => { appendBooks(b); markTaskDone(); }).catch(markTaskDone);
      fetchGoogleBooks(query).then(b => { appendBooks(b); markTaskDone(); }).catch(markTaskDone);
      fetchOpenLibrary(query).then(b => { appendBooks(b); markTaskDone(); }).catch(markTaskDone);
      fetchLibgen(query).then(b => { appendBooks(b); markTaskDone(); }).catch(markTaskDone);
    } else {
      if (selectedSource === 'gutendex') fetchGutendex(query).then(b => { appendBooks(b); markTaskDone(); });
      else if (selectedSource === 'openlibrary') fetchOpenLibrary(query).then(b => { appendBooks(b); markTaskDone(); });
      else if (selectedSource === 'google') fetchGoogleBooks(query).then(b => { appendBooks(b); markTaskDone(); });
      else if (selectedSource === 'libgen') fetchLibgen(query).then(b => { appendBooks(b); markTaskDone(); });
    }
  } catch (err) {
    if (grid) grid.innerHTML = `<div class="empty-state"><p>Network error.</p></div>`;
    if (loader) loader.classList.add('hidden');
  }
}

// 1. Library Genesis JSON API (with Cloudflare check)
async function fetchLibgen(query) {
  try {
    const searchUrl = `https://libgen.rs/search.php?req=${encodeURIComponent(query)}&res=25&view=simple&column=def`;
    const searchProxy = `https://corsproxy.io/?${encodeURIComponent(searchUrl)}`;
    const searchRes = await fetch(searchProxy);
    const htmlText = await searchRes.text();
    
    if (htmlText.includes('Cloudflare') || htmlText.includes('Just a moment...') || htmlText.includes('captcha-bypass')) {
      console.warn("Libgen blocked request via Cloudflare.");
      return []; 
    }
    
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const tables = Array.from(doc.querySelectorAll('table'));
    let table = tables.find(t => t.classList.contains('c')) || tables.find(t => t.querySelectorAll('tr').length > 3);
    if (!table) return [];
    
    const rows = Array.from(table.querySelectorAll('tr')).slice(1);
    const ids = [];
    rows.forEach(row => {
      const cols = row.querySelectorAll('td');
      if (cols.length > 0 && cols[0].textContent.trim() && !isNaN(cols[0].textContent.trim())) {
        ids.push(cols[0].textContent.trim());
      }
    });
    
    if (ids.length === 0) return [];
    
    const idString = ids.slice(0, 25).join(',');
    const jsonUrl = `https://libgen.rs/json.php?ids=${idString}&fields=id,title,author,year,publisher,extension,md5,coverurl`;
    const jsonProxy = `https://corsproxy.io/?${encodeURIComponent(jsonUrl)}`;
    const jsonRes = await fetch(jsonProxy);
    const books = await jsonRes.json();
    
    return books.map(b => ({
      id: `libgen_${b.id}`, title: b.title || 'Unknown Title', authors: b.author || 'Unknown Author',
      publisher: `${b.publisher || ''} ${b.year ? '('+b.year+')' : ''} [${(b.extension || '').toUpperCase()}]`.trim(),
      coverUrl: b.coverurl ? `https://libgen.rs/covers/${b.coverurl}` : '', source: 'Libgen', badgeClass: 'badge-libgen',
      actionLabel: 'Download / Mirror', actionUrl: b.md5 ? `https://libgen.rs/book/index.php?md5=${b.md5.toLowerCase()}` : '#', isDirectDownload: true
    }));
  } catch (e) { return []; }
}

// 2. Project Gutenberg
async function fetchGutendex(query) {
  try {
    const data = await (await fetch(`https://gutendex.com/books/?search=${encodeURIComponent(query)}`)).json();
    return (data.results || []).map(b => ({
      id: `guten_${b.id}`, title: b.title, authors: b.authors.map(a => a.name).join(', ') || 'Unknown Author',
      publisher: 'Project Gutenberg', coverUrl: b.formats['image/jpeg'] || '', source: 'Gutenberg', badgeClass: 'badge-gutenberg',
      actionLabel: 'Download EPUB', actionUrl: b.formats['application/epub+zip'] || `https://www.gutenberg.org/ebooks/${b.id}`, isDirectDownload: true
    }));
  } catch (e) { return []; }
}

// 3. Open Library
async function fetchOpenLibrary(query) {
  try {
    const data = await (await fetch(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=15`)).json();
    return (data.docs || []).map(b => ({
      id: `ol_${b.key.replace('/works/', '')}`, title: b.title, authors: b.author_name ? b.author_name.join(', ') : 'Unknown Author',
      publisher: b.publisher ? b.publisher[0] : 'Open Library Archive', coverUrl: b.cover_i ? `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` : '',
      source: 'Open Library', badgeClass: 'badge-openlibrary', actionLabel: 'Read / Borrow', actionUrl: b.ia ? `https://archive.org/details/${b.ia[0]}` : `https://openlibrary.org${b.key}`, isDirectDownload: false
    }));
  } catch (e) { return []; }
}

// 4. Google Books
async function fetchGoogleBooks(query) {
  try {
    const data = await (await fetch(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=15`)).json();
    return (data.items || []).map(b => ({
      id: `gb_${b.id}`, title: b.volumeInfo.title || 'Unknown Title', authors: b.volumeInfo.authors ? b.volumeInfo.authors.join(', ') : 'Unknown Author',
      publisher: b.volumeInfo.publisher || 'Google Books Index', coverUrl: b.volumeInfo.imageLinks ? (b.volumeInfo.imageLinks.thumbnail || '').replace('http:', 'https:') : '',
      source: 'Google Books', badgeClass: 'badge-google', actionLabel: 'Preview Book', actionUrl: b.volumeInfo.previewLink || b.volumeInfo.infoLink, isDirectDownload: false
    }));
  } catch (e) { return []; }
}

// -------------------------------------------------------------
// UI RENDERING & HISTORY
// -------------------------------------------------------------
function createBookCard(book, isHistory = false) {
  const safeJson = encodeURIComponent(JSON.stringify(book));
  const coverHTML = book.coverUrl 
    ? `<img src="${book.coverUrl}" alt="${escapeHTML(book.title)}" onerror="this.style.display='none'">` 
    : `<div style="padding:20px;text-align:center;color:#334155;height:100%;display:flex;align-items:center;justify-content:center;"><i class="fa-solid fa-book fa-2x"></i></div>`;
  
  return `
    <div class="book-card">
      <div class="book-cover">${coverHTML}</div>
      <div class="book-details">
        <div class="book-details-inner">
          <span class="badge ${book.badgeClass}">${book.source}</span>
          <h3 class="book-title">${escapeHTML(book.title)}</h3>
          <p class="book-author">${escapeHTML(book.authors)}</p>
          <p class="book-publisher">${escapeHTML(book.publisher)}</p>
        </div>
        <div style="display:flex; gap:8px;">
          <a href="${book.actionUrl}" target="_blank" class="btn-action" onclick="window.saveToHistory('${safeJson}')">
            <i class="fa-solid ${book.isDirectDownload ? 'fa-download' : 'fa-arrow-up-right-from-square'}"></i> ${book.actionLabel}
          </a>
          ${isHistory ? `<button class="btn-delete" onclick="window.removeFromHistory('${book.id}')"><i class="fa-solid fa-trash"></i></button>` : ''}
        </div>
      </div>
    </div>`;
}

window.saveToHistory = function(safeJson) {
  try {
    const book = JSON.parse(decodeURIComponent(safeJson));
    window.downloadHistory = window.downloadHistory.filter(i => i.id !== book.id);
    window.downloadHistory.unshift(book);
    localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(window.downloadHistory));
    updateHistoryBadge();
  } catch(e) { console.error("Error saving book:", e); }
};

window.removeFromHistory = function(id) {
  window.downloadHistory = window.downloadHistory.filter(b => b.id !== id);
  localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(window.downloadHistory));
  if (window.renderHistory) window.renderHistory();
  updateHistoryBadge();
};

window.renderHistory = function() {
  const grid = document.getElementById('history-grid');
  const empty = document.getElementById('history-empty');
  if (!grid || !empty) return;
  
  if (window.downloadHistory.length === 0) { 
    grid.innerHTML = ''; empty.classList.remove('hidden'); return; 
  }
  empty.classList.add('hidden');
  grid.innerHTML = window.downloadHistory.map(b => createBookCard(b, true)).join('');
};

