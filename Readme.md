# AI Exporter

A free browser extension for Chrome and Firefox that exports your ChatGPT, Claude and Gemini conversations to PDF, Markdown, plain text, JSON, or CSV, images included, so you can keep a copy, share it, or drop it straight into a GitHub repo. Everything happens locally, in your browser.

## Free, source-available, and local

- **Free.** No account, no subscription, no paid tier, no ads.
- **Local.** Conversations are read and turned into files right in your browser. There's no AI Exporter server and no analytics or tracking: the extension only talks to the chat service you're exporting from (ChatGPT, Claude or Gemini), to GitHub if you use the GitHub features, and to the browser's add-on store to check for updates. See the [privacy policy](./docs/privacy-policy.md).
- **Source-available.** The complete source code is here on GitHub, so you can read exactly what the extension does, build it yourself, or send a fix. It's free for personal and other noncommercial use (see [License](#license)).

## Why this exists

Most ChatGPT export tools scrape the page's DOM. They scroll through the conversation, grab whatever text is currently rendered, and hope nothing gets missed. That approach is fragile: ChatGPT virtualizes long conversations (it only keeps a portion of messages in the DOM at once), so scroll-based scrapers routinely drop messages or get the order wrong, especially on longer chats.

AI Exporter takes a different approach. It talks to the same conversation API that the ChatGPT web app itself uses, paginating through the full message history and reconstructing the actual conversation tree. ChatGPT stores branches (regenerated replies, edited messages) and this walks the correct path through them using each message's parent pointer. The result is a complete, correctly ordered export, no matter how long the conversation is or how many times you regenerated a response.

On `claude.ai` it works the same way: it asks Claude's own conversation API for the whole conversation, every branch included, and follows the branch you're currently viewing. On `gemini.google.com` it reads the conversation through the same internal API the Gemini web app uses, ten turns at a time, so long chats come out complete without any scrolling either.

## What it does

- **Works on ChatGPT, Claude and Gemini.** Open a conversation on `chatgpt.com`, `claude.ai` or `gemini.google.com` and export it.
- **Exports to five formats:** PDF, Markdown (`.md`), plain text (`.txt`), JSON, or CSV.
- **Exports images too.** PDFs embed them on the page; Markdown, text, JSON, and CSV exports come as a ZIP with an `images/` folder. It's opt-in, see [Images](#images).
- **Makes proper PDFs:** a header with the title and a link back to the conversation, a bookmark for every message, clickable links, tables, code blocks, and embedded fonts for Latin, Cyrillic, and Greek text. Page size, orientation, margins, font size, a table of contents, page numbers, and a footer line are all up to you (see [PDF settings](#pdf-settings)).
- **Keeps artifacts and documents:** code and documents Claude wrote in an artifact, and Gemini's Canvas and Deep Research documents, are exported with the reply that made them.
- **Copies** the whole conversation to your clipboard as Markdown in one click.
- **Lets you pick the messages** before exporting: tick them one by one, select all, only your questions, only the answers, or swap what's selected. Shift+click selects a range, and you can show messages in full to read them.
- **Saves straight to a GitHub repo** (see below) instead of downloading.
- **Fits your preferences:** heading style, spacing between messages, an optional export timestamp, and whether to ask where to save each file.
- Light, Dark, or System theme.
- Interface in English, Spanish, French, German, Russian, or Chinese, or following your browser's language automatically.

## Installing it

### Chrome

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/objkcakdcilfaphifjfcgfamlnnbinjc).

### From source (Chrome or Firefox)

To run the latest code, or to use it in Firefox:

1. Clone the repo:
   ```bash
   git clone https://github.com/GrantTotinov/AIExporter.git
   cd AIExporter
   ```
2. Install dependencies and build for your browser:
   ```bash
   npm install
   npm run build:chrome   # or: npm run build:firefox
   ```
   This produces a `dist/` folder with the built extension.
3. Load it:
   - **Chrome:** open `chrome://extensions`, turn on **Developer mode** (top right corner), click **Load unpacked**, and select the `dist/` folder.
   - **Firefox** (140 or newer): open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and select `dist/manifest.json`. Firefox removes temporary add-ons when it restarts, so load it again after a restart. If Firefox asks for access to `chatgpt.com`, `claude.ai` and `gemini.google.com`, allow it; the extension can't read conversations without it.

The AI Exporter icon should now show up in your toolbar. If you don't see it, click the extensions button next to the address bar and pin it.

Any time you pull new changes, rebuild and then reload the extension (the reload icon on `chrome://extensions`, or **Reload** on `about:debugging`), and refresh any open ChatGPT, Claude or Gemini tabs. The browser doesn't pick up rebuilt files on its own.

## Using it

1. Open any conversation on `chatgpt.com`, `claude.ai` or `gemini.google.com`.
2. Click the AI Exporter icon. The popup names the conversation it's about to save; on any other page it says what to open first.
3. Pick **Copy the whole chat**, or **Save as a file** to choose which messages to include and a file type: PDF, Markdown, plain text, JSON, or CSV. Each file type has a one-line explanation, and the popup remembers the one you used last.

Files are named after the site, the conversation, and the date, for example `claude-export-trip-ideas-2026-10-02.pdf`.

### Settings

Click **Settings** at the top of the popup. The settings are grouped into **Language & appearance**, **Saving files**, **Chat contents**, **PDF documents**, and **GitHub**, and the search box finds any of them by name. Point at the **?** next to a setting to see what it does, with a tip. Every change is saved as you make it, and **Restore default settings** at the bottom of the page puts everything back the way it was after installing.

### Images

By default, images are left out and exports are text-only; any text in the same message is kept. To include them, open **Settings → Chat contents** and turn on **Include pictures**. After that:

- **PDF** exports embed the images right in the document.
- **Markdown, text, JSON, and CSV** exports that contain images download as a ZIP. Unzip it and keep the conversation file and its `images/` folder together so the image links keep working.

Copy to clipboard always stays text-only.

### PDF settings

Open **Settings → PDF documents** to pick the text size, paper size (A4, Letter, or Legal), page direction, and margins, and to turn on page numbers, a table of contents, or a line of your own text on every page (for example "Prepared by Jane Doe").

## Saving to GitHub

AI Exporter can commit an export directly into a repo instead of downloading it to disk.

1. Open the extension's **Settings** page and click **Connect GitHub**.
2. You'll get a short code and a new tab pointing at `github.com/login/device`. Enter the code there and approve access.
3. Back in the popup, choose **Save as a file**, then **Save to GitHub instead** to pick a repo and save the selected messages as Markdown. Files land in an `exports/` folder at the root of whichever repo you choose. With image bundling enabled, selected images are saved in a ZIP with the Markdown file and its `images/` folder. The popup shows whether the repo is public or private, and asks again before saving into a public one.

This uses GitHub's OAuth **device flow**, the same mechanism CLI tools like the GitHub CLI use to sign in. No password or personal access token ever touches the extension, just a short-lived code you type into GitHub's own site. Your access token is stored locally in your browser and never leaves your machine except to talk to `api.github.com`.

## A few notes

- AI Exporter works on `chatgpt.com`, `claude.ai` and `gemini.google.com`. If OpenAI, Anthropic or Google change their internal APIs, exports may break until the extension gets updated. That's the trade-off of not relying on the visible page content.
- AI Exporter keeps itself up to date. The bottom of the popup shows the version you have and whether it's the latest; click it to check again. Once the browser has downloaded an update, AI Exporter installs it as soon as no export is running, instead of waiting for the next browser restart. Firefox asks you to approve an update that needs new permissions: press Ctrl+Shift+A, click ⚙ and choose **Check for Updates**.
- Claude exports include legacy artifacts (the code and documents made before Claude's September 2026 artifacts update), each as it stood at that reply. Claude's thinking and tool calls are left out, and attached files are listed by name.
- Gemini exports include Canvas and Deep Research documents, and generated images when image bundling is on. Gemini's thinking and the markup only its own interface uses (citation markers, suggested follow-ups, web image results, video cards) are left out, and attached files other than images are listed by name.
- Image bundling downloads the image files into the export so they work locally without a ChatGPT, Claude or Gemini session.
- The GitHub integration needs `repo` access to create files, since GitHub's Contents API doesn't offer a narrower "just let me write files" scope. If that's more than you're comfortable granting, stick to the local export formats.
- This is a side project, maintained when time allows. Bug reports and pull requests are welcome. If something breaks, an exported conversation ID or a browser console log helps a lot when trying to reproduce it.

## Contributing

Bug reports, ideas, and pull requests are welcome. [Contributing.md](./Contributing.md) explains how to get started, and contributions are made under the [Contributor License Agreement](./CLA.md). Everyone taking part in the project is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Contributors
Ha1baraA11

## Support

AI Exporter is free and independently maintained. If it's useful to you, starring the repo or buying me a coffee helps keep it going: [buymeacoffee.com/granttotinov](https://buymeacoffee.com/granttotinov).

Questions, bugs, or feature requests: open an issue on this repo, or email **granttotinov604@gmail.com** directly.

## License

AI Exporter is free to use, study, modify, and share for personal and other noncommercial purposes under the [PolyForm Noncommercial License 1.0.0](./LICENSE). Commercial use, such as selling it, offering a modified version as a paid product or service, or building a competing paid product on it, requires written permission; see [NOTICE.md](./NOTICE.md).
