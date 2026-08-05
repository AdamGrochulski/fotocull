<div align="center">
  <img src="assets/logo.png" alt="fotocull" width="120" />

  <h1>fotocull</h1>
  <p>A photo culler that actually feels fast.</p>

  <a href="../../releases">
    <img src="https://img.shields.io/badge/⬇%20Download-Releases-3ddc84?style=for-the-badge&labelColor=0e1512" alt="Download" />
  </a>

  <br/><br/>

  <img src="https://img.shields.io/badge/Tauri_2-24C8DB?style=flat-square&logo=tauri&logoColor=white&labelColor=0e1512" alt="Tauri" />
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white&labelColor=0e1512" alt="Rust" />
  <img src="https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black&labelColor=0e1512" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white&labelColor=0e1512" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Canvas_2D-API-3ddc84?style=flat-square&labelColor=0e1512" alt="Canvas 2D" />
  <img src="https://img.shields.io/badge/license-MIT-3ddc84?style=flat-square&labelColor=0e1512" alt="MIT" />
</div>

---

Point it at a card. Swipe through the JPGs — keep or skip. The keepers, and their
RAW companions, land in a clean folder. **Nothing on the card is ever touched.**

Built for a **Sony A6000** workflow, where every frame is a pair — a RAW `.ARW`
and a `.JPG` — but it works with any folder of JPG/ARW files.

<div align="center">
  <img src="assets/hero.png" alt="Reviewing a shoot in fotocull" width="900" />
</div>

---

## Review at the speed of muscle memory

Every action is a key. Keep your hand on the arrows and blow through a shoot.

| | Action | Key |
|--|--------|-----|
| ✅ | Accept | `→` / `Space` |
| ❌ | Reject | `←` |
| ↩️ | Undo | `Backspace` / `U` |
| 🎞️ | Copy ARW too | `R` |
| ⊞ | Compare | `C` |
| 🟩 | Focus peaking | `P` |
| 🔍 | Fit / 100% | `F` / `1` |
| ➕ | Zoom | `+` / `−` |

Reject copies nothing — the source card stays exactly as it was. Accept copies
the JPG (and optionally its ARW) to your destination.

---

## Compare a burst

Shot the same frame four times? Hit **Compare**, pick the neighbours off the
filmstrip, and inspect them side by side — each pane is a full zoom / pan /
peaking inspector with its own EXIF, ARW toggle and rename. Keep the sharpest,
drop the rest, all in one screen.

<div align="center">
  <img src="assets/compare.png" alt="Side-by-side compare mode" width="900" />
</div>

---

## Never see the same photo twice

fotocull identifies photos by **content, not name**. Each JPG's SHA-256 lives in
a hidden `.fotocull/manifest.json` in the destination.

- Already copied? Hidden on the next scan — **even if you renamed it.**
- Rejected? Added to a permanent skip-list — it won't come back.
- Quit halfway through? Your decisions are saved per destination; the review
  **resumes where you left off.**

---

## Inspect before you commit

<div align="center">
  <img src="assets/inspect.png" alt="Zoom and focus peaking" width="900" />
</div>

- **Zoom & pan** on a Canvas 2D stage — cursor-anchored wheel, drag to pan, Fit / 100%.
- **Focus peaking** — a Sobel gradient overlay paints sharp edges green, so you
  judge focus by eye. Off by default: no green on the photo while you read
  exposure and colour.
- **Exposure readout** — clipped-highlight / crushed-shadow flags from the
  luminance histogram.
- **EXIF at a glance** — aperture, shutter, ISO, focal length and lens, per frame.
- **Rename autocomplete** — names you've used before for this destination come
  back as `Tab`-to-complete suggestions.

---

## Where your keepers go

```
DESTINATION/
├── jpg/          # default-named JPGs
├── raw/          # default-named ARWs
└── unique/       # renamed photos
    ├── jpg/
    └── raw/
```

Rename a photo and its pair moves to `unique/`. Name clashes get a shared
`_1`, `_2`, … suffix across the JPG **and** ARW, so a pair always keeps a common
base name.

---

## Under the hood

Rust does the heavy lifting; nothing blocks the UI:

- **Content dedup** — SHA-256 per JPG in a `.fotocull/manifest.json` container
- **Parallel hashing** — `rayon` across every core (a card of ~400 RAW+JPG pairs)
- **Atomic manifest** — temp-write + rename, so a crash mid-copy can't corrupt it
- **Focus peaking** — Sobel gradient magnitude on a downscaled luma buffer
- **EXIF** — `kamadak-exif`, straight off the JPG
- **Read-only source** — the card is scanned, hashed and copied *from* — never written to

Windows · macOS · Linux, all from one Tauri 2 codebase.

---

## Run it from source

Needs Node 20+ and a Rust toolchain. On Linux also the WebKitGTK dev libs
(`libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `patchelf`).

```bash
npm install
npm run tauri dev      # develop
npm run tauri build    # native installers → src-tauri/target/release/bundle/
```

Build Windows installers natively on Windows (WebView2 + MSVC). Pushing a `v*`
tag runs the release workflow — Windows, Linux and macOS (x64 + arm64) installers,
straight to GitHub Releases.

---

## What's next

- [x] Keyboard-first review
- [x] Side-by-side compare
- [x] Session resume + permanent reject skip-list
- [ ] Signed installers (SmartScreen / Gatekeeper clean)
- [ ] Optional ARW-decoded preview

---

<div align="center">
  <sub>Made by <a href="https://github.com/AdamGrochulski">octoone</a> &nbsp;·&nbsp; MIT</sub>
</div>
