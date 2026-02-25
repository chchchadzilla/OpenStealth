<div align="center">

# ⚡ OpenStealth

### The Invisible AI Sidebar for Chrome

**Your screen. Your rules. Your privacy.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest_V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![OpenRouter](https://img.shields.io/badge/LLM-OpenRouter-purple.svg)](https://openrouter.ai/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/chchchadzilla/openstealth/pulls)

---

*An AI-powered browser sidebar that is completely invisible to screen capture,*
*remote monitoring, proctoring software, and screen-sharing — yet fully visible to you.*

[Getting Started](#-getting-started) · [How It Works](#-how-it-works) · [Configuration](#%EF%B8%8F-configuration-reference) · [Contributing](#-contributing)

</div>

---

## 📋 Copy-Paste Blurb

> **OpenStealth** is a free, open-source Chrome extension that gives you an AI-powered sidebar assistant only *you* can see. Built on Chrome's native Side Panel API, the sidebar is architecturally invisible to `getDisplayMedia()`, screen recording, remote desktop capture, proctoring extensions, and every other screen-capture vector short of a physical camera pointed at your monitor. It monitors the page you're on, intelligently detects when content changes — a new slide in a presentation, a fresh image, a navigation event — and automatically sends that content to the vision-capable LLM of your choice through OpenRouter. It knows what you're looking at based on your last click, text selection, or cursor focus, builds a smart prompt, and streams the AI's response right into the sidebar in real time. Need the AI to interact with the page? OpenStealth's human-simulation engine types with realistic speed, Gaussian-distributed pauses, random typos with backspace corrections, and moves the mouse along jittery Bézier curves — indistinguishable from a real person. Supports every model on OpenRouter (GPT-4o, Claude, Gemini, Llama, DeepSeek, and more), tool calls, MCP server connections, and is endlessly configurable. Zero telemetry. Zero data collection. Your API key never leaves your machine except to talk to OpenRouter. **Your screen, your rules.**

---

## 🔥 Why OpenStealth?

Your computer. Your screen. Your browsing session. Nobody has the right to silently surveil your web experience without your explicit consent.

OpenStealth was built from one simple belief: **privacy is not optional.** Whether you're researching sensitive topics, working with confidential material, or simply refusing to let third-party software spy on your workflow, you deserve a tool that respects your sovereignty over your own machine.

This isn't about hiding — it's about **choosing who sees what on your screen.**

---

## ✨ Features at a Glance

| | Feature | Description |
|---|---------|-------------|
| 🕵️ | **Truly Invisible Sidebar** | Uses Chrome's native Side Panel API — architecturally excluded from `getDisplayMedia()`, screen recording, tab capture, and DOM-based screenshot tools |
| 🧠 | **AI-Powered Analysis** | Sends page content and/or screenshots to vision-capable LLMs via [OpenRouter](https://openrouter.ai) — supports 200+ models |
| 🔄 | **Smart Change Detection** | Detects slideshow transitions, SPA navigations, image swaps, and significant text changes while ignoring CSS animations and noise |
| 🎯 | **Context-Aware Intelligence** | Tracks your last click, text selection, input focus, and typing to figure out *exactly* what you want analyzed — then builds the prompt automatically |
| 🤖 | **Human-Like Browser Control** | Optional AI-driven typing with Gaussian pauses, realistic typos, backspace corrections, and mouse movement along randomized Bézier curves with jitter |
| 🛡️ | **Anti-Detection Suite** | Hooks `canvas.toDataURL`, `getDisplayMedia`, detects known proctoring signatures (Proctorio, Examity, Respondus, Honorlock, etc.) |
| 🔧 | **Tool Calls & MCP** | Let the AI suggest and execute actions — browse, search, click, type — all gated behind explicit user approval |
| ⚡ | **Multi-Model Freedom** | GPT-4o, Claude Sonnet 4, Gemini 2.5 Pro, DeepSeek R1, Llama 3.1 405B, and any model on OpenRouter |
| 📡 | **Streaming Responses** | Token-by-token streaming so answers appear in real time |
| 🎨 | **Beautiful Dark UI** | Sleek, minimal dark-mode sidebar that stays out of your way |
| 🔐 | **Zero Telemetry** | No analytics, no tracking, no data collection — ever |

---

## 🚀 Getting Started

### Prerequisites

- Google Chrome (v116+ for Side Panel API support)
- An [OpenRouter API key](https://openrouter.ai/keys) (free tier available)

### Installation

**1. Clone the repository**

```bash
git clone https://github.com/chchchadzilla/openstealth.git
cd openstealth
```

**2. Add extension icons**

Replace the placeholder files in `assets/icons/` with real PNG icons:

- `icon16.png` — 16×16 px
- `icon48.png` — 48×48 px
- `icon128.png` — 128×128 px

Or generate SVG templates with `node generate-icons.js` and convert them.

**3. Load into Chrome**

1. Navigate to `chrome://extensions/`
2. Toggle **Developer mode** ON (top-right corner)
3. Click **Load unpacked**
4. Select the `openstealth` folder
5. The ⚡ icon appears in your toolbar — you're live

**4. Configure**

1. Click the ⚡ icon → **Settings** (or right-click → Options)
2. Paste your **OpenRouter API key**
3. Choose your preferred text and vision models
4. Tune the human simulation to match your own typing speed
5. Hit **💾 Save Settings**

**5. Open the sidebar**

- Click the ⚡ icon → **Open Sidebar Panel**
- Or press **`Ctrl+Shift+S`**
- Start browsing — OpenStealth watches, detects, and assists automatically

---

## 🧬 How It Works

### The Stealth Layer

OpenStealth's sidebar lives inside Chrome's **Side Panel API** (`chrome.sidePanel`). This is a first-party browser-chrome UI surface — not a DOM overlay, not an iframe, not a popup. It exists in the browser's own UI layer, which means:

| Capture Method | Can It See the Sidebar? |
| --- | --- |
| `getDisplayMedia()` / screen share | ❌ No |
| `html2canvas` / DOM screenshot tools | ❌ No |
| `chrome.tabs.captureVisibleTab()` from other extensions | ❌ No |
| Remote desktop (tab/window capture mode) | ❌ No |
| Proctoring extensions (Proctorio, Examity, etc.) | ❌ No |
| Browser DevTools screenshot | ❌ No |
| Physical camera pointed at your screen | ✅ Yes |

**Additional hardening in `stealth-overlay.js`:**

- `HTMLCanvasElement.prototype.toDataURL` and `toBlob` are hooked — any OpenStealth overlay elements are hidden before capture and restored after
- `navigator.mediaDevices.getDisplayMedia` is hooked — overlays auto-hide when screen sharing begins
- Known proctoring extension signatures are scanned on page load (script sources, CSS injections, API monkey-patches) and reported to the sidebar
- All extension messaging uses Chrome's isolated `chrome.runtime` channel — never `window.postMessage`
- Keyboard shortcuts are captured in the `capture` phase to fire before any proctoring keyloggers

### Smart Change Detection

The page monitor (`page-monitor.js`) avoids the "fire on every tiny DOM twitch" problem through multi-layer filtering:

```
DOM Mutation → Filter Noise → Batch (500ms) → Debounce (2s) → Snapshot → Compare → Threshold → Fire
```

**What gets filtered out:**

- Attribute changes on `<body>` / `<html>` (scroll positions, class toggles)
- Mutations inside OpenStealth's own elements
- Hidden elements (`display: none`, `visibility: hidden`, `opacity: 0`)
- Fewer than 3 mutations in a batch (too trivial)

**What triggers analysis:**

- ≥30% of visible text content changed (configurable)
- New images appeared (by `src` comparison)
- Active slide index changed (detects Reveal.js, Swiper, Slick, Bootstrap Carousel, and generic `[class*="slide"]` patterns)
- URL changed (SPA navigation via `pushState` / `replaceState` / `popstate` / `hashchange`)

### Context-Aware Interaction Tracking

The interaction tracker (`interaction-tracker.js`) records your last meaningful action so the AI knows *what you care about*:

| Your Action | What OpenStealth Captures | How the AI Uses It |
| --- | --- | --- |
| **Click** an image | Element tag, `src`, `alt`, position | "Describe/analyze this image" |
| **Highlight** text | Selected string, parent context | "Explain/answer this specific text" |
| **Click into** an input field | Field label, placeholder, nearby question (walks up the DOM tree) | "The user wants to answer this question — provide the answer" |
| **Type** in a field | Current value, associated question, field metadata | "The user is actively answering — assist with this specific question" |
| **Hover** (1s+) on a slide or image | Element info, content | Stored as passive context for the next query |

The prompt builder (`prompt-builder.js`) weaves all of this — page text, active slide content, user interaction, conversation history, and optionally a screenshot — into a single intelligent prompt.

### Human Simulation Engine

When browser control is enabled and the AI needs to interact with the page, it does so with behavior indistinguishable from a real person:

**Typing Simulation:**

- Inter-key delays follow a **Gaussian distribution** (not uniform random — that's a bot tell)
- Spaces, periods, and line breaks get longer pauses
- 2% chance of a random multi-second "thinking" pause mid-sentence
- Configurable typo rate (default 4%) using **adjacent-key mapping** (e.g., typing `s` instead of `a`, `h` instead of `g`)
- Typos are immediately followed by a realistic-delay backspace and the correct character
- Speed presets: Slow (25 WPM), Medium (45 WPM), Fast (70 WPM), or fully Custom

**Mouse Simulation:**

- Paths follow **cubic Bézier curves** with randomized control points — not straight lines
- **Gaussian jitter** applied to every intermediate position (configurable amplitude)
- Movement **slows down** near the target (like a real hand decelerating)
- Clicks land **off-center** within the target element (humans don't hit the exact center)
- Realistic `mousedown` → hold → `mouseup` → `click` event sequence with variable hold time

---

## 📁 Project Structure

```text
openstealth/
├── manifest.json                  # Chrome Manifest V3 configuration
├── LICENSE                        # MIT License
├── README.md                      # You are here
├── generate-icons.js              # SVG icon template generator
│
├── assets/
│   └── icons/
│       ├── icon16.png             # Toolbar icon (16×16)
│       ├── icon48.png             # Extension page icon (48×48)
│       └── icon128.png            # Store / install icon (128×128)
│
└── src/
    ├── background/
    │   └── service-worker.js      # Central message router, API orchestration,
    │                              # state management, tab capture, tool execution
    │
    ├── sidebar/
    │   ├── sidebar.html           # Side Panel markup
    │   ├── sidebar.css            # Dark-mode UI theme
    │   └── sidebar.js             # Chat controller, streaming renderer,
    │                              # markdown formatting, tool call UI
    │
    ├── content/
    │   ├── page-monitor.js        # MutationObserver, change detection,
    │   │                          # slideshow tracking, SPA navigation hooks
    │   ├── interaction-tracker.js # Click/select/focus/type/hover tracking,
    │   │                          # nearby-question discovery, label resolution
    │   ├── stealth-overlay.js     # Canvas hook, getDisplayMedia hook,
    │   │                          # proctor detection, keyboard capture
    │   ├── content-main.js        # Human simulation engine (typing + mouse),
    │   │                          # action executor, message coordinator
    │   └── stealth.css            # CSS isolation for injected elements
    │
    ├── api/
    │   ├── openrouter.js          # OpenRouter API client — streaming SSE,
    │   │                          # vision messages, tool call parsing
    │   └── prompt-builder.js      # Context-aware prompt construction
    │
    ├── popup/
    │   └── popup.html             # Quick-status popup (API/monitor/stealth status)
    │
    └── options/
        ├── options.html           # Full settings UI
        ├── options.css            # Settings page theme
        └── options.js             # Settings load/save/test controller
```

---

## ⚙️ Configuration Reference

All settings are stored locally in `chrome.storage.local` — never transmitted anywhere.

### API Settings

| Setting | Default | Description |
| --- | --- | --- |
| `apiKey` | — | Your OpenRouter API key |
| `model` | `google/gemini-2.0-flash-001` | Primary text model for analysis |
| `visionModel` | `google/gemini-2.0-flash-001` | Model used when screenshots are included |
| `maxTokens` | `4096` | Maximum response length in tokens |
| `temperature` | `0.7` | Creativity dial — `0` = deterministic, `1` = creative |

### Detection Settings

| Setting | Default | Description |
| --- | --- | --- |
| `autoDetect` | `true` | Automatically analyze page when content changes |
| `changeThreshold` | `0.3` (30%) | Minimum content change ratio to trigger analysis |
| `debounceMs` | `2000` | Milliseconds to wait after last change before analyzing |

### Human Simulation

| Setting | Default | Description |
| --- | --- | --- |
| `typingSpeed` | `medium` | Preset: `slow` (25 WPM) / `medium` (45) / `fast` (70) / `custom` |
| `typingWPM` | `45` | Words per minute in custom mode |
| `typoRate` | `0.04` (4%) | Probability of adjacent-key typo per character |
| `mouseJitter` | `3` | Gaussian jitter amplitude in pixels |
| `mouseSpeed` | `medium` | Mouse movement speed preset |

### Permissions

| Setting | Default | Description |
| --- | --- | --- |
| `enableToolCalls` | `false` | Allow the AI to propose tool/function calls |
| `enableBrowserControl` | `false` | Allow the AI to type/click on the page |
| `enableMCP` | `false` | Enable Model Context Protocol server connections |
| `mcpServers` | `[]` | List of MCP server URLs |
| `stealthLevel` | `high` | Protection level: `low` / `medium` / `high` / `paranoid` |

---

## 🧩 Supported Models

Any model available on [OpenRouter](https://openrouter.ai/models) works out of the box. Recommended picks:

| Model | Speed | Quality | Vision | Best For |
| --- | --- | --- | --- | --- |
| Gemini 2.0 Flash | ⚡ Fast | ★★★★ | ✅ | Daily driver — fast, cheap, great vision |
| Gemini 2.5 Pro | 🐢 Slow | ★★★★★ | ✅ | Maximum quality, complex analysis |
| Claude Sonnet 4 | ⚡ Fast | ★★★★★ | ✅ | Nuanced reasoning, long context |
| GPT-4o | ⚡ Fast | ★★★★ | ✅ | Strong all-rounder |
| GPT-4o Mini | ⚡⚡ Fastest | ★★★ | ✅ | Budget-friendly, quick answers |
| DeepSeek R1 | 🐢 Slow | ★★★★★ | ❌ | Complex reasoning, math, code |
| Llama 3.1 405B | 🐢 Slow | ★★★★ | ❌ | Open-source, no vendor lock-in |

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+Shift+S` | Toggle the sidebar |
| `Enter` | Send message (in sidebar) |
| `Shift+Enter` | New line (in sidebar input) |
| Right-click → *Ask OpenStealth about this* | Context menu query on selected text or images |

---

## 🔒 Privacy & Security

OpenStealth was designed with **zero-trust privacy** as a core architectural constraint:

- **Local-only storage** — Your API key and all settings live in `chrome.storage.local`. They never touch a server we control (we don't have one).
- **Zero telemetry** — No analytics scripts, no tracking pixels, no usage beacons. Not now, not ever.
- **No remote code** — Every line of JavaScript ships in the extension package. No CDN imports, no remote eval.
- **Transparent API calls** — The only outbound network requests go to `https://openrouter.ai/api/v1/` using *your* key.
- **Gated automation** — Tool calls and browser control are disabled by default and require explicit opt-in. Even when enabled, every AI action requires manual approval before execution.
- **Open source** — You can read every line. Audit it. Fork it. Improve it.

---

## 🐛 Troubleshooting

| Problem | Solution |
| --- | --- |
| "No API key configured" | Open Settings → paste your OpenRouter API key → Save |
| Sidebar won't open | You must be on a regular `http(s)://` page — Chrome internal pages (`chrome://`, `edge://`) don't support side panels |
| Changes not being detected | Lower the change threshold (Settings → Auto-Detection) / reduce debounce time / make sure 🔄 auto-detect is toggled ON in the sidebar header |
| API returns errors | Click **🧪 Test API Connection** in Settings / check your [OpenRouter credit balance](https://openrouter.ai/credits) / try a different model |
| Slow responses | Switch to a faster model (Gemini Flash, GPT-4o Mini) / reduce `maxTokens` |
| Tool calls not working | Enable "Tool Calls" in Settings → Permissions / the model must support function calling |

---

## 🤝 Contributing

Contributions are welcome and encouraged! Here's how:

1. **Fork** the repository
2. Create a **feature branch** (`git checkout -b feature/amazing-thing`)
3. **Commit** your changes (`git commit -m 'Add amazing thing'`)
4. **Push** to your branch (`git push origin feature/amazing-thing`)
5. Open a **Pull Request**

### Ideas for Contribution

- 🌐 Multi-language UI support
- 🎨 Theme customization (light mode, custom colors)
- 📊 Token usage tracking / cost dashboard
- 🔌 More MCP tool integrations
- 🧪 Automated test suite
- 📱 Firefox / Edge port

---

## 📄 License

**MIT License** — see [LICENSE](LICENSE) for full text.

Use it freely. Modify it endlessly. Distribute it widely. Just keep it open.

---

<div align="center">

**Built for people who believe privacy is a right, not a privilege.**

⚡ **OpenStealth** — *Your screen. Your rules.*

</div>
