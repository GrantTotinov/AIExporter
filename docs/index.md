AIExporter
Privacy Policy for AIExporter

Effective date: October 2, 2026

AIExporter (formerly AI Exporter / GPTChatDownloader) is a Chrome extension that allows users to export their ChatGPT, Claude and Gemini conversations as Markdown, plain text, or PDF, copy conversations to the clipboard, and optionally save exports directly to a GitHub repository.

This Privacy Policy explains what information AIExporter processes, how it is used, and where it is stored.

1. Information AIExporter Processes

AIExporter processes the following information when you use its features:
ChatGPT, Claude and Gemini conversation content

When you choose to export or copy a conversation, the extension accesses the conversation currently open on chatgpt.com, claude.ai or gemini.google.com.

This may include:

    User messages
    Assistant messages
    Conversation message identifiers
    Conversation structure and ordering information required to reconstruct the conversation

AIExporter processes this information only to perform the export or copy operation requested by the user.

AIExporter does not operate its own server or backend for storing or processing conversation content. This applies equally to all export formats, including PDF: PDF files are generated entirely client-side, in the browser, using the conversation data already loaded in the page. No conversation content is uploaded anywhere to produce a PDF.
GitHub account information

If you choose to connect GitHub, AIExporter uses GitHub's OAuth Device Flow to authorize access to your GitHub account.

The extension may receive and process:

    A GitHub access token
    Your GitHub username
    Repository information needed to display repositories that you can push to

The GitHub access token is stored locally in the browser using Chrome's extension storage.

The extension does not receive or store your GitHub password. 2. How Information Is Used

Information is used only to provide the functionality requested by the user.
Local export

When you choose to export a conversation as .md, .txt, or .pdf, the conversation content is processed locally by the extension and provided to Chrome's download functionality. PDF generation happens entirely within the browser; no conversation data leaves your device as part of this process.
Clipboard

When you choose Copy Conversation, the exported conversation is written to the clipboard so that you can paste it elsewhere.
GitHub export

When you explicitly choose Save to GitHub, the selected conversation export is sent directly to GitHub's API and saved in the GitHub repository selected by you, under the exports/ directory.

AIExporter does not send GitHub exports to a server operated by the developer. 3. GitHub Authorization

GitHub integration is optional.

If you choose to connect GitHub, AIExporter uses GitHub's OAuth Device Flow. Authorization takes place through GitHub's website.

AIExporter does not ask for or store your GitHub password.

The GitHub access token is stored locally using Chrome's local extension storage and is used only to make the GitHub API requests required by the extension.

The token is not stored using Chrome's synchronized storage.

You can disconnect GitHub at any time from the extension's Settings page. Disconnecting removes the stored GitHub access token from the extension's local storage.

If GitHub reports that the stored token is invalid or revoked, AIExporter automatically removes the stored token and treats the GitHub connection as disconnected. 4. Data Storage

AIExporter does not maintain a remote database or server for user data.
Conversation content

Conversation content is not persistently stored by AIExporter.

During an export, conversation data exists temporarily in the extension's runtime memory while the export (Markdown, plain text, or PDF) is being generated.

If you choose to save an export to GitHub, the resulting file is stored in the GitHub repository selected by you.
GitHub access token

The GitHub access token is stored locally in Chrome extension storage on the user's device.

It is removed when the user disconnects GitHub through the extension or when the token is detected to be invalid or revoked.
Extension settings

Export preferences, such as heading style, timestamp preference, message spacing, and export format, are stored using Chrome's extension storage so that the selected preferences can be used across browser sessions. 5. Data Sharing

AIExporter does not sell, rent, or share user data with advertisers, analytics providers, data brokers, or other third parties.

The extension communicates with the following external services when their functionality is used:

    ChatGPT (chatgpt.com) — to access the currently open conversation using the user's existing authenticated ChatGPT session.
    Claude (claude.ai) — to access the currently open conversation using the user's existing authenticated Claude session.
    Gemini (gemini.google.com) — to access the currently open conversation using the user's existing authenticated Google session, and, when image bundling is enabled, Google's image servers (such as lh3.googleusercontent.com) to download the conversation's images.
    GitHub (github.com and api.github.com) — when the user connects GitHub or explicitly saves an export to GitHub.

GitHub receives information according to the GitHub functionality and permissions authorized by the user.

No conversation content is sent to the developer's own servers, regardless of export format. 6. User Control

You control when AIExporter processes a conversation.

You can:

    Export a conversation locally as Markdown, plain text, or PDF.
    Copy a conversation to the clipboard.
    Choose whether to save an export to GitHub.
    Choose which GitHub repository receives an export.
    Disconnect GitHub from the extension's Settings page.
    Remove the extension from Chrome.

Removing the extension also removes its locally stored extension data managed by Chrome.

Files previously exported to your computer or saved to GitHub are not automatically deleted by uninstalling the extension. Those files remain under your control and can be deleted separately. 7. Data Security

AIExporter is designed to minimize data handling.

The extension:

    Does not operate a server for user conversation data, for any export format.
    Stores the GitHub access token locally rather than in synchronized Chrome storage.
    Does not store GitHub passwords.
    Sends conversation content to GitHub only when the user explicitly chooses a GitHub export.
    Uses HTTPS when communicating with ChatGPT, Claude, Gemini and GitHub endpoints.

No method of electronic storage or transmission can guarantee absolute security. Users should take appropriate care when exporting sensitive conversations to external destinations such as GitHub. 8. Third-Party Services

AIExporter relies on third-party services for functionality:
ChatGPT

AIExporter operates on chatgpt.com and uses the authenticated session already established by the user in the ChatGPT website.

AIExporter does not collect or store the user's ChatGPT password.
Claude

AIExporter operates on claude.ai and uses the authenticated session already established by the user in the Claude website.

AIExporter does not collect or store the user's Claude login credentials.
Gemini

AIExporter operates on gemini.google.com and uses the authenticated session already established by the user in the Gemini website.

AIExporter does not collect or store the user's Google login credentials.
GitHub

GitHub integration uses GitHub's OAuth Device Flow and GitHub REST API.

When a user chooses to use GitHub integration, GitHub processes the information according to its own terms and privacy practices. 9. Children's Privacy

AIExporter is not specifically directed at children and does not knowingly collect personal information from children. 10. Changes to This Privacy Policy

This Privacy Policy may be updated when AIExporter's functionality or data practices change.

The updated version will be published at the same Privacy Policy URL. The effective date at the top of this document will be updated when material changes are made. 11. Contact

For privacy questions, concerns, or requests regarding AIExporter, contact:

Grant Totinov Email: granttotinov604@gmail.com 12. License

AIExporter is source-available software. The source code is publicly available in the project's GitHub repository at github.com/GrantTotinov/AIExporter.

The project is licensed under the PolyForm Noncommercial License 1.0.0. Use, modification, and redistribution of AIExporter are permitted only for noncommercial purposes under that license, unless you have separate written permission from the Project Owner.

This Privacy Policy describes the data practices of the AIExporter extension and does not modify the terms of the project's LICENSE, CLA, or NOTICE.
This site is open source. Improve this page.
