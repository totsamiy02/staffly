// Run before the first paint. Keep the key in sync with app/theme/theme-store.ts.
(() => {
  let saved
  try { saved = localStorage.getItem('staffly.theme') } catch { /* Storage may be unavailable. */ }
  const theme = saved === 'light' || saved === 'dark' ? saved : window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
})()
