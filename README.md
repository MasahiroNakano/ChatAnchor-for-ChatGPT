# ChatGPT Navigator + Stay v2

A small Chrome extension for long ChatGPT conversations.

## What it does

- Builds a table of contents from **your prompts** in the current conversation.
- Click a prompt to jump to it.
- `▲` / `▼` move to the previous / next prompt.
- **Stay** keeps the reading position stable while ChatGPT streams, re-renders, or tries to follow the newest output.
- **Follow** disables that protection and leaves scrolling to ChatGPT.
- The active prompt is highlighted as you scroll.
- The panel is isolated in a Shadow DOM so ChatGPT's CSS is less likely to break it.

## Keyboard shortcuts

- `Alt + Up` — previous prompt
- `Alt + Down` — next prompt
- `Alt + L` — toggle Stay / Follow

## Install

1. Unzip the extension folder.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the folder containing `manifest.json`.
6. Reload any already-open `chatgpt.com` tabs once.

## v2 design changes

The old version patched page-level functions such as `window.scrollTo()` and `scrollIntoView()`. That depended on how ChatGPT happened to implement auto-scrolling.

v2 does **not** patch ChatGPT's JavaScript. When Stay is enabled it:

1. Chooses a stable conversation turn near the current reading position.
2. Remembers that turn's exact screen position.
3. If ChatGPT streams, re-renders, changes layout, or changes scroll position, v2 moves the conversation scroller just enough to put that same turn back at the same screen position.
4. When you deliberately scroll, v2 waits for your scrolling to settle and records the new reading position instead.

This makes Stay depend less on ChatGPT's internal scrolling implementation.

## DOM compatibility strategy

Prompt detection uses several signals, including:

- `data-turn-key` + `data-user-message-bubble` (newer renderer)
- `data-testid="conversation-turn-*"` / `data-turn="user"` (older/alternate renderer)
- `data-message-author-role="user"`
- `data-conversation-role="user"`
- older fallback role attributes

The selectors are centralized near the top of `content.js` under `SELECTORS`.

## Privacy

- No network requests are made by the extension.
- Chat text is not sent anywhere.
- Prompt text is cached only in memory for the currently open conversation and is cleared when the route changes.
- Only the Stay / Follow preference is saved in `chrome.storage.local`.

## If ChatGPT changes again

If the panel appears but shows `0` prompts, inspect a user prompt in DevTools and check which stable role/turn attributes are present. Update the `SELECTORS` object near the top of `content.js`; the rest of the navigation and Stay logic should normally not need to change.
