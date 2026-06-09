# pi-volcengine-usage

Volcengine (火山引擎/火山方舟) Coding Plan usage monitor extension for [pi coding agent](https://github.com/earendil-works/pi-mono).

Displays Volcengine Coding Plan 5-hour, weekly, and monthly quota usage in pi's footer. Also provides a `/volcengine` command for quota checks.

## Features

- **Footer integration**: Replaces pi's footer with token stats + `5h:xx% Wk:xx% Mo:xx%` usage with exclamation mark alerts for over-consumption
- **`/volcengine` command**: Detailed bar chart view with reset countdowns
- **Browser-based login**: No API key required — saves browser session state to bypass WAF protection
- **Auto-activates**: Only takes over the footer when using a volcengine-plan provider model — doesn't affect other providers
- **No local cache/context**: No R/W stats (local cache doesn't apply to Volcengine)

## Install

```bash
pi install git:github.com/inouemoby/pi-volcengine-usage
```

Or via `settings.json`:

```json
{
  "packages": ["https://github.com/inouemoby/pi-volcengine-usage.git"]
}
```

## Login

Run in pi:

```
/volcengine-login
```

This will open a visible Chromium browser window. Log in to your Volcengine account normally in the browser — it will auto-close after login and save your session state.

## Commands

| Command | Description |
|---------|-------------|
| `/volcengine` | Show detailed usage (bar chart + percentages + reset countdown) |
| `/volcengine-login` | Open browser to log in and save session (separate from provider API key login) |
| `/volcengine-logout` | Clear saved session |

## Preview

```
~/project (main) • my-session
↑303k ↓3.1k 3.8%/1.0M (auto) Wk:18.7% Mo:3.3%   (volcengine-plan) doubao-seed-2-0-pro • medium
```

- Normal = on track
- `!` = usage above expected rate
- `!!` = usage exceeds 1.5× expected rate — critical

## Data Storage

Browser session state (cookies + localStorage) is stored globally at `~/.pi/agent/volcengine-session.json` — configure once, works in all pi sessions across all directories.

## Related

- [pi-zai-usage](https://github.com/inouemoby/pi-zai-usage) — Same tool for ZAI (智谱/bigmodel.cn)
- [pi-ollama-usage](https://github.com/inouemoby/pi-ollama-usage) — Same tool for Ollama Cloud

## License

MIT
