# Business OS — Glassmorphism Design System & Token Architecture

## 1. Six Standardized Glass Surface Variants (`src/app/globals.css`)
1. **Glass Primary (`.glass-primary`)**: Translucent primary dashboard cards, KPI summary cards, main action headers (`backdrop-filter: blur(16px)`, light `rgba(255,255,255,0.76)`, dark `rgba(15,23,42,0.72)`).
2. **Glass Secondary (`.glass-secondary`)**: Nested info tiles, alert strips, sub-panels (`blur(12px)`, light `0.58`, dark `0.56`).
3. **Glass Navigation (`.glass-nav`)**: Sticky top navigation bar (`blur(22px)`, light `0.80`, dark `0.82`).
4. **Glass Modal (`.glass-modal`)**: Drill-down modals, account closure previews, fiscal closing wizards (`blur(22px)`, light `0.90`, dark `0.92`, elevated shadow).
5. **Glass Input (`.glass-input`)**: Search inputs, date selectors, financial text fields with `#863bff` violet focus ring.
6. **Glass Data Surface (`.glass-data`)**: Dense accounting tables, ledgers, and trial balance grids using higher opacity (`0.88` light / `0.86` dark) to prioritize financial legibility over transparency.

## 2. Light, Dark & System Themes (`src/components/ThemeProvider.tsx`)
- Supports `system`, `light`, and `dark` preferences persisted in `localStorage` (`bos_theme_preference`).
- Dark mode uses dedicated slate-indigo translucent layers with subtle inner highlight borders (`inset 0 1px 0 rgba(255,255,255,0.06)`) rather than naive color inversion.

## 3. Performance & Accessibility
- Subtle fixed radial mesh canvas (`--bos-bg-mesh`) with zero distracting clutter.
- `prefers-reduced-motion: reduce` collapses transitions to `0.01ms`.
- Non-blur fallback degrades gracefully to clean semi-opaque cards on low-end GPUs.
- Statuses always pair semantic color with explicit icon + Persian text label (never color alone).
