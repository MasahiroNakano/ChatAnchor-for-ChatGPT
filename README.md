This code works as of today March 25th, 2026.

# ChatGPT Navigator + Scroll Lock

A lightweight Chrome extension for `chatgpt.com` that makes long conversations easier to navigate.

It adds a compact floating navigator so you can jump between your own prompts, skim a clickable prompt list, and keep the page pinned in place while ChatGPT is still streaming a response.

## Features

- Jump to the previous or next user message.
- Browse a floating table of contents built from your prompts.
- Click any prompt in the list to jump directly to that part of the conversation.
- Toggle between `Follow` mode and `Stay` mode.
- Keep scroll lock preference saved locally with `chrome.storage.local`.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt` + `Up` | Jump to the previous prompt |
| `Alt` + `Down` | Jump to the next prompt |
| `Alt` + `L` | Toggle `Stay` / `Follow` |

`Alt` maps to the `Option` key on macOS keyboards.

## UI Overview

The floating widget appears in the bottom-right corner of the page:

- `▲` jumps to the previous prompt you sent.
- `▼` jumps to the next prompt you sent.
- `Stay` locks the current scroll position so new output does not pull the page away.
- `Follow` allows ChatGPT to keep auto-scrolling as new content appears.
- The prompt list shows truncated previews of your messages and highlights the one nearest the current viewport.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder.

## How It Works

- `content.js` scans the conversation for user messages, builds the floating UI, and handles navigation plus scroll-lock state.
- `page-bridge.js` patches scroll APIs on the page so auto-scroll can be temporarily blocked while `Stay` mode is enabled.
- `manifest.json` registers both scripts as a Manifest V3 extension for `https://chatgpt.com/*`.

## Privacy

This extension only changes the page UI locally in your browser.

- It does not send your chats anywhere.
- It only stores one local preference: whether scroll lock was last enabled.

## Notes

- The extension currently targets `https://chatgpt.com/*`.
- If ChatGPT changes its DOM structure, the message selectors may need to be updated.
- This project was developed with the assistance of AI tools. 
- It is released under the MIT License.