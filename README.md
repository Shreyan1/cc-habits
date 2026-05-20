# cc-habits-website

Marketing site and docs for [cc-habits](https://github.com/Shreyan1/cc-habits) — an open-source CLI that learns your coding style from your Claude Code edits and feeds it back into every session.

Static site, no build step. Open `index.html` directly or serve the folder.

## Local preview

```bash
python3 -m http.server 4321
# then open http://localhost:4321
```

## Structure

| File | Purpose |
|---|---|
| `index.html` | Landing page (self-contained, in-browser Babel) |
| `docs.html` | Documentation page |
| `styles.css` | Shared styles |
| `docs-styles.css` | Docs-only styles |
| `*.jsx` | Component source, inlined into the HTML |

## License

MIT — built by [Shreyan Basu Ray](https://github.com/Shreyan1).
