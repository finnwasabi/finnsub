# Stremio Auto Subtitle Translate

Automatically translate subtitles from OpenSubtitles to your preferred language in Stremio.

🌐 **Official Instance:** [stremio-translate.geanpedro.com.br](https://stremio-translate.geanpedro.com.br/)

📊 **Your Translations Dashboard:** [/admin/dashboard](https://stremio-translate.geanpedro.com.br/admin/dashboard) - Track all your translations, retry failed jobs, monitor token usage

⚙️ **Configure Addon:** [/configure](https://stremio-translate.geanpedro.com.br/configure) - Install the addon with your settings

---

## 🎯 What You Get

### Personal Translation Dashboard
Access your dashboard at [/admin/dashboard](https://stremio-translate.geanpedro.com.br/admin/dashboard):

- **View All Translations** - See every movie/show you've translated with posters and details
- **Retry Failed Jobs** - If a translation failed, click retry to reprocess it
- **Monitor Token Usage** - Track AI API costs per translation (for ChatGPT/Gemini users)
- **Search & Filter** - Find translations by title, IMDB ID, season, or episode
- **Manual Search** - Force subtitle search for content that wasn't auto-detected
- **Delete Translations** - Remove old or unwanted translations to free up space

### Supported Translation Providers
- **Google Translate** - Free, no API key needed
- **DeepL** - Professional translation service
- **OpenAI** - ChatGPT (GPT-4o, GPT-4o-mini, GPT-4-turbo, GPT-3.5-turbo)
- **Google Gemini** - Google's AI models (Gemini 2.5 Flash, Gemini 2.0 Flash)
- **OpenRouter** - Access to multiple AI models including Claude and Llama
- **Groq** - Ultra-fast inference (Llama 3.3, Mixtral)
- **Together AI** - Open-source models (Meta-Llama, Qwen, Mixtral)
- **Custom** - Any OpenAI-compatible API endpoint

### Translation Features
- **Smart Caching** - Once translated, subtitles load instantly
- **Background Processing** - Translations happen automatically while you browse
- **Automatic Retries** - Failed translations are automatically retried
- **Quality Preservation** - Timing and formatting are preserved perfectly

---

## 🚀 Quick Start

1. Visit [stremio-translate.geanpedro.com.br/configure](https://stremio-translate.geanpedro.com.br/configure)
2. Choose your translation provider and target language
3. Create a username and password (to access your dashboard)
4. Click "Install Addon" or "Open in Stremio Web"
5. Start watching! Check your [dashboard](https://stremio-translate.geanpedro.com.br/admin/dashboard) to track translations

---

## 🏠 Self-Hosting

Want to run your own instance? We provide two options:

### Option 1: Full Version with Docker (Recommended)

**Requirements:** Docker and Docker Compose

**Features:**
- MySQL database (scalable, production-ready)
- Redis queue system (Bull with job monitoring)
- Bull Board dashboard at `/admin/queues`
- Better for multiple users or high traffic

```bash
# Clone the repository
git clone https://github.com/HimAndRobot/stremio-translate-subtitle-by-geanpn.git
cd stremio-translate-subtitle-by-geanpn

# Create environment file
cp .env.example .env

# Edit .env with your settings (optional)
nano .env

# Start with Docker Compose
docker-compose up -d
```

Access the addon with local HTTPS:

```txt
https://<your-ip-with-dashes>.local-ip.medicmobile.org/configure
```

Example: if your LAN IP is `192.168.1.100`, open:

```txt
https://192-168-1-100.local-ip.medicmobile.org/configure
```

To find your correct LAN IP:

- **Windows**: run `ipconfig` and use the `IPv4 Address` from your active `Ethernet` or `Wi-Fi` adapter.
- **Mac**: run `ipconfig getifaddr en0` for Wi-Fi, or `ipconfig getifaddr en1` if needed.
- **Linux**: run `hostname -I` and use the address from your LAN interface.

On Windows, ignore virtual adapter IPs such as `vEthernet`, `WSL`, `Docker`, `Hyper-V`, or addresses like `192.168.65.x`. Use the IP from the real network adapter, for example `Ethernet` or `Wi-Fi`.

If Docker detects the wrong IP, set `HOST_IP` in `.env` before starting:

```txt
HOST_IP=192.168.1.100
```

**What's included:**
- Web server (Node.js)
- Redis (queue management)
- MySQL (database)
- Automatic restarts
- Volume persistence

### Option 2: Lightweight Version (Branch `old`)

**Requirements:** Docker and Docker Compose (or Node.js)

**Features:**
- SQLite database (single file, no setup)
- Simple in-memory queue (no Redis)
- Same dashboard and features
- Lower resource usage
- Perfect for personal use

```bash
# Clone and switch to old branch
git clone https://github.com/HimAndRobot/stremio-translate-subtitle-by-geanpn.git
cd stremio-translate-subtitle-by-geanpn
git checkout old

# Option A: Docker (Recommended)
docker-compose up -d

# Option B: Without Docker
npm install
npm start
```

**Lightweight version:**
- ✅ SQLite (no MySQL needed)
- ✅ No Redis required
- ✅ Smaller footprint
- ✅ Same dashboard features
- ✅ Docker support included
- ❌ No Bull Board queue dashboard
- ❌ Less scalable for high traffic

---

## ⚙️ Environment Variables

Create a `.env` file:

**Full Version (MySQL + Redis):**
```env
PORT=3000
BASE_URL=http://localhost:3000
DB_TYPE=mysql
MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_USER=mysql
MYSQL_PASSWORD=your-password
MYSQL_DATABASE=default
REDIS_HOST=redis
REDIS_PORT=6379
```

**Lightweight Version (SQLite):**
```env
PORT=3000
BASE_URL=http://localhost:3000
DB_TYPE=sqlite
```

---

## 📖 How It Works

1. **Watch Content** - Open any movie/show in Stremio
2. **Request Subtitles** - Addon fetches from OpenSubtitles
3. **Background Translation** - Subtitles are queued and translated
4. **First Time** - You'll see a placeholder message (translation in progress)
5. **Next Time** - Subtitles load instantly from cache

**Check Progress:** Visit your [dashboard](https://stremio-translate.geanpedro.com.br/admin/dashboard) to see translation status, retry failed jobs, or manually trigger searches.

---

## 🔧 Dashboard Features Explained

### Translations Page (`/admin/dashboard`)
- **Card View** - Each translation shows poster, title, season/episode info
- **Status Indicators** - See which translations completed, failed, or are processing
- **Quick Actions** - Retry, delete, or manual search per translation
- **Search Bar** - Filter by title, IMDB ID, or episode number

### Settings Page (`/admin/settings`)
- **Change Password** - Update your account password
- **API Settings** - View/update your translation provider and API keys
- **Language Settings** - Change target translation language

### Queue Dashboard (`/admin/queues`) - Full version only
- **Real-time Monitoring** - See active, completed, and failed jobs
- **Job Details** - View detailed logs and error messages
- **Manual Controls** - Pause, resume, or clean jobs

---

## 🔒 Security & Privacy

- **Encrypted API Keys** - Stored with AES-256 encryption
- **Hashed Passwords** - Using bcrypt (industry standard)
- **Isolated Data** - Each user's translations are private
- **Self-Hosting Option** - Complete control over your data

---

## 🐛 Support

- **Bug Reports:** geanpn@gmail.com
- **Issues:** [GitHub Issues](https://github.com/HimAndRobot/stremio-translate-subtitle-by-geanpn/issues)

---

## 📝 License

MIT - See [LICENSE](LICENSE) file

---

## 🙏 Credits

Based on [Auto-Subtitle-Translate-by-Sonsuz-Anime](https://github.com/sonsuzanime/Auto-Subtitle-Translate-by-Sonsuz-Anime) by @sonsuzanime

**Enhancements:**
- Personal dashboard with translation management
- Queue system with Bull and Redis
- MySQL support with migrations
- User authentication and accounts
- Token usage tracking per translation
- Manual search and retry capabilities
- Improved error handling
- Provider fallback system
- Better caching and performance

Thanks to @sonsuzanime for the original implementation! 🚀
