# GroupResume Companion — Development Plan

> WhatsApp group summarizer with live connection, automatic daily summaries, and in-group bot commands.
> Companion module for the existing [groupResume](https://github.com/juliocorcini/groupResume) project.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Operation Modes](#operation-modes)
4. [Technology Stack](#technology-stack)
5. [AI Provider System](#ai-provider-system)
6. [Chunking & Rate Limit Engineering](#chunking--rate-limit-engineering)
7. [WhatsApp Integration](#whatsapp-integration)
8. [Dashboard UI](#dashboard-ui)
9. [System Tray Integration](#system-tray-integration)
10. [Auto-Start with Windows](#auto-start-with-windows)
11. [API Endpoints](#api-endpoints)
12. [File Structure](#file-structure)
13. [Configuration](#configuration)
14. [Security Considerations](#security-considerations)
15. [Build Order](#build-order)

---

## Overview

### Problem

The existing groupResume app requires manually exporting WhatsApp chats as .txt files, uploading them, and generating summaries. This is friction-heavy for daily use.

### Solution

A local companion app that:
- Connects directly to WhatsApp (via whatsapp-web.js)
- Fetches messages on-demand or automatically
- Generates summaries using Groq AI (with Ollama as local backup)
- Sends summaries back to WhatsApp
- Responds to bot commands in groups
- Runs minimized in the system tray

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Platform | Windows native | System tray support, no WSL complexity |
| Location | `C:\Users\julio\Documents\Pessoal\GroupResumeCompanion` | Separate from WSL project |
| WhatsApp lib | whatsapp-web.js | Best API for fetching message history |
| AI (primary) | Groq API direct | Free tier, fast, same as groupResume |
| AI (backup) | Ollama local | Zero cost, privacy, offline capable |
| Interface | Web dashboard + System tray | Simple, browser-based, unobtrusive |
| WhatsApp number | Separate chip | Lower risk of suspension |
| Auto-start | Yes, with Windows | Goes to tray automatically |
| Bot triggers | `!resumo` (anyone in group) | Simple, familiar format |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Windows Desktop                       │
│                                                          │
│  ┌──────────┐    ┌────────────────────────────────────┐  │
│  │ System   │    │  Dashboard (localhost:3000)         │  │
│  │ Tray     │    │                                    │  │
│  │ Icon     │←──→│  Groups │ Calendar │ Summary       │  │
│  │ 🟢       │    │  List   │ Picker   │ Result        │  │
│  └──────────┘    │         │          │ [Send to WA]  │  │
│       ↕          └────────────────┬───────────────────┘  │
│  ┌──────────────────────────────┐ │                      │
│  │  Node.js Backend (Express)   │←┘                      │
│  │                              │                        │
│  │  ├─ whatsapp-web.js         │  ← Session persisted   │
│  │  │  ├─ Fetch messages       │                        │
│  │  │  ├─ Send summaries       │                        │
│  │  │  └─ Listen for commands  │                        │
│  │  │                          │                        │
│  │  ├─ AI Provider             │                        │
│  │  │  ├─ Groq (primary)      │  ← Free API            │
│  │  │  └─ Ollama (backup)     │  ← Local, optional     │
│  │  │                          │                        │
│  │  └─ Scheduler              │  ← Daily auto-summary  │
│  └──────────────────────────────┘                        │
└──────────────────────────────────────────────────────────┘
```

---

## Operation Modes

### Mode 1: Manual (Dashboard)

**Trigger**: Double-click tray icon or desktop shortcut
**Flow**:
1. Dashboard opens in browser at `localhost:3000`
2. Shows connected WhatsApp groups
3. User selects group and date range
4. Generates summary with chosen AI provider
5. Optionally sends summary to a WhatsApp contact

### Mode 2: Automatic (Daily Schedule)

**Trigger**: Windows Task Scheduler at configured time
**Flow**:
1. Headless script runs (no UI)
2. Connects to WhatsApp (saved session)
3. Fetches messages from past 24h for configured groups
4. Generates summary via Groq
5. Sends summary to configured WhatsApp contact
6. Exits cleanly

**Configuration**: Set via dashboard Settings page
**Fallback**: If PC was off at scheduled time, runs when PC turns on

### Mode 3: Bot (Group Commands)

**Trigger**: Someone sends `!resumo` in a WhatsApp group
**Requires**: Companion must be running (manual mode or daemon)
**Flow**:
1. Bot detects `!` command in monitored group
2. Parses command variant (today, yesterday, specific date)
3. Fetches messages for requested period
4. Generates summary
5. Replies in the same group

**Commands**:

| Command | Action |
|---------|--------|
| `!resumo` | Summary of today |
| `!resumo ontem` | Summary of yesterday |
| `!resumo 3dias` | Summary of last 3 days |
| `!resumo 15/10` | Summary of specific date |
| `!help` | Show available commands |

**Protections**:
- Rate limit: max 1 summary per hour per group
- Only responds in configured/allowed groups
- Cooldown message if requested too fast
- Ignores unknown commands silently

---

## Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | 20+ (install via winget) |
| Language | TypeScript | 5.3+ |
| WhatsApp | whatsapp-web.js | Latest |
| Browser engine | Chromium (via Puppeteer) | Auto-downloaded |
| Web server | Express | 4.x |
| AI (primary) | Groq SDK | 0.5+ |
| AI (backup) | Ollama (HTTP API) | Optional |
| System tray | systray2 or node-systray | Latest |
| Task scheduler | Windows schtasks | Built-in |
| Frontend | Vanilla HTML/CSS/JS or React | TBD |

---

## AI Provider System

### Abstract Interface

```typescript
interface AIProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  getModels(): Promise<ModelInfo[]>;
  summarize(text: string, options: SummaryOptions): Promise<SummaryResult>;
  merge(summaries: string[], options: SummaryOptions): Promise<SummaryResult>;
}

interface SummaryOptions {
  level: 1 | 2 | 3 | 4;
  privacy: 'anonymous' | 'with-names' | 'smart';
  model?: string;
  maxTokens?: number;
}

interface SummaryResult {
  summary: string;
  tokensUsed: number;
  processingTime: number;
  provider: string;
  model: string;
}
```

### Groq Provider (Primary)

- **API**: Direct Groq SDK call (no Vercel intermediary)
- **Models**: llama-3.1-8b-instant (fast), llama-3.3-70b-versatile (balanced), llama-4-scout (powerful)
- **Free tier**: 14,400 requests/day, 70K TPM
- **Key**: Same GROQ_API_KEY from existing groupResume

### Ollama Provider (Backup/Local)

- **API**: HTTP to `http://localhost:11434` (Ollama default)
- **Models**: qwen3:4b (~2.5GB), llama3.1:8b (~4.7GB)
- **Installation**: Dashboard button opens ollama.ai, user installs manually
- **Model download**: Dashboard triggers `ollama pull <model>` with progress
- **Zero cost**: Runs entirely on user's PC
- **Privacy**: No data leaves the machine
- **Fallback**: Automatic if Groq is down (configurable)

### Dashboard AI Settings

```
Settings → AI Provider
├── Default Provider: [Groq / Ollama]
├── Groq Settings
│   ├── API Key
│   ├── Model selection
│   └── Connection status
├── Ollama Settings
│   ├── Installation status
│   ├── Installed models list
│   ├── Download new model
│   └── Active model selection
└── Fallback: Auto-switch to backup if primary fails
```

---

## Chunking & Rate Limit Engineering

> Replicated from groupResume with adaptations for local execution (no 10s timeout).

### Chunking Strategy

1. **Model limits** (inherited from groupResume):
   - fast: 80 messages/chunk
   - balanced: 120 messages/chunk
   - powerful: 250 messages/chunk

2. **Token estimation**: ~4 chars per token for Portuguese

3. **Smart sampling** (for quick mode):
   - Groups messages into conversation blocks (≤5 min gap)
   - Always includes beginning and end of day
   - Fills with largest blocks (most active conversations)
   - Preserves chronological order

4. **Full processing** (for complete mode):
   - Splits messages into chunks by model limit
   - Processes each chunk sequentially
   - Monitors TPM usage
   - Merges partial summaries into final

### Rate Limit Handling

1. **TPM (Tokens Per Minute)**: 70,000
   - Monitor tokens used across chunks
   - When reaching 90% → wait 60s for reset
   - Show countdown in UI

2. **TPD (Tokens Per Day)**: Varies by model
   - Detect daily limit errors
   - Parse wait time from Groq error messages
   - Show estimated availability

3. **Request rate limits**:
   - Parse wait time formats: "7.39s", "6m47.2896s", "1h30m"
   - Auto-wait and retry
   - Progress UI with countdown

### Merge Strategy

1. For ≤3 summaries: merge all at once
2. For >3 summaries: merge in batches of 2 recursively
3. If merge times out: split batch in half, merge each, then merge results
4. Use fast model (llama-3.1-8b) for merging (less tokens needed)
5. Cap merge input at ~4000 chars to avoid timeouts

### Local Execution Advantages

| Aspect | groupResume (Vercel) | Companion (local) |
|--------|---------------------|-------------------|
| Request timeout | 10 seconds | None |
| Chunk size | Limited by timeout | Limited by Groq TPM only |
| Merge strategy | Very conservative | Can be more aggressive |
| Retry on failure | Limited attempts | Unlimited retries |
| Progress feedback | HTTP streaming | WebSocket real-time |

---

## WhatsApp Integration

### Library: whatsapp-web.js

**Connection**:
- Uses `LocalAuth` strategy for session persistence
- Session stored in `.wwebjs_auth/` folder
- First time: QR code displayed in dashboard
- Subsequent: auto-reconnect using saved session

**Message Fetching**:
- `chat.fetchMessages({ limit: N })` for recent messages
- Filter by date range on the fetched messages
- Practical limit: ~500-1000 messages per fetch
- For older messages: may need multiple fetches

**Message Sending**:
- `client.sendMessage(chatId, text)` for sending summaries
- Supports sending to any chat (private or group)
- Can format with WhatsApp markdown (*bold*, _italic_)

**Bot Listener**:
- `client.on('message', handler)` fires for every message
- Filter: `msg.body.startsWith('!')` — instant check, zero cost
- Only processes further for matching commands
- 99.9% of messages: single string comparison then return

### WhatsApp Number

- Uses separate chip/number (lower suspension risk)
- Number should be registered with WhatsApp before first use
- Bot name in group contacts: "📋 Bot Resumo" (recommended)

### Reconnection Handling

- Auto-reconnect on disconnect
- Session refresh when needed
- Dashboard shows connection status: 🟢/🟡/🔴
- Tray icon color reflects connection status

---

## Dashboard UI

### Main Pages

#### Home / Groups

```
┌──────────────────────────────────────────────────┐
│  💬 GroupResume Companion          🟢 Conectado   │
│                                    [⚙️] [⏹]     │
├──────────────────────────────────────────────────┤
│                                                   │
│  Seus Grupos:                                     │
│  ┌─────────────────────────────────────────────┐  │
│  │ 🏠 Condomínio Edifício Sol    │ 342 msgs    │  │
│  │ 👨‍👩‍👦 Família                    │ 28 msgs     │  │
│  │ 💼 Trabalho                   │ 156 msgs    │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  📅 Período: [Hoje] [Ontem] [3 dias] [Escolher]  │
│                                                   │
│  📊 Nível: [Flash] [Resumido] [●Padrão] [Completo]│
│  🔒 Privacidade: [Anônimo] [●Inteligente] [Nomes] │
│                                                   │
│        [ ✨ Gerar Resumo ]                        │
│        [ 📱 Gerar e enviar no WhatsApp ]          │
│                                                   │
└──────────────────────────────────────────────────┘
```

#### Summary Result

```
┌──────────────────────────────────────────────────┐
│  📋 Resumo — Condomínio — 16/10/2026             │
│                                                   │
│  ## Principais Assuntos                           │
│                                                   │
│  **Manutenção do elevador**: O síndico informou   │
│  que a empresa de manutenção virá na quarta...    │
│                                                   │
│  **Assembleia**: Marcada para 25/10 às 19h...     │
│                                                   │
│  📊 342 mensagens · 18 participantes · 2.3s       │
│                                                   │
│  [📱 Enviar no WhatsApp]  [📋 Copiar]  [🔄 Novo] │
└──────────────────────────────────────────────────┘
```

#### Send to WhatsApp (Contact Picker)

```
┌──────────────────────────────────────────────────┐
│  📱 Enviar resumo para:                           │
│                                                   │
│  🔍 [Buscar contato...]                          │
│                                                   │
│  ⭐ Mensagens Salvas (eu)                         │
│  👤 João Silva                                    │
│  👤 Maria Oliveira                                │
│  👥 Condomínio Edifício Sol                       │
│  ...                                              │
│                                                   │
│  [Cancelar]  [📱 Enviar]                          │
└──────────────────────────────────────────────────┘
```

#### Settings

```
┌──────────────────────────────────────────────────┐
│  ⚙️ Configurações                                │
│                                                   │
│  ── Resumo Automático Diário ────────────────── │
│  ✅ Ativado                                      │
│  ⏰ Horário: [20:00]                             │
│  📋 Grupos: ☑ Condomínio  ☐ Família  ☐ Trabalho │
│  📊 Nível: [●Padrão]                             │
│  📱 Enviar para: [Mensagens Salvas] ▼            │
│                                                   │
│  ── Provedor de IA ──────────────────────────── │
│  [●Groq] [Ollama]                                │
│  API Key: [gsk_***]                              │
│  Modelo: [●powerful]                              │
│  Ollama: ⚠️ Não instalado [📥 Baixar]           │
│                                                   │
│  ── Bot no Grupo ────────────────────────────── │
│  ✅ Ativado                                      │
│  Prefixo: [!]                                    │
│  Grupos permitidos: ☑ Condomínio                 │
│  Rate limit: [1 resumo/hora]                     │
│                                                   │
│  ── Sistema ─────────────────────────────────── │
│  ✅ Iniciar com o Windows                        │
│  Porta: [3000]                                   │
│                                                   │
│  [💾 Salvar]                                      │
└──────────────────────────────────────────────────┘
```

---

## System Tray Integration

### Tray Icon

- Shows in Windows system tray (notification area)
- Icon color indicates status:
  - 🟢 Connected to WhatsApp
  - 🟡 Reconnecting
  - 🔴 Disconnected

### Context Menu (Right-click)

```
┌──────────────────────┐
│ 📊 Abrir Dashboard    │
│ ⏸️ Pausar bot          │
│ ⚙️ Configurações       │
│ ─────────────────────│
│ ❌ Encerrar            │
└──────────────────────┘
```

### Behavior

- **Double-click**: Opens dashboard in default browser
- **Minimize dashboard**: App continues in tray
- **Close from tray "Encerrar"**: Stops everything cleanly

### Implementation

- Use `systray2` or `node-systray` npm package
- Custom icon (WhatsApp-style with summary symbol)
- Tooltip shows status: "GroupResume - Conectado (3 grupos)"

---

## Auto-Start with Windows

### Implementation

Using Windows Task Scheduler (`schtasks`):

```powershell
$action = New-ScheduledTaskAction `
  -Execute "node.exe" `
  -Argument "C:\...\GroupResumeCompanion\dist\server.js --tray" `
  -WorkingDirectory "C:\...\GroupResumeCompanion"

$trigger = New-ScheduledTaskTrigger -AtLogon

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -DontStopOnIdleEnd `
  -RestartCount 3

Register-ScheduledTask `
  -TaskName "GroupResume Companion" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings
```

### Daily Auto-Summary Task

Separate scheduled task for automatic summaries:

```powershell
$action = New-ScheduledTaskAction `
  -Execute "node.exe" `
  -Argument "C:\...\GroupResumeCompanion\dist\auto-summary.js"

$trigger = New-ScheduledTaskTrigger -Daily -At "20:00"

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable  # Runs when PC turns on if missed
```

### Configuration from Dashboard

- Toggle auto-start on/off from Settings page
- Change daily summary time from Settings page
- Dashboard calls PowerShell to create/remove scheduled tasks

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /api/status` | GET | WhatsApp connection status |
| `GET /api/qr` | GET (SSE) | QR code stream for authentication |
| `GET /api/groups` | GET | List all WhatsApp groups |
| `GET /api/groups/:id/messages` | GET | Messages from group (query: date, limit) |
| `GET /api/groups/:id/dates` | GET | Available dates with message counts |
| `POST /api/summarize` | POST | Generate summary from messages |
| `POST /api/send` | POST | Send message via WhatsApp |
| `GET /api/contacts` | GET | List contacts for sending |
| `GET /api/settings` | GET | Get current settings |
| `PUT /api/settings` | PUT | Update settings |
| `GET /api/ai/status` | GET | AI provider status (Groq + Ollama) |
| `GET /api/ai/models` | GET | Available models for current provider |
| `POST /api/ai/ollama/install` | POST | Check/install Ollama |
| `POST /api/ai/ollama/pull` | POST | Download Ollama model |
| `POST /api/scheduler/create` | POST | Create/update scheduled task |
| `DELETE /api/scheduler/remove` | DELETE | Remove scheduled task |

### WebSocket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `qr` | Server→Client | QR code data for scanning |
| `status` | Server→Client | Connection status changes |
| `progress` | Server→Client | Summary generation progress |
| `summary:complete` | Server→Client | Summary ready |
| `bot:triggered` | Server→Client | Bot command received in group |

---

## File Structure

```
C:\Users\julio\Documents\Pessoal\GroupResumeCompanion\
├── package.json
├── tsconfig.json
├── .env                              # GROQ_API_KEY
├── .gitignore
├── config.json                       # Persistent settings
├── PLAN.md                           # This document
│
├── src/
│   ├── server.ts                     # Express server + tray (main entry)
│   ├── auto-summary.ts              # Headless script for scheduled runs
│   │
│   ├── whatsapp/
│   │   ├── client.ts                 # WhatsApp connection, QR, session
│   │   ├── messages.ts              # Fetch messages from groups
│   │   ├── sender.ts                # Send messages via WhatsApp
│   │   └── bot.ts                   # Bot command listener & handler
│   │
│   ├── ai/
│   │   ├── provider.ts              # Abstract AIProvider interface
│   │   ├── groq.ts                  # Groq implementation
│   │   ├── ollama.ts                # Ollama implementation
│   │   ├── summarizer.ts           # Orchestration: chunk, summarize, merge
│   │   └── prompts.ts              # Summary level prompts & privacy modes
│   │
│   ├── config/
│   │   ├── manager.ts              # Read/write config.json
│   │   └── scheduler.ts            # Windows Task Scheduler management
│   │
│   ├── routes/
│   │   ├── groups.ts               # /api/groups
│   │   ├── messages.ts             # /api/groups/:id/messages
│   │   ├── summarize.ts           # /api/summarize
│   │   ├── whatsapp.ts            # /api/status, /api/qr, /api/send
│   │   ├── settings.ts            # /api/settings
│   │   └── ai.ts                  # /api/ai/*
│   │
│   ├── tray/
│   │   └── tray.ts                 # System tray icon & menu
│   │
│   └── types/
│       └── index.ts                # TypeScript type definitions
│
├── dashboard/                       # Frontend (static build)
│   ├── index.html
│   ├── app.js                      # (or app.tsx if using React build)
│   └── styles.css
│
├── scripts/
│   ├── start.bat                   # Desktop shortcut target
│   ├── setup.bat                   # First-time setup (install Node, deps)
│   └── auto-summary.bat           # Called by Task Scheduler
│
├── .wwebjs_auth/                   # WhatsApp session (auto-created)
│   └── session-*/                  # Session data (gitignored)
│
├── dist/                           # Compiled TypeScript output
│   └── ...
│
└── node_modules/                   # Dependencies (gitignored)
    └── ...
```

---

## Configuration

### config.json

```json
{
  "server": {
    "port": 3000,
    "autoStartWithWindows": true
  },
  "whatsapp": {
    "sessionName": "groupresume-companion"
  },
  "ai": {
    "defaultProvider": "groq",
    "groq": {
      "model": "meta-llama/llama-4-scout-17b-16e-instruct",
      "fallbackModel": "llama-3.1-8b-instant"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434",
      "model": "qwen3:4b"
    },
    "autoFallback": true
  },
  "summary": {
    "defaultLevel": 3,
    "defaultPrivacy": "smart"
  },
  "autoSummary": {
    "enabled": true,
    "time": "20:00",
    "groups": [],
    "sendTo": "",
    "level": 3,
    "privacy": "smart"
  },
  "bot": {
    "enabled": true,
    "prefix": "!",
    "allowedGroups": [],
    "rateLimitMinutes": 60,
    "level": 3,
    "privacy": "smart"
  }
}
```

### .env

```env
GROQ_API_KEY=gsk_your_api_key_here
```

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| WhatsApp session tokens | Stored locally in `.wwebjs_auth/`, gitignored |
| Groq API key | Stored in `.env`, gitignored |
| Message content | Sent to Groq for summarization (or kept local with Ollama) |
| Bot abuse | Rate limiting, allowed groups whitelist |
| Network access | Dashboard only on localhost (not exposed to internet) |
| Session hijacking | Local-only access, no remote connections |

---

## Build Order

### Phase 1: Core (MVP)
1. Project setup (package.json, tsconfig, dependencies)
2. WhatsApp client connection (client.ts)
3. QR code display in simple HTML page
4. Message fetching from groups (messages.ts)
5. Groq integration (groq.ts, summarizer.ts)
6. Basic Express server with API routes
7. Minimal dashboard (list groups, select date, show summary)
8. **Testable milestone**: Can connect, fetch messages, generate summary

### Phase 2: Full Dashboard
9. Complete dashboard UI (all pages)
10. Summary result display with formatting
11. Send summary to WhatsApp contact
12. Contact picker UI
13. Settings page
14. **Testable milestone**: Full manual workflow working

### Phase 3: Automation
15. Auto-summary script (auto-summary.ts)
16. Windows Task Scheduler integration
17. Daily summary configuration in dashboard
18. **Testable milestone**: Automatic daily summaries

### Phase 4: Bot
19. Bot command listener (bot.ts)
20. Command parsing (!resumo, !resumo ontem, etc.)
21. Rate limiting
22. Allowed groups configuration
23. **Testable milestone**: Bot responds to commands in group

### Phase 5: System Tray
24. System tray icon
25. Tray context menu
26. Auto-start with Windows
27. Desktop shortcut creation
28. **Testable milestone**: Tray icon with all functionality

### Phase 6: Ollama Integration
29. Ollama provider (ollama.ts)
30. Installation status check
31. Model download from dashboard
32. Provider switching in settings
33. Auto-fallback when Groq is down
34. **Testable milestone**: Can switch between Groq and Ollama

---

## Performance Estimates

### Message Volume: Up to ~1000 messages/day

| Metric | Value |
|--------|-------|
| Chunks (powerful model) | 4 chunks (250 msgs each) |
| Processing per chunk | ~1-2 seconds |
| Total summarization | ~5-10 seconds |
| Merge step | ~1-2 seconds |
| **End-to-end** | **~7-15 seconds** |

### Groq Free Tier Capacity

| Limit | Value | Daily summaries possible |
|-------|-------|------------------------|
| Requests/day | 14,400 | ~3,600 summaries |
| Tokens/minute | 70,000 | ~10 summaries/minute |
| Tokens/day | Varies | Hundreds of summaries |

### Resource Usage (while running)

| Resource | Usage |
|----------|-------|
| RAM (idle, listening) | ~100-200 MB |
| RAM (generating summary) | ~300-500 MB |
| CPU (idle) | ~0% |
| CPU (generating) | Brief spike |
| Disk (session + deps) | ~300 MB |

---

*Document created: 2026-10-16*
*Project: GroupResume Companion*
*Author: AI-assisted planning*
