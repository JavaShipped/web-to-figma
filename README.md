# Web to Figma

Capture a live web page (or one element) in Chrome and rebuild it in Figma as **editable design**:
auto layout frames (including Figma grid layout for CSS grid), real text with matched fonts, colour
variables named after the site's CSS tokens, text styles, and **components with variants** taken
from the site's own components.

Two parts:

- **Chrome extension** (`dist/extension`): walks the DOM and records what the browser rendered:
  boxes, computed styles, text runs, images, SVGs and component boundaries.
- **Figma plugin** (`dist/figma-plugin`): turns that capture into layers.

Everything runs locally. Captures never leave your machine, except as the JSON you paste into
Figma.

## Install

**Quickest: no build.** Download `web-to-figma-extension.zip` and `web-to-figma-plugin.zip` from
the [latest release](../../releases/latest) and unzip both. Then load them as below, picking the
unzipped folders instead of `dist/…`.

**From source** (Node 20+):

```bash
npm install
npm run build
```

> If npm installs Linux binaries for esbuild/TypeScript on Windows (a global `os = "linux"` npm
> setting), run `npm install --os=win32 --cpu=x64` instead.

**Extension:** open `chrome://extensions`, turn on Developer mode, click *Load unpacked*, and pick
`dist/extension`. Shortcut: Alt+Shift+F opens the popup.

**Plugin:** in the Figma desktop app, go to *Plugins → Development → Import plugin from manifest…*
and pick `dist/figma-plugin/manifest.json`.

## Use

1. On the page, open the extension and choose **Capture full page** or **Pick an element…**
   (↑ selects the parent, Enter or click captures, Esc cancels). The capture is copied to your
   clipboard, and the toast also offers a download as `.w2f.json`.
2. In Figma, run *Web to Figma*, click into its window and paste (Ctrl/⌘+V), or drop the file.
3. Click **Import**. The page frame lands beside your existing work, with a **Components** board
   next to it.

## How it decides structure

- **Auto layout.** Flex containers map directly: direction, gap, padding, alignment, wrap and
  grow. CSS grid becomes Figma grid auto layout. Stacked blocks become vertical auto layout.
  Spacing that isn't uniform (margins) becomes a transparent wrapper with leading padding.
  `margin-left: auto` becomes a wrapper that fills the free space and pushes its content to the
  end. Children are set to fill, hug or fixed from geometry. Containers whose content is
  width-driven stay fixed so their children can fill.
- **Components**, in priority order:
  1. React/Vue component names, in **dev builds**. Production builds minify the names.
  2. `data-component="Name"` (optional `data-component-props='{"variant":"primary"}'`).
  3. shadcn/ui's `data-slot` attributes, with `data-variant`, `data-size` and other `data-*`
     values as props.
  4. Repeated identical structures (same tags, classes and layout) used 2+ times.

  Props with a few distinct values become variant properties, e.g. Button `variant` × `size`.
  Small SVGs become icon components. Every occurrence becomes an instance, with its own text,
  fills and size kept as overrides.
- **Tokens.** Colours that match `:root` custom properties become variables named after them
  (`--color-blue-500` → `blue/500`). Other colours used 3+ times become `captured/HEX` variables.
  Type settings used 2+ times become text styles.

**Tip for work apps:** add `data-component` to your shared components, or run the dev build when
capturing, so components come through with their real names.

## Develop

```bash
npm run check      # type-check + unit tests + build + extension e2e (also runs on git push)
npm run test:e2e   # loads dist/extension into Playwright's Chromium and captures the fixture
npm run watch      # rebuild on change
npm run fixtures   # http://localhost:5178/fixtures/ with the capture harness loaded
```

On the fixture page, `await w2f.capture(selector?)` returns a capture, and `w2f.plan(doc)` shows
the layout plan and component groups the plugin will use, without Figma.

`scripts/figma-test-script.mjs` combines the headless plugin bundle (`dist/dev/headless.js`) with
a saved capture, so you can run the real builder through a scripted Plugin API context. The fixture
server saves captures POSTed to `/__save/<name>`.

The e2e test needs Playwright's Chromium (`npx playwright install chromium` on a fresh machine).

## Known gaps

- CSS transforms (rotation, scale) aren't applied. Elements land at their transformed bounding box.
- List bullets (`::marker`), conic gradients and blend modes aren't captured yet.
- Fonts that aren't installed in Figma fall back to Inter, and the plugin lists them after import.
- Instance overrides are best-effort: text, fills, strokes, effects, visibility, icon swaps and
  size. Structural differences become separate variants (`Layout=1/2`).
- Very large pages make large captures. Images are downscaled to 2× their displayed size.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md). Free to use, change and share for any noncommercial
purpose: personal projects, hackathons, learning, research, and use by charities, schools and
public bodies. Commercial use needs a separate license from the author.
