<div align="center">
  <img src="assets/logo.png" alt="fotocull" width="120" />
  <h1>fotocull</h1>
  <p>Desktop app for going through photos from a camera card and keeping the good ones.</p>
  <p><a href="../../releases/latest">Download the latest release</a></p>
</div>

fotocull scans an SD card (or any folder), shows the photos one by one or in a
grid, and copies the ones you accept to a destination folder. Nothing on the
card is ever modified or deleted.

I built it for a Sony A6000, which saves every shot as a `.JPG` plus a RAW
`.ARW`, and for the occasional `.MP4` clip. You review the JPG; the ARW can be
copied along with it. Any folder of JPG/ARW/MP4 files works.

<!-- TODO screenshot: assets/hero.png (no recognisable people) -->

## Install

Grab the file for your system from the [latest release](../../releases/latest):

- Windows: the file ending in `_x64-setup.exe`
- macOS (Intel and Apple silicon): the file ending in `_universal.dmg`
- Linux: the `.AppImage`, or the `.deb` on Debian/Ubuntu

The installers aren't code-signed yet, so the first launch needs one extra
click. On Windows, SmartScreen may warn: choose *More info* and *Run anyway*.
On macOS, open the app once, then go to *System Settings → Privacy & Security*
and click *Open Anyway*.

From version 1.2.0 the app updates itself: when a new version is out, the start
screen offers to install it.

## Using it

1. Pick the card (source) and a destination folder.
2. Scan. Photos already copied to that destination, or rejected there before,
   are skipped.
3. Go through the photos: accept, reject, or rename. Press `G` to switch to a
   grid of the whole shoot, where frames shot within two seconds of each other
   are stacked together.
4. Copy. You can copy at any point; undecided photos wait for the next session.

To pick the best frame of a burst, open several frames side by side with
`C`. With *Sync zoom* on, zooming into one frame zooms into all of them.

The scan screen also shows a short report on the shoot, read from EXIF: how
many photos were slower than 1/60 s, whether the camera kept hitting its Auto
ISO limit, which lenses were used stopped down. If something stands out, it
suggests what to change in the camera next time.

Video clips from the same card get their own tab with the same accept, reject
and rename flow.

## Keyboard

| Key | Action |
|-----|--------|
| `→` `A` `Space` | Accept |
| `←` `X` | Reject |
| `Backspace` `U` | Back to the previous photo |
| `R` | Also copy the ARW |
| `G` | Grid / single view |
| `C` | Compare |
| `P` | Focus peaking (highlights sharp edges) |
| `F` / `1` | Fit / 100% |
| `+` / `−` | Zoom |
| `L` | Keep the zoom when moving to the next photo |
| `?` | All shortcuts |

In the grid: arrows move, `Shift` and `Ctrl` select, `A` / `X` decide for the
whole selection, `0` clears, `Enter` opens a photo.

Holding a key down doesn't run through photos; each decision needs its own
key press.

## Where the files go

```
DESTINATION/
├── jpg/        photos with their original name
├── raw/        their ARW files
├── video/      clips
└── unique/     renamed photos and clips (jpg/, raw/, video/)
```

If a name is already taken, both files of a pair get the same `_1`, `_2`, ...
suffix. Characters a file name can't contain are replaced with `-`, so
"Meeting 14/10" is saved as `Meeting 14-10`.

## Duplicates and sessions

Photos are recognised by content (SHA-256), not by name. The destination keeps
a hidden `.fotocull/manifest.json` of everything copied there, so a photo
doesn't show up again on the next scan, even after it was renamed. Rejected
photos are remembered per destination and stay hidden too. If you quit in the
middle, the review continues where you stopped.

## How it works

Tauri 2 with a Rust backend and a React + TypeScript frontend.

- The card is only read. Each file is hashed once, together with its EXIF, and
  the result is cached until the file changes, so scanning the same card again
  takes a moment.
- A JPG and an ARW form a pair only inside one folder, because cameras reuse
  file numbers across folders.
- Every photo gets a 2560 px preview and a thumbnail, generated once and kept
  in the app's cache folder. The photos next to the current one are kept
  decoded, so moving between them is instant. The original JPG is loaded only
  when you zoom in further than the preview allows.
- Copies are written under a temporary name, compared with the source by
  hash and only then renamed. If the ARW of a pair fails, its JPG is removed
  again. The manifest is written to a temporary file, flushed and renamed.

## Building

You need Node 20+ and a Rust toolchain. On Linux also the WebKitGTK dev
libraries (`libwebkit2gtk-4.1-dev`, `librsvg2-dev`, `patchelf`).

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # build installers into src-tauri/target/release/bundle/
```

Build the Windows installer on Windows (WebView2 + MSVC). Pushing a `v*` tag
runs the release workflow, which builds for Windows, macOS and Linux and
creates a draft release on GitHub.

## License

MIT
