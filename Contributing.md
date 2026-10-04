# Contributing

Thanks for wanting to help with AI Exporter. Contributions are welcome, whether that's a bug fix, a new feature, better docs, or just cleaning something up.

Everyone taking part in the project, in issues, pull requests, or anywhere else, is expected to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Getting started

1. Fork the repo and branch off `main`.
2. Keep the existing code style. Look at the surrounding code before adding something new so it fits in naturally.
3. If your change affects behavior that's covered by tests, add or update tests for it.
4. Run `npm run typecheck` and `npm run test:run` before opening the PR, and make sure both pass.
5. Run `npm run build` too. After building, it checks `dist/` for anything the Chrome Web Store or Firefox Add-ons would reject, and fails if it finds any. That covers code loaded from another server (a CDN script, a remote `import()`), `eval()` or `new Function()`, and a manifest naming a file the build doesn't have. Every line of code has to ship inside the extension, so a new library comes from npm and gets bundled, never from a CDN.
6. Open the PR with a short description of what changed and why.

## Contributor agreement

By submitting a pull request, commit, patch, issue attachment, or other material
intended for inclusion in AI Exporter, you agree to the Contributor License
Agreement in [CLA.md](./CLA.md).

First PR? A bot may ask you to confirm acceptance of the Contributor License
Agreement. That confirmation is one-time and applies to your current and future
Contributions.

## Review

Every pull request is reviewed before merging. The level of review depends on the scope and impact of the changes.

Some changes require additional attention, especially those involving:

- authentication, credentials, or tokens;
- external APIs and third-party integrations;
- user data or conversation content;
- network requests and data transmission;
- browser and extension permissions;
- communication between extension contexts;
- data storage and file handling;
- security or privacy-sensitive functionality.

These considerations apply across the entire codebase and are not limited to specific files. As AI Exporter grows, the same approach will apply to new integrations, permissions, data flows, and other sensitive functionality.

When opening a pull request, please provide a clear description of what you changed and, where relevant, mention any security, privacy, permission, or data-handling considerations.

For larger changes or new features, opening an issue first is encouraged. This gives everyone a chance to discuss the idea and approach before significant development work begins.
