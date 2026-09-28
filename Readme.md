# AI Exporter

A Chrome extension that exports your ChatGPT conversations to Markdown, plain text, JSON, or CSV, so you can keep a copy, share it, or drop it straight into a GitHub repo.

## Why this exists

Most ChatGPT export tools scrape the page's DOM. They scroll through the conversation, grab whatever text is currently rendered, and hope nothing gets missed. That approach is fragile: ChatGPT virtualizes long conversations (it only keeps a portion of messages in the DOM at once), so scroll-based scrapers routinely drop messages or get the order wrong, especially on longer chats.

AI Exporter takes a different approach. It talks to the same conversation API that the ChatGPT web app itself uses, paginating through the full message history and reconstructing the actual conversation tree. ChatGPT stores branches (regenerated replies, edited messages) and this walks the correct path through them using each message's parent pointer. The result is a complete, correctly ordered export, no matter how long the conversation is or how many times you regenerated a response.

## What it does

- **Copy** the current conversation to your clipboard as Markdown.
- **Export** it as `.md`, `.txt`, `.json`, or `.csv`.
- Keep the original text-only behavior for images by default. Optionally enable **Bundle downloaded images with exports as a ZIP** in Settings → Downloads to download images and reference them by relative paths in the Markdown.
- **Select which messages to include** before exporting, filter to questions or answers only, or pick messages by hand.
- **Save it straight to a GitHub repo** (see below) instead of downloading it locally.
- Customize heading style, message spacing, and whether to include a timestamp, from the extension's settings page.
- Switch between Light, Dark, or System theme.
- Use the interface in English, Spanish, French, German, Russian, or Chinese, or let it follow your browser's language automatically.

## Installing it

### From the Chrome Web Store

The easiest way once it's published: search for "AI Exporter" in the Chrome Web Store and click Add to Chrome. If you're reading this before the listing goes live, use the manual steps below instead.

### Manually, from source

If you want to run the latest code, or the extension isn't live on the Web Store yet:

1. Clone the repo:
   ```bash
   git clone https://github.com/GrantTotinov/AIExporter.git
   cd AIExporter
   ```
2. Install dependencies and build:
   ```bash
   npm install
   npm run build:chrome
   ```
   This produces a `dist/` folder with the built extension.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top right corner).
5. Click **Load unpacked** and select the `dist/` folder.

The AI Exporter icon should now show up in your toolbar. If you don't see it, click the puzzle-piece icon next to the address bar and pin it.

Any time you pull new changes, re-run `npm run build:chrome` and then hit the reload icon for AI Exporter on `chrome://extensions`. Chrome doesn't pick up rebuilt files on its own.

## Using it

1. Open any conversation on `chatgpt.com`.
2. Click the AI Exporter icon.
3. Pick **Copy Conversation**, or open **Export ▾** to choose a format and, optionally, select specific messages first.

By default, image attachments are omitted from the export, matching the original text-only behavior; any text in the same message is preserved. To include local images, open **Settings → Downloads**, enable **Bundle downloaded images with exports as a ZIP**, and save the setting. Exports with images will then download as a ZIP. Unzip it and keep the conversation file and `images/` folder together so relative image links continue to work. Copy-to-clipboard keeps the original text-only behavior.

## Saving to GitHub

AI Exporter can commit an export directly into a repo instead of downloading it to disk.

1. Open the extension's **Settings** page and click **Connect GitHub**.
2. You'll get a short code and a new tab pointing at `github.com/login/device`. Enter the code there and approve access.
3. Back in the popup, the **GitHub** button next to Export now lets you pick a repo and save. Files land in an `exports/` folder at the root of whichever repo you choose. With image bundling enabled, selected images are saved in a ZIP with the Markdown file and its `images/` folder.

This uses GitHub's OAuth **device flow**, the same mechanism CLI tools like the GitHub CLI use to sign in. No password or personal access token ever touches the extension, just a short-lived code you type into GitHub's own site. Your access token is stored locally in your browser and never leaves your machine except to talk to `api.github.com`.

## A few notes

- AI Exporter only works on `chatgpt.com`. If OpenAI changes their internal API, exports may break until the extension gets updated. That's the trade-off of not relying on the visible page content.
- Image bundling downloads the image files into the ZIP so they work locally without a ChatGPT session.
- The GitHub integration needs `repo` access to create files, since GitHub's Contents API doesn't offer a narrower "just let me write files" scope. If that's more than you're comfortable granting, stick to the local export formats.
- This is a side project, maintained when time allows. Bug reports and pull requests are welcome. If something breaks, an exported conversation ID or a browser console log helps a lot when trying to reproduce it.

## Support

AI Exporter is free and independently maintained. If it's useful to you, starring the repo or buying me a coffee helps keep it going: [buymeacoffee.com/granttotinov](https://buymeacoffee.com/granttotinov).

Questions, bugs, or feature requests: open an issue on this repo, or email **granttotinov604@gmail.com** directly.

## Contributors
Ha1baraA11

## License

See [LICENSE](./LICENSE) for details.
