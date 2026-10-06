# AI Exporter

A free browser extension for Chrome, Edge and Firefox that exports your ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity, Copilot, Mistral Le Chat, Meta AI, Kimi, Doubao, Qwen, Qianwen, Yuanbao and Z.ai conversations to PDF, Word, HTML, a long image, Markdown, plain text, JSON, CSV or Excel, images included, so you can keep a copy, share it, cite it, carry it on in another AI, or drop it straight into a GitHub repo, a Notion page or a Google Doc. Everything happens locally, in your browser.

## Free, source-available, and local

- **Free.** No account, no subscription, no paid tier, no ads.
- **Local.** Conversations are read and turned into files right in your browser. There's no AI Exporter server and no analytics or tracking: the extension only talks to the chat service you're exporting from, to GitHub or Notion if you use those features, and to the browser's add-on store to check for updates. See the [privacy policy](./docs/privacy-policy.md).
- **Source-available.** The complete source code is here on GitHub, so you can read exactly what the extension does, build it yourself, or send a fix. It's free for personal and other noncommercial use (see [License](#license)).

## Why this exists

Most ChatGPT export tools scrape the page's DOM. They scroll through the conversation, grab whatever text is currently rendered, and hope nothing gets missed. That approach is fragile: ChatGPT virtualizes long conversations (it only keeps a portion of messages in the DOM at once), so scroll-based scrapers routinely drop messages or get the order wrong, especially on longer chats.

AI Exporter takes a different approach. It talks to the same conversation API that the ChatGPT web app itself uses, paginating through the full message history and reconstructing the actual conversation tree. ChatGPT stores branches (regenerated replies, edited messages) and this walks the correct path through them using each message's parent pointer. The result is a complete, correctly ordered export, no matter how long the conversation is or how many times you regenerated a response.

On `claude.ai` it works the same way: it asks Claude's own conversation API for the whole conversation, every branch included, and follows the branch you're currently viewing. On `gemini.google.com` it reads the conversation through the same internal API the Gemini web app uses, ten turns at a time, so long chats come out complete without any scrolling either.

DeepSeek, Grok and Perplexity are read the same way, through each site's own API: DeepSeek's message history and Grok's conversation tree, following the branch and the reply you're looking at, and Perplexity's thread, fifty questions at a time.

Microsoft Copilot, Kimi, Doubao, Qwen, Qianwen (Tongyi), Tencent Yuanbao and Z.ai (GLM) are also read through the API their own web apps use, with the sign-in you already have on the site. Mistral Le Chat and Meta AI have no such API that an extension can use, so there AI Exporter reads the conversation from the page itself: keep the whole chat loaded (scroll to its top once on a very long one) before exporting, and **Save many chats** isn't offered on those two sites.

## What it does

- **Works on fifteen AI chat sites:** ChatGPT (`chatgpt.com`), Claude (`claude.ai`), Gemini (`gemini.google.com`), DeepSeek (`chat.deepseek.com`), Grok (`grok.com`), Perplexity (`www.perplexity.ai`), Microsoft Copilot (`copilot.microsoft.com`), Mistral Le Chat (`chat.mistral.ai`), Meta AI (`www.meta.ai`), Kimi (`www.kimi.com`), Doubao (`www.doubao.com`), Qwen (`chat.qwen.ai`), Qianwen (`www.qianwen.com`), Tencent Yuanbao (`yuanbao.tencent.com`) and Z.ai (`chat.z.ai`). AI Exporter runs on these sites and nowhere else, and it only reads a conversation when you export, copy or save it.
- **Exports to nine formats:** PDF, Word (`.docx`), a single self-contained web page (`.html`), a long image (`.png`), Markdown (`.md`), plain text (`.txt`), JSON, CSV, or Excel (`.xlsx`). Word and HTML files keep the code's syntax colors, tables, links, formulas and the chat's images, all inside the one file, and the web page of a longer chat opens with a table of contents of its questions.
- **Formulas stay formulas in Word:** math in a reply becomes a real, editable Word equation (Office Math), not a picture, so it can be changed right in Word.
- **One long picture of the chat:** the image format renders the whole conversation the way the web page export shows it, ready for WhatsApp, WeChat, LINE or social media. A very long chat is cut between messages into several pictures, delivered together in a ZIP.
- **Excel workbooks:** every message is a row (who wrote it, what it says, and its date, model, thinking and sources when those are turned on), with a frozen, filterable header, and every table in the chat gets a sheet of its own, with numbers as real numbers.
- **Exports images too.** PDFs embed them on the page; Markdown, text, JSON, and CSV exports come as a ZIP with an `images/` folder. It's opt-in, see [Images](#images).
- **Makes proper PDFs:** a header with the title and a link back to the conversation, a bookmark for every message, clickable links, tables, code blocks, and embedded fonts for Latin, Cyrillic, Greek, Hebrew, Arabic, Chinese, Japanese and Korean text, and for Hindi and the other Indian scripts (Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam), Sinhala, Thai, Lao, Khmer and Myanmar. Those scripts are shaped with HarfBuzz, so conjuncts and vowel signs come out the way they should, and the text stays selectable and searchable in the PDF. Chinese and Japanese lines break between characters and follow the usual rules for punctuation at the start and end of a line. Hebrew, Arabic, and Persian replies read right to left, as on the chat page: lines are right-aligned, Arabic letters are joined, and English words and numbers inside them stay in the right order. Page size, orientation, margins, font size, a table of contents, page numbers, and a footer line are all up to you (see [PDF settings](#pdf-settings)).
- **Keeps math formulas readable:** formulas are typeset in PDFs, just like on the chat site (fractions, roots, matrices, equations), and written as `$...$` and `$$...$$` in Markdown, which Obsidian, GitHub, Typora and VS Code show as math. Each site's own way of marking math is understood, so a price like "$5" stays a price.
- **Ready for note apps:** Markdown files start with the chat's details (title, link, site, number of messages), which Obsidian and similar apps show as the note's properties. You can turn this off in **Settings → Chat contents**.
- **Keeps artifacts and documents:** code and documents Claude wrote in an artifact, and Gemini's Canvas and Deep Research documents, are exported with the reply that made them.
- **Keeps the sources:** when a reply looked things up on the web, its citations become small numbers with the list of pages under the reply: footnotes in Markdown, clickable numbers in PDF, Word, HTML and Notion, and the same goes for Deep Research reports. You can leave them out in **Settings → Chat contents**.
- **Can keep the AI's thinking:** turn on **The AI's thinking** in **Settings → Chat contents** to also save the step-by-step reasoning that thinking models show before they answer. It goes in a separate gray section ahead of the reply, folded away in Markdown.
- **Can note when and by which model:** turn on **Message dates and AI model** in **Settings → Chat contents** to write the date and time of every message next to it, and the AI model that wrote each answer when the site names it (ChatGPT and Gemini do). JSON and CSV files get `time` and `model` fields of their own, and Markdown files get `created`, `updated` and `models` properties for note apps.
- **Copies** the whole conversation to your clipboard in one click, as Markdown and as formatted text at once: pasted into Word, Google Docs or an email it keeps its headings, lists, tables and code; pasted into a notes app or a text box it's Markdown.
- **Keyboard shortcuts:** <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> opens AI Exporter, and <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> copies the open chat without opening anything. **Settings → Keyboard shortcuts** shows the keys you have and takes you to the browser's page for changing them.
- **Saves many chats at once:** **Save many chats** lists all your chats on the site, with a search and date filters, and saves the ones you tick into one ZIP file. It remembers which chats it saved, so the next time **Not saved yet, or changed since** picks just the new and changed ones, to keep a backup up to date.
- **Lets you pick the messages** before exporting: tick them one by one, select all, only your questions, only the answers, or swap what's selected. Shift+click selects a range, and you can show messages in full to read them.
- **Saves straight to a GitHub repo or a Notion page** (see below) instead of downloading.
- **Opens it in Google Docs:** **Google Docs** under the popup's main buttons copies the chat with its formatting and opens a new Google Doc to paste it into.
- **Continues the chat in another AI:** **Continue in…** copies the conversation with a short instruction ahead of it and opens the assistant you pick (ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity, Copilot, Kimi, Qwen and the rest) in a new tab, so you can paste it and pick up where you left off. A very long chat keeps its first question and its latest messages.
- **Cites it:** **Cite** gives a ready reference to the conversation in APA, MLA and Chicago style, with the AI tool, the model when known, the date and the link, each with its own copy button.
- **Opens your official data export:** the ZIP that ChatGPT (**Settings → Data controls → Export data**) or Claude (**Settings → Privacy → Export data**) emails you can be opened from the popup's **Open a ChatGPT or Claude data export**. Every chat in it is listed and searched word by word, can be read on the page, and the ones you tick are saved in any file type, into one ZIP. The file is read on your computer and never uploaded; only its `conversations.json` is unpacked, so even an export of several gigabytes of pictures opens.
- **Fits your preferences:** heading style, spacing between messages, an optional export timestamp, how files are named, and whether to ask where to save each file.
- Light, Dark, or System theme.
- Interface in English, Spanish, French, German, Russian, Chinese, Japanese, Korean, Hindi, Portuguese (Brazil), Indonesian, Turkish or Italian, or following your browser's language automatically.

## Installing it

### Chrome

Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/objkcakdcilfaphifjfcgfamlnnbinjc).

### Microsoft Edge

Edge runs Chrome extensions: open the [Chrome Web Store](https://chromewebstore.google.com/detail/objkcakdcilfaphifjfcgfamlnnbinjc) page in Edge, click **Allow extensions from other stores** when Edge asks, then **Add to Chrome**. To load it from source, follow the Chrome steps below on `edge://extensions`.

### From source (Chrome, Edge or Firefox)

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
   - **Firefox** (140 or newer): open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and select `dist/manifest.json`. Firefox removes temporary add-ons when it restarts, so load it again after a restart. If Firefox asks for access to the chat sites (`chatgpt.com`, `claude.ai`, `gemini.google.com` and the rest), allow it; the extension can't read conversations without it.

The AI Exporter icon should now show up in your toolbar. If you don't see it, click the extensions button next to the address bar and pin it.

Any time you pull new changes, rebuild and then reload the extension (the reload icon on `chrome://extensions`, or **Reload** on `about:debugging`), and refresh any open chat tabs. The browser doesn't pick up rebuilt files on its own.

## Using it

1. Open any conversation on one of the [supported sites](#what-it-does).
2. Click the AI Exporter icon. The popup names the conversation it's about to save; on any other page it says what to open first.
3. Pick **Copy the whole chat**, or **Save as a file** to choose which messages to include and a file type: PDF, Word, a web page (HTML), an image, Markdown, plain text, JSON, CSV, or Excel. Each file type has a one-line explanation, and the popup remembers the one you used last.

Files are named after the site, the conversation, and the date, for example `claude-export-trip-ideas-2026-10-02.pdf`. To name them another way, pick a style under **Settings → Saving files → File names**: the chat's title alone, the date and title, or a pattern of your own made of `{title}`, `{site}`, `{date}` and `{time}`, such as `{date} {title}`.

### Settings

Click **Settings** at the top of the popup. The settings are grouped into **Language & appearance**, **Saving files**, **Keyboard shortcuts**, **Chat contents**, **PDF documents**, **GitHub** and **Notion**, and the search box finds any of them by name. Point at the **?** next to a setting to see what it does, with a tip. Every change is saved as you make it, and **Restore default settings** at the bottom of the page puts everything back the way it was after installing.

### Images

By default, images are left out and exports are text-only; any text in the same message is kept. To include them, open **Settings → Chat contents** and turn on **Include pictures**. After that:

- **PDF** exports embed the images right in the document.
- **Markdown, text, JSON, and CSV** exports that contain images download as a ZIP. Unzip it and keep the conversation file and its `images/` folder together so the image links keep working.

Copy to clipboard always stays text-only.

### PDF settings

Open **Settings → PDF documents** to pick the text size, paper size (A4, Letter, or Legal), page direction, and margins, and to turn on page numbers, a table of contents, or a line of your own text on every page (for example "Prepared by Jane Doe").

## Saving to GitHub

AI Exporter can commit an export directly into a repo instead of downloading it to disk.

1. Open the extension's **Settings** page and click **Connect GitHub**. The browser asks once whether AI Exporter may reach GitHub.
2. You'll get a short code and a new tab pointing at `github.com/login/device`. Enter the code there and approve access.
3. Back in the popup, choose **Save as a file**, then **Save to GitHub instead** to pick a repo and save the selected messages as Markdown. Files land in an `exports/` folder at the root of whichever repo you choose. With image bundling enabled, selected images are saved in a ZIP with the Markdown file and its `images/` folder. The popup shows whether the repo is public or private, and asks again before saving into a public one.

This uses GitHub's OAuth **device flow**, the same mechanism CLI tools like the GitHub CLI use to sign in. No password or personal access token ever touches the extension, just a short-lived code you type into GitHub's own site. Your access token is stored locally in your browser and never leaves your machine except to talk to `api.github.com`.

## Saving to Notion

1. Create an internal integration at [notion.so/profile/integrations](https://www.notion.so/profile/integrations) and copy its **Internal Integration Secret**.
2. Open the extension's **Settings → Notion**, paste the key and click **Connect**. The browser asks once whether AI Exporter may reach Notion.
3. In Notion, open the page to keep your chats in, click **••• → Connections** and add your integration. AI Exporter only sees the pages you add it to.
4. Back in the popup, choose **Save as a file**, then **Save to Notion instead**, pick the page to put it in, and save. The chat becomes a new Notion page with real Notion headings, lists, tables, code blocks and equations, so it's as editable as anything written in Notion.

Images aren't copied to Notion: its API only embeds pictures from a public web address.

## A few notes

- AI Exporter works on the fifteen sites listed [above](#what-it-does). If one of them changes its internal API, or for Mistral Le Chat and Meta AI its page, exports from that site may break until the extension gets updated. That's the trade-off of reading the real conversation rather than a screenshot of it.
- AI Exporter keeps itself up to date. The bottom of the popup shows the version you have and whether it's the latest; click it to check again. Once the browser has downloaded an update, AI Exporter installs it as soon as no export is running, instead of waiting for the next browser restart. Firefox asks you to approve an update that needs new permissions: press Ctrl+Shift+A, click ⚙ and choose **Check for Updates**.
- Claude exports include legacy artifacts (the code and documents made before Claude's September 2026 artifacts update), each as it stood at that reply. Claude's tool calls are left out, and attached files are listed by name.
- Gemini exports include Canvas and Deep Research documents, and generated images when image bundling is on. Its citation markers become numbered sources; the markup only Gemini's own interface uses (suggested follow-ups, web image results, video cards) is left out, and attached files other than images are listed by name.
- DeepSeek, Grok and Perplexity exports include the pictures you uploaded, and Grok's generated images, when image bundling is on; other attached files are listed by name. DeepSeek's and Perplexity's web searches become numbered sources, the same as Grok's citations.
- Copilot, Kimi, Doubao, Qwen, Qianwen, Yuanbao and Z.ai exports include the text of every turn, the thinking where the site keeps it, and web sources as numbered citations where the site gives them; uploaded files are listed by name. Mistral Le Chat and Meta AI exports have the text, code, tables, formulas and pictures shown on the page.
- Image bundling downloads the image files into the export so they work locally without being signed in to the chat site.
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

The fonts in `public/fonts` keep their own licenses: DejaVu (see `DEJAVU-LICENSE.txt`), Droid Sans Fallback (Apache License 2.0, see `DROID-NOTICE.txt`) and Noto Sans (SIL Open Font License 1.1, see `NOTO-LICENSE.txt`). Complex scripts are shaped with [HarfBuzz](https://github.com/harfbuzz/harfbuzzjs) (MIT, see `public/licenses/HARFBUZZ-LICENSE.txt`).
