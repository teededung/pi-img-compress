# pi-img-compress

Auto-compress pasted and referenced local images into Pi `ImageContent` attachments using Pi's built-in `resizeImage`, with atomic clickable `[imageN]` placeholders in the Pi TUI editor.

## Features

- **Automatic Image Compression**: Resizes and compresses pasted, dragged, or path-referenced local images (`.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, `.bmp`) as well as oversized pre-attached images (`maxEdge: 1600px`, `maxBytes: 1.5 MB`, `jpegQuality: 80`).
- **Atomic `[imageN]` Editor Placeholders**: Intercepts terminal image path pastes (including Orca `orca-paste-*.png` temp files and drag-and-drop paths with escaped spaces) and inserts atomic `[image1]`, `[image2]` tokens — backspace, delete, cursor movement, and word-wrap treat the whole token as a single unit.
- **Clickable Hyperlinks**: Renders `[imageN]` as an OSC 8 `file://` hyperlink while typing in the editor, and converts it to a clickable Markdown link `[[imageN]](file://...)` on submit.
- **SHA-256 Deduplication & Temp Cleanup**: Deduplicates identical pasted images within a turn, reuses placeholder indices when removed from the editor, and cleans up orphaned `orca-paste-*` temporary files automatically.
- **Safe Magic-Byte Verification**: Validates file headers (`PNG`, `JPEG`, `GIF`, `WEBP`, `BMP`) and ignores remote `http(s)://` URLs or non-image files.

## Installation

```bash
pi install npm:pi-img-compress
# or from GitHub
pi install git:github.com/teededung/pi-img-compress
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:pi-img-compress"
  ]
}
```

## Defaults

| Setting | Default |
| --- | --- |
| Max edge (`IMAGE_MAX_EDGE`) | `1600` px |
| Max payload (`IMAGE_MAX_BYTES`) | `1,500,000` bytes (~1.5 MB) |
| JPEG quality (`IMAGE_JPEG_QUALITY`) | `80` |
| Max source file size | `25 MB` |
| Max images per turn | `8` |

## More Pi Extensions

| Package | Description | Install |
| --- | --- | --- |
| [pi-agy-provider](https://github.com/teededung/pi-agy-provider) | Antigravity (`agy`) provider & multi-agent orchestrator (`/swarm`, `/boost`, `/teamwork`, `/btw`) | `pi install npm:pi-agy-provider` |
| [pi-md-render](https://github.com/teededung/pi-md-render) | Streaming-first rich Markdown, code, Mermaid & LaTeX rendering for the Pi TUI | `pi install npm:pi-md-render` |
| [pi-session-sweep](https://github.com/teededung/pi-session-sweep) | Session management & cleanup with native `agy` conversation cleanup | `pi install npm:pi-session-sweep` |
| [pi-img-compress](https://github.com/teededung/pi-img-compress) | Auto-compress pasted & referenced local images with atomic `[imageN]` editor links | `pi install npm:pi-img-compress` |

## License

MIT
