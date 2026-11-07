// Theme switching for the static mockups. Loaded in <head> so the theme applies before first paint.
// Precedence: ?theme=light|dark in the URL (used for screenshots), then the viewer's last choice,
// then the system setting. ?clean hides the mockup navigation bar.

;(() => {
  const KEY = 'valet-mockup-theme'
  const root = document.documentElement
  const params = new URLSearchParams(location.search)

  const read = () => {
    try {
      return localStorage.getItem(KEY)
    } catch {
      return null
    }
  }
  const write = (value) => {
    try {
      localStorage.setItem(KEY, value)
    } catch {
      // Storage can be blocked (private windows, file:// in some browsers); the toggle still works.
    }
  }

  const initial = params.get('theme') ?? read()
  if (initial === 'light' || initial === 'dark') root.dataset.theme = initial
  if (params.has('clean')) root.dataset.clean = ''

  const effective = () => {
    if (root.dataset.theme === 'light' || root.dataset.theme === 'dark') return root.dataset.theme
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-theme-toggle]') : null
    if (target === null) return
    const next = effective() === 'dark' ? 'light' : 'dark'
    root.dataset.theme = next
    write(next)
  })
})()
