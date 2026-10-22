# 💬 GroupResume Companion

**Desktop companion for WhatsApp group summaries** — connects directly to your WhatsApp, monitors groups in real-time, and generates AI-powered summaries with a single command.

> Built for people who are in too many WhatsApp groups and don't have time to read everything.

---

## ✨ Features

### 🤖 WhatsApp Bot
- **Group commands**: `!resumo`, `!ajuda`, `!status`, `!usage`
- **Date ranges**: `!resumo ontem`, `!resumo semana`
- **Summary levels**: Flash, Resumido, Padrão, Completo, Tópicos
- **Bot introduction**: `!apresentar` introduces the bot to the group

### 💬 Private DM Interaction
- Chat directly with the bot in private messages
- Interactive menus to select groups, dates, and summary levels
- **Ask questions** about group conversations with AI context
- **Voice commands**: record a voice note → bot transcribes and uses as text command
- **Multi-audio support**: forward multiple audios → bot queues and transcribes all at once

### 🎤 Audio Transcription
- Powered by **Whisper** via Groq
- 5-layer download strategy to handle WhatsApp CDN quirks
- Voice notes recorded in DM = text commands
- Forwarded audios = media to analyze

### 📊 Dashboard
- Real-time web dashboard at `localhost:3000`
- QR code scanning for WhatsApp login
- One-click summary generation for any group
- Usage statistics with per-source and per-model breakdown
- Summary history with copy-to-clipboard

### ⏰ Auto-Summaries
- Schedule automatic daily summaries for any group
- Configurable time and summary level
- Sends directly to the group

### 🧠 Smart AI
- **5 summary levels**: from 2-sentence flash to detailed topic lists
- **Humor detection**: distinguishes jokes from real events
- **Attribution accuracy**: verifies who said what before attributing
- **Privacy modes**: Anonymous, Smart, or With-Names
- **No hallucination**: doesn't invent information not in the conversation

### 🖥️ System Tray
- Runs quietly in the Windows system tray
- Auto-restarts server if it crashes
- Optional auto-start with Windows
- Right-click menu for quick actions

---

## 🛠️ Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js ≥ 18 + TypeScript |
| WhatsApp | whatsapp-web.js (Puppeteer) |
| AI | Groq (llama-4-scout, whisper) |
| AI (local) | Ollama (optional) |
| Backend | Express.js |
| Frontend | Vanilla HTML/CSS/JS |
| Real-time | WebSocket |

---

## 📦 Installation

### Prerequisites
- **Node.js** ≥ 18
- **Groq API key** (free at [console.groq.com](https://console.groq.com))
- **Google Chrome** (used by Puppeteer for WhatsApp Web)

### Setup

```bash
# Clone the repository
git clone https://github.com/juliocorcini/groupResume-companion.git
cd groupResume-companion

# Install dependencies
npm install

# Create environment file
cp .env.example .env
# Edit .env and add your GROQ_API_KEY
```

Create a `.env` file:
```env
GROQ_API_KEY=gsk_your_api_key_here
```

### Build & Run

```bash
# Build TypeScript
npm run build

# Start the server
npm start
```

Open `http://localhost:3000` in your browser. Scan the QR code with WhatsApp.

### Windows System Tray (optional)

```bash
# Run with system tray icon
npm run tray

# Or run hidden (no console window)
npm run tray:hidden

# Auto-start setup
npm run setup
```

---

## 🎮 Usage

### Bot Commands (in groups)

| Command | Description |
|---------|-------------|
| `!resumo` | Summary of today |
| `!resumo ontem` | Summary of yesterday |
| `!resumo semana` | Summary of the last 7 days |
| `!resumo semana tópicos` | Weekly summary as topic list |
| `!ajuda` | Show all commands |
| `!status` | System status |
| `!usage` | API usage stats |
| `!apresentar` | Bot introduction message |

### DM (Private Chat)

Send any message to the bot's WhatsApp number to start an interactive session:

1. **Select a group** from the numbered list
2. **Choose a date** (today, yesterday, or custom)
3. **Pick an action**:
   - 📋 Generate summary (choose level 1-5)
   - ❓ Ask a question about the conversation
   - 🎤 Send voice notes as commands
   - 🔊 Forward audios for batch transcription

### Dashboard

Access `http://localhost:3000` for:
- 📱 QR code login
- 📊 Summary generation with group/date picker
- 📈 Usage statistics and API limits
- 📚 Summary history

---

## 📋 Summary Levels

| Level | Name | Description | Max Tokens |
|-------|------|-------------|------------|
| 1 | **Flash** | Ultra-short, 2-3 sentences | 400 |
| 2 | **Resumido** | Short paragraphs by topic | 800 |
| 3 | **Padrão** | Full summary with context and decisions | 2500 |
| 4 | **Completo** | Detailed with participants and timeline | 3500 |
| 5 | **Tópicos** | Bullet-point topic list | 2500 |

---

## 🔒 Privacy Modes

| Mode | Behavior |
|------|----------|
| **Anonymous** | No names mentioned, focus on topics only |
| **Smart** | Names only when relevant (decisions, responsibilities) |
| **With Names** | Full attribution for all messages |

All modes automatically:
- Remove emojis from display names
- Filter phone numbers and internal IDs
- Replace unreadable names with "a participant"

---

## 📁 Project Structure

```
groupResume-companion/
├── src/                    # TypeScript source code
│   ├── ai/                 # AI providers, prompts, summarizer, transcriber
│   ├── config/             # Configuration manager
│   ├── history/            # Summary history storage
│   ├── routes/             # Express API routes
│   ├── scheduler/          # Auto-summary scheduler
│   ├── usage/              # Usage tracking
│   ├── whatsapp/           # WhatsApp client, bot, DM handler, parser
│   └── server.ts           # Main entry point
├── dashboard/              # Web dashboard (HTML/CSS/JS)
├── scripts/                # Windows setup and tray scripts
├── assets/                 # Icons and resources
├── dist/                   # Compiled JavaScript (gitignored)
├── data/                   # Runtime data (gitignored)
└── .env                    # API keys (gitignored)
```

---

## ⚙️ Configuration

Configuration is managed via the dashboard settings page or directly in `config.json`:

- **AI Provider**: Groq (cloud) or Ollama (local)
- **Default summary level**: 1-5
- **Privacy mode**: anonymous, smart, with-names
- **Auto-summary**: per-group scheduling
- **Cooldown**: minimum time between group summaries

---

## 🤝 Credits

Developed by **Julio Corcini**

- Original web version: [groupResume](https://github.com/juliocorcini/groupResume)
- Desktop companion: [groupResume-companion](https://github.com/juliocorcini/groupResume-companion)

---

## 📄 License

This project is for personal and educational use. Feel free to fork and adapt.
