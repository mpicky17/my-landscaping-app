# my-landscaping-app — Development Rules

## Architecture
- Vanilla JS, no build step, no npm packages
- All CSS inline in `index.html` `<style>` block
- All JS in `app.js`
- CDN dependencies only (Leaflet, Firebase compat SDK)

## PWA Rules
- Bump `CACHE_NAME` in `sw.js` AND `APP_VERSION` in `app.js` on every deploy
- Format: `my-landscaping-v{N}` (both must match)

## iOS Rules
- All visible inputs must use `font-size: 1rem` (16px) minimum — prevents auto-zoom
- Use `signInWithPopup` (not redirect) for Firebase Auth — iOS PWA breaks on redirect

## Style
- Accent color: `#16a34a` (green)
- Dark mode: full `@media (prefers-color-scheme: dark)` block required
- `touch-action: manipulation` on all interactive elements

## After every update
- Push to GitHub (mpicky17/my-landscaping-app)
- GitHub Pages auto-deploys from main branch
