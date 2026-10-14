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
and a `.JPG` — plus the odd `.MP4` clip — but it works with any folder of
JPG/ARW/MP4 files.

> **First launch.** The installers aren't code-signed yet. On Windows,
> SmartScreen may warn: *More info → Run anyway*. On macOS, open the app once,
> then go to *System Settings → Privacy & Security* and click *Open Anyway*.
> After that fotocull keeps itself up to date: new versions are offered on the
> start screen and install with one click.

<!-- TODO screenshot: review screen — photo + filmstrip + EXIF + Reject/Accept
<div align="center">
  <img src="assets/hero.png" alt="Reviewing a shoot in fotocull" width="900" />
</div>
-->

---

## Review at the speed of muscle memory

Every action is a key. Keep your hand on the arrows and blow through a shoot.

| | Action | Key |
|--|--------|-----|
| ✅ | Accept | `→` / `A` / `Space` |
| ❌ | Reject | `←` / `X` |
| ↩️ | Undo | `Backspace` / `U` |
| 🎞️ | Copy ARW too | `R` |
| ▦ | Grid | `G` |
| ⊞ | Compare | `C` |
| 🟩 | Focus peaking | `P` |
| 🔍 | Fit / 100% | `F` / `1` |
| 🔒 | Keep zoom across photos | `L` |
| ➕ | Zoom | `+` / `−` |
| ❔ | All shortcuts | `?` |

Holding a key down never sweeps through photos: a verdict needs a fresh press.

Reject copies nothing — the source card stays exactly as it was. Accept copies
the JPG (and optionally its ARW) to your destination.

---

## See the whole shoot at once

Press **G** for a grid of every photo. Frames shot within two seconds of each
other stack into one cell, so a 700-photo event reads as a few hundred moments.
Select like in a file manager (click, `Shift`, `Ctrl`, arrows), then `A` keeps,
`X` rejects and `0` clears the lot. `C` on a stack opens its frames side by
side. Slow shutters are flagged on the tile, and **Copy** works from here at any
point; undecided photos simply wait for the next session.

---

## Compare a burst

Shot the same frame four times? Hit **Compare**, pick the neighbours off the
filmstrip, and inspect them side by side — each pane is a full zoom / pan /
peaking inspector with its own EXIF, ARW toggle and rename. Keep the sharpest,
drop the rest, all in one screen.
With **Sync zoom** on, zooming or panning one frame moves all of them, so you
check the same eyes in every shot.

<!-- TODO screenshot: compare mode — 3–4 frames side by side, one zoomed
<div align="center">
  <img src="assets/compare.png" alt="Side-by-side compare mode" width="900" />
</div>
-->

---

## Never see the same photo twice

fotocull identifies photos by **content, not name**. Each photo's SHA-256 lives in
a hidden `.fotocull/manifest.json` in the destination.

- Already copied? Hidden on the next scan — **even if you renamed it.**
- Rejected? Added to a permanent skip-list — it won't come back.
- Quit halfway through? Your decisions are saved per destination; the review
  **resumes where you left off.**

---

## Inspect before you commit

<!-- TODO screenshot: zoom at 100% with focus peaking ON (green edges)
<div align="center">
  <img src="assets/inspect.png" alt="Zoom and focus peaking" width="900" />
</div>
-->

- **Instant flipping**: each photo gets an upright 2560 px preview once, and the
  neighbours sit decoded in memory, so the next photo is a redraw. The full
  original is loaded only when you zoom past what the preview holds.
- **Zoom & pan** on a Canvas 2D stage: cursor-anchored wheel, drag to pan, Fit / 100%.
- **Focus peaking**: a Sobel gradient overlay paints sharp edges green, so you
  judge focus by eye. Off by default: no green on the photo while you read
  exposure and colour.
- **Exposure readout**: clipped-highlight / crushed-shadow flags from the
  luminance histogram.
- **EXIF at a glance**: aperture, shutter, ISO, focal length and lens, per frame.
- **Rename autocomplete**: names you've used before for this destination come
  back as `Tab`-to-complete suggestions.
  Characters a file name can't hold are swapped for `-`, so "Meeting 14/10"
  is saved as `Meeting 14-10`.

---

## Learn from the shoot

The scan screen ends with a **shoot report** built from the EXIF of every photo
on the card: how many frames were slower than 1/60 s, whether the camera sat at
its Auto ISO ceiling, which lenses were used stopped down, how much clipped.
When a pattern shows up it says what to change in the camera before the next
event, e.g. *raise the Auto ISO limit* or *open up the 35 mm*.

---

## Cull video too

Cameras drop `.MP4` clips on the same card. fotocull picks them up and gives them
a **Videos** tab beside the photos — same keep/reject/rename flow, an inline
player to scrub each clip, and the same content-hash skip-list so a copied clip
never shows up twice. Accepted clips land in `video/`.

---

## Where your keepers go

```
DESTINATION/
├── jpg/          # default-named JPGs
├── raw/          # default-named ARWs
├── video/        # default-named MP4 clips
└── unique/       # renamed items
    ├── jpg/
    ├── raw/
    └── video/
```

Rename a photo and its pair moves to `unique/`. Name clashes get a shared
`_1`, `_2`, … suffix across the JPG **and** ARW, so a pair always keeps a common
base name.

---

## Under the hood

Rust does the heavy lifting; nothing blocks the UI:

- **Content dedup**: SHA-256 per photo (the JPG, or the ARW when there's no JPG) in a `.fotocull/manifest.json`
- **One read per file**: hash and EXIF come from the same pass, and are cached
  while a file's path, size and mtime don't change, so rescanning a card takes
  a moment instead of re-reading every byte
- **Folder-aware pairing**: a JPG and ARW pair only within one folder, so
  reused file numbers (`100MSDCF` / `101MSDCF`) never get mixed up
- **Verified copies**: each file is written under a temporary name, checked
  against the source hash, then renamed; a failed ARW rolls its JPG back
- **Atomic manifest**: temp-write, flush + rename, so a crash or a yanked drive can't corrupt it
- **Previews**: DCT-scaled JPEG decode, SIMD resize, upright, cached in the app's cache folder
- **Focus peaking**: Sobel gradient magnitude on a downscaled luma buffer
- **EXIF**: `kamadak-exif`, straight off the JPG
- **Read-only source**: the card is scanned, hashed and copied *from*, never written to

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
- [x] Video (MP4) review tab
- [x] Grid with burst stacks, cached previews, shoot report
- [x] Automatic updates, one universal macOS build
- [ ] Signed installers (SmartScreen / Gatekeeper clean)
- [ ] Optional ARW-decoded preview

---

<div align="center">
  <sub>Made by <a href="https://github.com/AdamGrochulski">octoone</a> &nbsp;·&nbsp; MIT</sub>
</div>
