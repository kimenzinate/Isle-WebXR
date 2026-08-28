# Isle WebXR — first migration pass

This is a browser/WebXR port of the supplied `Isle-XR-main` visionOS prototype.

## Target

- Apple Vision Pro Safari: immersive WebXR (`immersive-vr`) with look + pinch selection.
- Desktop Safari/Chrome: mouse/orbit fallback for development and demos.
- Static hosting: GitHub Pages, Netlify, Vercel, Cloudflare Pages, etc.

## Included in this first pass

- WebXR scene and Vision Pro `select` ray handling.
- Original sky texture.
- Original `Island.usdz` and `Memory_Swiss.usdz` loaded with Three.js `USDLoader` when compatible.
- Original photo, video, audio and note assets.
- Tutorial flow.
- Heaven Isle memory selection.
- Photo detail / photo cinema.
- Video detail / video cinema.
- Jungfrau object detail / enlarged 3D view.
- Floating note memories.
- Surprise Me random bubbles.
- Voice Isle and audio playback.
- Exit / reflection / finish flow (voice recording is represented as a prototype save step for now).

## Run locally

WebXR and module imports require a web server; do not double-click `index.html` as a file.

From this folder:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

Internet access is currently required because Three.js is imported from jsDelivr.

## Test in Apple Vision Pro / visionOS Simulator

1. Serve this project over HTTPS for a real device (or use localhost in the simulator where appropriate).
2. Open the page in Safari on visionOS.
3. Press **Enter VR**.
4. Look at a target and pinch to select it.

Safari on visionOS supports WebXR `immersive-vr` and transient-pointer input for natural look + pinch interaction.

## Important migration note

Three.js `USDLoader` can load USD/USDZ, but USDZ compatibility depends on asset structure. If either original RealityKit asset fails in the browser, convert only that asset to `.glb` and replace the loader path. The rest of the project can stay unchanged.

## Next fidelity pass

The original Swift code contains much more precise layout, island clones, glass materials, paper depth, tutorial styling, and transitions. The next pass should focus on pixel/spatial matching rather than architecture: positions/scales, portal look, memory card glass, island placement, and reflection screens.

## v3.1
- Tutorial capsule button labels now use true horizontal/vertical centering, matching SwiftUI's fixed 68pt button frame.
- Gesture guide symbols are still temporary canvas approximations. The original Swift uses SF Symbols: `eye.fill`, `hand.pinch.fill`, and `arrow.up.left.and.arrow.down.right`. Drop-in SVG replacements will be used for exact web parity.

## v3.2 changes
- Added supplied `Gaze.svg`, `Pinch.svg`, and `Zoom.svg` under `assets/icons/`.
- Gesture tutorial now uses those exact SVG illustrations and the Figma `832:8280` layout dimensions.
- Button labels are vertically and horizontally centered in all WebXR-generated buttons.

## Local start (Mac)
After reopening Terminal:

```bash
cd ~/Downloads/Isle-WebXR
python3 -m http.server 8092 --bind 127.0.0.1
```

Then open `http://localhost:8092`.

Alternatively, double-click `START.command` and keep its Terminal window open.
