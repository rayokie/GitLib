document.addEventListener('DOMContentLoaded', () => {
  const tabSearch = document.getElementById('tab-search-btn');
  const tabHistory = document.getElementById('tab-history-btn');
  const viewSearch = document.getElementById('search-view');
  const viewHistory = document.getElementById('history-view');
  
  window.switchTab = (tab) => {
    if (tab === 'search') {
      tabSearch.classList.add('active');
      tabHistory.classList.remove('active');
      viewSearch.classList.add('active');
      viewHistory.classList.remove('active');
    } else {
      tabHistory.classList.add('active');
      tabSearch.classList.remove('active');
      viewHistory.classList.add('active');
      viewSearch.classList.remove('active');
      if(window.renderHistory) window.renderHistory();
    }
  };

  tabSearch.addEventListener('click', () => window.switchTab('search'));
  tabHistory.addEventListener('click', () => window.switchTab('history'));

  document.getElementById('clear-all-history').addEventListener('click', () => {
    if (confirm('Clear all saved book downloads and history?')) {
      window.downloadHistory = [];
      localStorage.setItem('student_lib_download_history', JSON.stringify([]));
      if(window.renderHistory) window.renderHistory();
      if(window.updateHistoryBadge) window.updateHistoryBadge();
    }
  });
});

