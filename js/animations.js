window.UI = {
  setProgress: (percent, sourceStatuses) => {
    const bar = document.getElementById('progress-bar');
    const sources = document.getElementById('progress-sources');
    if(bar) bar.style.width = percent + '%';
    if (sourceStatuses && sources) {
      sources.innerHTML = sourceStatuses.map(s => `<span class="src-pill ${s.status}">${s.icon} ${s.name}</span>`).join('');
    }
  },
  resetProgress: () => {
    const bar = document.getElementById('progress-bar');
    const sources = document.getElementById('progress-sources');
    if(bar) bar.style.width = '0%';
    if(sources) sources.innerHTML = '';
  },
  escapeHTML: (str) => {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
  }
};
