# fotocull

Fast, keyboard-driven photo culling for camera shoots — a "photo Tinder" for your SD card.

Point it at a card, swipe through the JPGs, keep or reject, optionally rename, and
accepted shots (with their RAW companions) are copied to a destination folder.
Photos you've already copied are skipped by content hash, so every re-run only
shows what's new.

Built for a **Sony A6000** workflow, where each shot is a pair of files — a RAW
`.ARW` and a `.JPG` — but it works with any folder of JPG/ARW files.

## Features

- **Recursive scan** of the card; JPG + ARW files are paired by base name across
  subfolders (`DCIM/100MSDCF`, etc.).
- **Tinder-style review** with keyboard shortcuts: `→` keep, `←` reject,
  `Backspace` undo.
- **Photo inspector** (Canvas 2D): cursor-anchored zoom, drag pan, Fit / 100%.
- **Focus peaking** overlay — highlights sharp edges in green so you can judge
  focus at a glance. Off by default, so it never biases exposure/colour judgement.
- **Quality readouts** — blur (Laplacian variance) and exposure (luminance
  histogram) computed in Rust, off the UI thread.
- **Content-based dedup** — a hidden `.fotocull/manifest.json` in the destination
  maps each JPG's SHA-256 to what was copied, so already-copied photos are hidden
  on the next run, even if they were renamed.
- **Never touches the source** — all operations on the card are read-only.

## Destination layout

```
DESTINATION/
├── jpg/          # default-named JPGs
├── raw/          # default-named ARWs
└── unique/       # renamed photos
    ├── jpg/
    └── raw/
```

Name conflicts get a shared `_1`, `_2`, … suffix across the JPG/ARW pair so they
stay matched.

## Tech stack

- [Tauri 2](https://tauri.app/) — Rust backend (file I/O, hashing, image analysis)
- React + TypeScript + Vite — frontend
- Canvas 2D — preview, zoom, focus peaking

## Development

Requires Node 20+ and a Rust toolchain. On Linux you also need the WebKitGTK
dev libraries (`libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `patchelf`).

```bash
npm install
npm run tauri dev
```

## Building

```bash
npm run tauri build
```

Native installers land in `src-tauri/target/release/bundle/`. Windows builds
should be produced natively on Windows (WebView2 + MSVC). Pushing a `v*` tag
triggers the release workflow, which builds installers for Windows, Linux, and
macOS (x64 + arm64).

## License

MIT
