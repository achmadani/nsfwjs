// Dimuat di <head> agar tema terpasang sebelum halaman digambar (tanpa kedip).
(function () {
  try {
    var saved = localStorage.getItem('nsfw-dashboard-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (error) {
    // localStorage tidak tersedia; ikuti tema sistem.
  }
})();
