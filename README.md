# YAZE Collaboration Server v2.0

Enhanced WebSocket server for real-time collaboration in YAZE ROM editor with AI agent integration, ROM synchronization, and multimodal support.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Start server (default port 8765)
npm start

# Development mode with auto-reload
npm run dev

# Or specify custom port and options
PORT=9000 ENABLE_AI_AGENT=true npm start
```

## ✨ Features

### Core Features
- **Real-time Session Management** - Host and join collaborative sessions with 6-character codes
- **Participant Tracking** - Live participant list with join/leave notifications
- **Chat Broadcasting** - Instant message delivery to all session participants
- **Automatic Cleanup** - Heartbeat detection and session cleanup for inactive connections

### Advanced Features (v2.0)
- **🤖 AI Agent Integration** - Route queries to AI agents for ROM analysis and assistance
- **🎮 ROM Synchronization** - Share ROM edits and diffs across all participants
- **📸 Multimodal Snapshot Sharing** - Share screenshots and images with session members
- **💡 Proposal System** - Share and track AI-generated proposals with status updates
- **📊 Health Monitoring** - HTTP endpoints for health checks and metrics
- **🔒 Rate Limiting** - Per-IP rate limiting to prevent abuse
- **📝 Structured Logging** - Detailed timestamped logging for all operations

### Storage
- In-memory SQLite for fast session storage
- Persistent tables for sessions, participants, messages, ROM syncs, snapshots, proposals, and AI interactions

## 🌐 API Endpoints

### HTTP Endpoints

**Health Check:**
```bash
GET http://localhost:8765/health

Response:
{
  "status": "healthy",
  "uptime": 123456,
  "sessions": 5,
  "metrics": { ... }
}
```

**Metrics:**
```bash
GET http://localhost:8765/metrics

Response:
{
  "totalSessions": 42,
  "totalMessages": 1337,
  "totalRomSyncs": 12,
  "totalSnapshots": 8,
  "totalProposals": 15,
  "totalAIQueries": 23,
  "startTime": 1728000000000
}
```

## 📡 WebSocket Protocol

### Client → Server Messages

**Host Session:**
```json
{
  "type": "host_session",
  "payload": {
    "session_name": "Evening ROM Hack",
    "username": "scawful",
    "rom_hash": "abc123...",  // optional
    "ai_enabled": true          // optional, default true
  }
}
```

**Join Session:**
```json
{
  "type": "join_session",
  "payload": {
    "session_code": "ABC123",
    "username": "friend"
  }
}
```

**Send Chat Message:**
```json
{
  "type": "chat_message",
  "payload": {
    "sender": "scawful",
    "message": "What sprites are in room 5?",
    "message_type": "chat",      // optional: chat, system, ai
    "metadata": { ... }           // optional metadata
  }
}
```

**ROM Sync:**
```json
{
  "type": "rom_sync",
  "payload": {
    "sender": "scawful",
    "diff_data": "base64_encoded_diff...",
    "rom_hash": "sha256_hash_of_rom"
  }
}
```

**Snapshot Share:**
```json
{
  "type": "snapshot_share",
  "payload": {
    "sender": "scawful",
    "snapshot_data": "base64_encoded_image...",
    "snapshot_type": "overworld_editor"
  }
}
```

**Proposal Share:**
```json
{
  "type": "proposal_share",
  "payload": {
    "sender": "scawful",
    "proposal_data": {
      "title": "Add new sprite",
      "description": "...",
      "changes": [ ... ]
    }
  }
}
```

**Proposal Update:**
```json
{
  "type": "proposal_update",
  "payload": {
    "proposal_id": "uuid",
    "status": "accepted"  // pending, accepted, rejected
  }
}
```

**AI Query:**
```json
{
  "type": "ai_query",
  "payload": {
    "username": "scawful",
    "query": "What enemies are in the eastern palace?"
  }
}
```

**Leave Session:**
```json
{
  "type": "leave_session"
}
```

**Ping:**
```json
{
  "type": "ping"
}
```

### Server → Client Messages

**Session Hosted:**
```json
{
  "type": "session_hosted",
  "payload": {
    "session_id": "uuid",
    "session_code": "ABC123",
    "session_name": "Evening ROM Hack",
    "participants": ["scawful"],
    "rom_hash": "abc123...",
    "ai_enabled": true
  }
}
```

**Session Joined:**
```json
{
  "type": "session_joined",
  "payload": {
    "session_id": "uuid",
    "session_code": "ABC123",
    "session_name": "Evening ROM Hack",
    "participants": ["scawful", "friend"],
    "messages": []
  }
}
```

**Chat Message (Broadcast):**
```json
{
  "type": "chat_message",
  "payload": {
    "sender": "scawful",
    "message": "What sprites are in room 5?",
    "timestamp": 1709567890123,
    "message_type": "chat",
    "metadata": null
  }
}
```

**ROM Sync (Broadcast):**
```json
{
  "type": "rom_sync",
  "payload": {
    "sync_id": "uuid",
    "sender": "scawful",
    "diff_data": "base64...",
    "rom_hash": "sha256...",
    "timestamp": 1709567890123
  }
}
```

**Snapshot Shared (Broadcast):**
```json
{
  "type": "snapshot_shared",
  "payload": {
    "snapshot_id": "uuid",
    "sender": "scawful",
    "snapshot_data": "base64...",
    "snapshot_type": "overworld_editor",
    "timestamp": 1709567890123
  }
}
```

**Proposal Shared (Broadcast):**
```json
{
  "type": "proposal_shared",
  "payload": {
    "proposal_id": "uuid",
    "sender": "scawful",
    "proposal_data": { ... },
    "status": "pending",
    "timestamp": 1709567890123
  }
}
```

**Proposal Updated (Broadcast):**
```json
{
  "type": "proposal_updated",
  "payload": {
    "proposal_id": "uuid",
    "status": "accepted",
    "timestamp": 1709567890123
  }
}
```

**AI Response (Broadcast):**
```json
{
  "type": "ai_response",
  "payload": {
    "query_id": "uuid",
    "username": "scawful",
    "query": "What enemies are in the eastern palace?",
    "response": "The eastern palace contains...",
    "timestamp": 1709567890123
  }
}
```

**Participant Joined (Broadcast):**
```json
{
  "type": "participant_joined",
  "payload": {
    "username": "friend",
    "participants": ["scawful", "friend"]
  }
}
```

**Participant Left (Broadcast):**
```json
{
  "type": "participant_left",
  "payload": {
    "username": "friend",
    "participants": ["scawful"]
  }
}
```

**Server Shutdown:**
```json
{
  "type": "server_shutdown",
  "payload": {
    "message": "Server is shutting down. Please reconnect later."
  }
}
```

**Pong:**
```json
{
  "type": "pong",
  "payload": {
    "timestamp": 1709567890123
  }
}
```

**Error:**
```json
{
  "type": "error",
  "payload": {
    "error": "Session ABC123 not found"
  }
}
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8765` | Server port |
| `ENABLE_AI_AGENT` | `true` | Enable AI agent integration |
| `AI_AGENT_ENDPOINT` | `""` | External AI agent endpoint URL |

### Rate Limiting

- **Window:** 60 seconds
- **Max Messages:** 100 per IP per window
- **Max Snapshot Size:** 10 MB
- **Max ROM Diff Size:** 5 MB

## 🐳 Deployment

### Local Development
```bash
npm install
npm start
```

### Docker
```bash
# Build image
docker build -t yaze-server .

# Run container
docker run -p 8765:8765 yaze-server

# With environment variables
docker run -p 8765:8765 \
  -e ENABLE_AI_AGENT=true \
  -e AI_AGENT_ENDPOINT=http://ai-service:5000 \
  yaze-server
```

### Docker Compose
```yaml
version: '3.8'
services:
  yaze-collab:
    build: .
    ports:
      - "8765:8765"
    environment:
      - ENABLE_AI_AGENT=true
      - AI_AGENT_ENDPOINT=http://ai-service:5000
    restart: unless-stopped
```

### Heroku
```bash
heroku create yaze-collab
git push heroku main
heroku config:set ENABLE_AI_AGENT=true
```

### VPS / Cloud VM
```bash
# Clone repository
git clone https://github.com/scawful/yaze-server
cd yaze-server

# Install dependencies
npm install

# Use PM2 for process management
npm install -g pm2
pm2 start server.js --name yaze-collab
pm2 startup
pm2 save

# View logs
pm2 logs yaze-collab
```

## 🧪 Testing

### Using wscat
```bash
npm install -g wscat
wscat -c ws://localhost:8765

# Host a session
> {"type":"host_session","payload":{"session_name":"Test","username":"alice","ai_enabled":true}}

# In another terminal, join
> {"type":"join_session","payload":{"session_code":"ABC123","username":"bob"}}

# Send chat message
> {"type":"chat_message","payload":{"sender":"alice","message":"Hello!"}}

# Share ROM sync
> {"type":"rom_sync","payload":{"sender":"alice","diff_data":"YmFzZTY0...","rom_hash":"abc123..."}}

# Query AI agent
> {"type":"ai_query","payload":{"username":"alice","query":"What is in room 42?"}}
```

### Health Check
```bash
curl http://localhost:8765/health
curl http://localhost:8765/metrics
```

## 📊 Database Schema

### Sessions
- `id` - UUID primary key
- `code` - 6-character session code
- `name` - Session name
- `host` - Username of host
- `created_at` - Creation timestamp
- `rom_hash` - Current ROM hash (optional)
- `ai_enabled` - AI agent enabled flag

### Participants
- `session_id` - Foreign key to sessions
- `username` - Participant username
- `joined_at` - Join timestamp
- `last_seen` - Last activity timestamp

### Messages
- `id` - UUID primary key
- `session_id` - Foreign key to sessions
- `sender` - Username
- `message` - Message content
- `timestamp` - Timestamp
- `message_type` - Type (chat, system, ai)
- `metadata` - JSON metadata (optional)

### ROM Syncs
- `id` - UUID primary key
- `session_id` - Foreign key to sessions
- `sender` - Username
- `diff_data` - Base64 encoded diff
- `rom_hash` - SHA256 hash of ROM
- `timestamp` - Timestamp

### Snapshots
- `id` - UUID primary key
- `session_id` - Foreign key to sessions
- `sender` - Username
- `snapshot_data` - Base64 encoded image
- `snapshot_type` - Type of snapshot
- `timestamp` - Timestamp

### Proposals
- `id` - UUID primary key
- `session_id` - Foreign key to sessions
- `sender` - Username
- `proposal_data` - JSON proposal data
- `status` - Status (pending, accepted, rejected)
- `timestamp` - Timestamp

### Agent Interactions
- `id` - UUID primary key
- `session_id` - Foreign key to sessions
- `username` - Username
- `query` - Query text
- `response` - AI response (optional)
- `timestamp` - Timestamp

## 🔒 Security Considerations

### Current Implementation
- Rate limiting per IP (100 messages/minute)
- Size limits on ROM diffs and snapshots
- Input validation on all payloads
- Graceful error handling

### Recommended for Production
1. **SSL/TLS** - Use `wss://` with valid certificates
2. **Authentication** - Implement JWT tokens or OAuth
3. **Session Passwords** - Optional per-session passwords
4. **Persistent Storage** - Move to PostgreSQL or MySQL for production
5. **Monitoring** - Add logging to file/service (e.g., CloudWatch, Datadog)
6. **Backup** - Regular database backups if using persistent storage

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📝 Changelog

### v2.0.0 (2025-10-04)
- Added AI agent integration and routing
- Implemented ROM synchronization
- Added multimodal snapshot sharing
- Implemented proposal system
- Added health monitoring endpoints
- Added rate limiting
- Enhanced structured logging
- Added graceful shutdown handling
- Improved database schema

### v1.0.0
- Initial release
- Basic session management
- Chat broadcasting
- Participant tracking

## 📄 License

MIT

## 🔗 Related Projects

- [YAZE](https://github.com/scawful/yaze) - Main YAZE ROM editor
- [Agent Editor Docs](https://github.com/scawful/yaze/blob/master/src/app/editor/agent/README.md)

## 💬 Support

For issues and questions:
- GitHub Issues: https://github.com/scawful/yaze-server/issues
- YAZE Discord: [Join Server]

---

**Built with ❤️ for the YAZE ROM hacking community**
