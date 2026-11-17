# Business OS — AsroTravel Typography Discovery & Integration Specification

## 1. Real Asset Discovery from AsroTravel (`https://asrotravel.com`)
Inspected live production assets from AsroTravel (`https://asrotravel.com`, `https://asrotravel.com/manifest.webmanifest`, and `https://panel.asrotravel.com/dist/frontend/css/rtl.css`):

- **Primary Persian Font Family**: **`Yekan Bakh`** (declared as `font-family: bakh`)
  - Weights discovered in live CSS `@font-face` rules: `100` (Thin), `300` (Light), `400 / normal` (Regular), `500` (Medium), `700 / bold` (Bold)
  - Formats discovered: `WOFF2`, `WOFF`, `TTF`, `EOT` (`font-display: swap`)
- **Secondary Fallback Font Family**: **`IRANSansWeb`** (`WOFF`, `TTF`, `EOT`)
- **Brand Theme Accent Discovered**: `#863bff` (from `https://asrotravel.com/manifest.webmanifest`)

## 2. Font Licensing Audit & Lawful Integration Decision (§3.4)
- Both **Yekan Bakh** (FontIran / Reza Bakhshandeh) and **IRANSans** (FontIran / Moslem Ebrahimi) are **proprietary commercial Persian typefaces** that require a valid paid commercial license for bundling in web apps or Android APKs.
- Per Master Prompt 06 §3.4, Business OS **does NOT pirate or unlawfully redistribute proprietary font binaries** from AsroTravel.
- Instead, Business OS implements a **licensed-first + lawful OFL fallback architecture**:
  1. **CSS Font Stack**: `"Yekan Bakh", "bakh", "IRANSansWeb", var(--font-vazirmatn), "Vazirmatn", system-ui, sans-serif`
  2. **Drop-In Licensed Slot**: Once the organization purchases a FontIran license for `Yekan Bakh`, placing the licensed `.woff2` files in `public/fonts/yekan-bakh/` (Web) and `app/src/main/res/font/yekan_bakh_*.ttf` (Android) activates `Yekan Bakh` globally across UI, charts, tables, and printable PDFs with zero code refactoring.
  3. **Bundled Lawful Fallback**: **`Vazirmatn`** (SIL Open Font License 1.1 — 100% free for commercial web, Android, and PDF embedding) loaded via `next/font/google` in weights `300, 400, 500, 600, 700, 800`.

## 3. Typography Scale & Tabular Numerics
- **Financial Figures**: Always styled with `font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1, "lnum" 1;` so currency columns align perfectly across tables, trial balances, and PDF invoices.
- **Hierarchy**: Display (`24–32px`), Headline (`20px`), Title (`16px`), Body (`14px`), Label (`12px`), Caption (`11px`).
- **Consistency**: Applied identically in Next.js Admin/Org UI (`src/app/globals.css`), printable RTL PDF templates (`/api/v1/documents/pdf`), and Android Compose Typography specification.
