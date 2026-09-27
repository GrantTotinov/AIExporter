# Privacy Policy for AI Exporter

**Effective date:** September 8, 2026

AI Exporter is a Chrome extension that allows users to export their ChatGPT conversations as Markdown or plain text, copy conversations to the clipboard, and optionally save exports directly to a GitHub repository.

This Privacy Policy explains what information AI Exporter processes, how it is used, and where it is stored.

## 1. Information AI Exporter Processes

AI Exporter processes the following information when you use its features:

### ChatGPT conversation content

When you choose to export or copy a conversation, the extension accesses the conversation currently open on `chatgpt.com`.

This may include:

- User messages
- Assistant messages
- Conversation message identifiers
- Conversation structure and ordering information required to reconstruct the conversation

AI Exporter processes this information only to perform the export or copy operation requested by the user.

AI Exporter does not operate its own server or backend for storing or processing conversation content.

### GitHub account information

If you choose to connect GitHub, AI Exporter uses GitHub's OAuth Device Flow to authorize access to your GitHub account.

The extension may receive and process:

- A GitHub access token
- Your GitHub username
- Repository information needed to display repositories that you can push to

The GitHub access token is stored locally in the browser using Chrome's extension storage.

The extension does not receive or store your GitHub password.

## 2. How Information Is Used

Information is used only to provide the functionality requested by the user.

### Local export

When you choose to export a conversation as `.md` or `.txt`, the conversation content is processed locally by the extension and provided to Chrome's download functionality.

### Clipboard

When you choose **Copy Conversation**, the exported conversation is written to the clipboard so that you can paste it elsewhere.

### GitHub export

When you explicitly choose **Save to GitHub**, the selected conversation export is sent directly to GitHub's API and saved in the GitHub repository selected by you, under the `exports/` directory.

AI Exporter does not send GitHub exports to a server operated by the developer.

## 3. GitHub Authorization

GitHub integration is optional.

If you choose to connect GitHub, AI Exporter uses GitHub's OAuth Device Flow. Authorization takes place through GitHub's website.

AI Exporter does not ask for or store your GitHub password.

The GitHub access token is stored locally using Chrome's local extension storage and is used only to make the GitHub API requests required by the extension.

The token is not stored using Chrome's synchronized storage.

You can disconnect GitHub at any time from the extension's Settings page. Disconnecting removes the stored GitHub access token from the extension's local storage.

If GitHub reports that the stored token is invalid or revoked, AI Exporter automatically removes the stored token and treats the GitHub connection as disconnected.

## 4. Data Storage

AI Exporter does not maintain a remote database or server for user data.

### Conversation content

Conversation content is not persistently stored by AI Exporter.

During an export, conversation data exists temporarily in the extension's runtime memory while the export is being generated.

If you choose to save an export to GitHub, the resulting file is stored in the GitHub repository selected by you.

### GitHub access token

The GitHub access token is stored locally in Chrome extension storage on the user's device.

It is removed when the user disconnects GitHub through the extension or when the token is detected to be invalid or revoked.

### Extension settings

Export preferences, such as heading style, timestamp preference, and message spacing, are stored using Chrome's extension storage so that the selected preferences can be used across browser sessions.

## 5. Data Sharing

AI Exporter does not sell, rent, or share user data with advertisers, analytics providers, data brokers, or other third parties.

The extension communicates with the following external services when their functionality is used:

- **ChatGPT (`chatgpt.com`)** — to access the currently open conversation using the user's existing authenticated ChatGPT session.
- **GitHub (`github.com` and `api.github.com`)** — when the user connects GitHub or explicitly saves an export to GitHub.

GitHub receives information according to the GitHub functionality and permissions authorized by the user.

No conversation content is sent to the developer's own servers.

## 6. User Control

You control when AI Exporter processes a conversation.

You can:

- Export a conversation locally.
- Copy a conversation to the clipboard.
- Choose whether to save an export to GitHub.
- Choose which GitHub repository receives an export.
- Disconnect GitHub from the extension's Settings page.
- Remove the extension from Chrome.

Removing the extension also removes its locally stored extension data managed by Chrome.

Files previously exported to your computer or saved to GitHub are not automatically deleted by uninstalling the extension. Those files remain under your control and can be deleted separately.

## 7. Data Security

AI Exporter is designed to minimize data handling.

The extension:

- Does not operate a server for user conversation data.
- Stores the GitHub access token locally rather than in synchronized Chrome storage.
- Does not store GitHub passwords.
- Sends conversation content to GitHub only when the user explicitly chooses a GitHub export.
- Uses HTTPS when communicating with ChatGPT and GitHub endpoints.

No method of electronic storage or transmission can guarantee absolute security. Users should take appropriate care when exporting sensitive conversations to external destinations such as GitHub.

## 8. Third-Party Services

AI Exporter relies on third-party services for functionality:

### ChatGPT

AI Exporter operates on `chatgpt.com` and uses the authenticated session already established by the user in the ChatGPT website.

AI Exporter does not collect or store the user's ChatGPT password.

### GitHub

GitHub integration uses GitHub's OAuth Device Flow and GitHub REST API.

When a user chooses to use GitHub integration, GitHub processes the information according to its own terms and privacy practices.

## 9. Children's Privacy

AI Exporter is not specifically directed at children and does not knowingly collect personal information from children.

## 10. Changes to This Privacy Policy

This Privacy Policy may be updated when AI Exporter's functionality or data practices change.

The updated version will be published at the same Privacy Policy URL. The effective date at the top of this document will be updated when material changes are made.

## 11. Contact

For privacy questions, concerns, or requests regarding AI Exporter, contact:

**Grant Totinov**
Email: **[granttotinov604@gmail.com](mailto:granttotinov604@gmail.com)**

## 12. Open Source

AI Exporter is open-source software. The source code is publicly available in the project's GitHub repository.

This Privacy Policy describes the data practices of the AI Exporter extension and does not modify the terms of the project's MIT License.
