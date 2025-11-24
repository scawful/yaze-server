#!/usr/bin/env node
/**
 * YAZE Collaboration Server v2.0
 * 
 * Enhanced WebSocket server for real-time YAZE editor collaboration.
 * Features:
 * - Session management with participant tracking
 * - Real-time message broadcasting
 * - AI agent integration and routing
 * - ROM synchronization and diff broadcasting
 * - Multimodal snapshot sharing
 * - Proposal management and distribution
 * - Health monitoring and metrics
 * - Rate limiting and security
 */

const WebSocket = require('ws');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { genkit, z } = require('genkit');
const { googleAI } = require('@genkit-ai/google-genai');
const { expressHandler } = require('@genkit-ai/express');


// Configuration
const PORT = process.env.PORT || 8765;
const MAX_SNAPSHOT_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROM_DIFF_SIZE = 5 * 1024 * 1024; // 5MB
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = parseInt(process.env.RATE_LIMIT_MAX_MESSAGES) || 100;
const JOIN_LIMIT_WINDOW = 60000; // 1 minute
const JOIN_LIMIT_MAX_ATTEMPTS = parseInt(process.env.JOIN_LIMIT_MAX_ATTEMPTS) || 10;
const ENABLE_AI_AGENT = process.env.ENABLE_AI_AGENT !== 'false';
const AI_AGENT_ENDPOINT = process.env.AI_AGENT_ENDPOINT || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
// Persistence configuration
const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || ':memory:';
// Admin API key for protected endpoints
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
// Protocol and client gating
const PROTOCOL_VERSION = process.env.PROTOCOL_VERSION || '1.0.0';
const PROTOCOL_MAJOR = PROTOCOL_VERSION.split('.')[0];
// CORS / origin allowlist for HTTP + WebSocket
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
// WASM room auth
const WASM_TOKEN_SECRET = process.env.WASM_TOKEN_SECRET || '';
const WASM_REQUIRE_TOKEN = process.env.WASM_REQUIRE_TOKEN === 'true';
// WASM presence / cleanup
const WASM_IDLE_TIMEOUT_MS = parseInt(process.env.WASM_IDLE_TIMEOUT_MS, 10) || 60000;
const WASM_HEARTBEAT_INTERVAL_MS = parseInt(process.env.WASM_HEARTBEAT_INTERVAL_MS, 10) || 15000;
// WASM state persistence
const WASM_STATE_PERSIST = process.env.WASM_STATE_PERSIST === 'true';
const WASM_STATE_DIR = process.env.WASM_STATE_DIR || path.join(__dirname, 'data', 'wasm-state');
const WASM_MAX_STATE_EVENTS = parseInt(process.env.WASM_MAX_STATE_EVENTS, 10) || 500;

// Rate limiting tracker
const rateLimitMap = new Map(); // ip -> { count, resetTime }
const joinLimitMap = new Map(); // ip -> { count, resetTime }

// Database setup (initialized in startServer)
let db = null;
let SQL = null;

// Save database to file periodically (for file-based persistence)
function saveDatabase() {
  if (db && SQLITE_DB_PATH !== ':memory:') {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(SQLITE_DB_PATH, buffer);
    } catch (err) {
      console.error('Error saving database:', err);
    }
  }
}

async function initDatabase() {
  SQL = await initSqlJs();

  // Load existing database or create new one
  if (SQLITE_DB_PATH !== ':memory:' && fs.existsSync(SQLITE_DB_PATH)) {
    try {
      const fileBuffer = fs.readFileSync(SQLITE_DB_PATH);
      db = new SQL.Database(fileBuffer);
      console.log(`✓ Loaded existing SQLite database from ${SQLITE_DB_PATH}`);
    } catch (err) {
      console.log(`✓ Creating new SQLite database at ${SQLITE_DB_PATH}`);
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
    const dbType = SQLITE_DB_PATH === ':memory:' ? 'in-memory' : `file (${SQLITE_DB_PATH})`;
    console.log(`✓ Created ${dbType} SQLite database`);
  }

  // Initialize database schema
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rom_hash TEXT,
      ai_enabled INTEGER DEFAULT 1,
      password_hash TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS participants (
      session_id TEXT NOT NULL,
      username TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      message_type TEXT DEFAULT 'chat',
      metadata TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS rom_syncs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      diff_data TEXT NOT NULL,
      rom_hash TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      snapshot_data TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS proposals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      proposal_data TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_interactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      username TEXT NOT NULL,
      query TEXT NOT NULL,
      response TEXT,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  console.log('✓ Database schema initialized');

  // Save database periodically for file-based persistence
  if (SQLITE_DB_PATH !== ':memory:') {
    setInterval(saveDatabase, 30000); // Save every 30 seconds
  }

  return db;
}

// Active WebSocket connections by session
const sessions = new Map(); // session_code -> Set<WebSocket>

// Metrics tracking
const metrics = {
  totalSessions: 0,
  totalMessages: 0,
  totalRomSyncs: 0,
  totalSnapshots: 0,
  totalProposals: 0,
  totalAIQueries: 0,
  wasmJoins: 0,
  wasmLeaves: 0,
  wasmHeartbeatPruned: 0,
  protocolVersion: PROTOCOL_VERSION,
  latencyBuckets: {
    lt50: 0,
    lt100: 0,
    lt250: 0,
    lt500: 0,
    lt1000: 0,
    gte1000: 0
  },
  startTime: Date.now()
};

// Lightweight rooms for WASM clients using the simple collaboration protocol
// documented in docs/public/deployment/collaboration-server-setup.md.
const wasmRooms = new Map(); // room_code -> { name, users: Map<user_id, {...}> }

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

const app = express();
app.use(express.json());

// Basic CORS + origin enforcement
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, admin_key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

// Genkit Configuration
const ai = genkit({
    plugins: [googleAI()],
    logLevel: "debug",
    enableTracingAndMetrics: true,
});

const yazeHelloFlow = ai.defineFlow(
    {
        name: 'yazeHello',
        inputSchema: z.string(),
        outputSchema: z.string(),
    },
    async (name) => {
        return `Hello, ${name}! This is a Genkit flow running in yaze-server.`;
    }
);

app.post('/yazeHello', expressHandler(yazeHelloFlow));


// Create HTTP server for health checks
app.get('/health', (req, res) => {
    // Detect if request came through TLS proxy (X-Forwarded-Proto header)
    const tlsEnabled = req.headers['x-forwarded-proto'] === 'https' ||
                       req.secure ||
                       req.headers['x-forwarded-ssl'] === 'on';
    res.status(200).json({
        status: 'healthy',
        version: '2.1',
        uptime: Date.now() - metrics.startTime,
        sessions: sessions.size,
        wasm_rooms: wasmRooms.size,
        wasm_users: currentWasmUserCount(),
        total_connections: wss ? wss.clients.size : 0,
        protocol_version: PROTOCOL_VERSION,
        ai: {
          enabled: ENABLE_AI_AGENT,
          configured: !!(GEMINI_API_KEY || AI_AGENT_ENDPOINT),
          provider: GEMINI_API_KEY ? 'gemini' : (AI_AGENT_ENDPOINT ? 'external' : 'none')
        },
        tls: {
          detected: tlsEnabled,
          note: tlsEnabled ? 'Request via TLS proxy' : 'Plain HTTP (consider TLS proxy)'
        },
        persistence: {
          type: SQLITE_DB_PATH === ':memory:' ? 'memory' : 'file',
          path: SQLITE_DB_PATH === ':memory:' ? null : SQLITE_DB_PATH
        },
        wasm_persistence: {
          enabled: WASM_STATE_PERSIST,
          dir: WASM_STATE_PERSIST ? WASM_STATE_DIR : null
        },
        cors: {
          allowed_origins: ALLOWED_ORIGINS
        },
        limits: {
          rate_limit_per_min: RATE_LIMIT_MAX_MESSAGES,
          join_limit_per_min: JOIN_LIMIT_MAX_ATTEMPTS,
          max_rom_diff_mb: MAX_ROM_DIFF_SIZE / (1024 * 1024),
          max_snapshot_mb: MAX_SNAPSHOT_SIZE / (1024 * 1024)
        }
    });
});

app.get('/metrics', (req, res) => {
    res.status(200).json(buildMetricsSnapshot());
});

// ---------------------------------------------------------------------------
// Admin endpoints (require ADMIN_API_KEY if set)
// ---------------------------------------------------------------------------
function adminAuth(req, res, next) {
  if (!ADMIN_API_KEY) {
    return next(); // No auth required if not configured
  }
  const providedKey = req.headers['x-admin-key'] || req.query.admin_key;
  if (providedKey !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// List all active sessions/rooms
app.get('/admin/sessions', adminAuth, async (req, res) => {
  try {
    const dbSessions = await allAsync(db,
      'SELECT id, code, name, host, created_at, ai_enabled FROM sessions ORDER BY created_at DESC',
      []
    );
    const wasmRoomList = Array.from(wasmRooms.entries()).map(([code, room]) => ({
      code,
      name: room.name,
      user_count: room.users.size,
      type: 'wasm'
    }));
    res.json({
      sessions: dbSessions.map(s => ({
        ...s,
        active_connections: sessions.get(s.code)?.size || 0,
        type: 'full'
      })),
      wasm_rooms: wasmRoomList,
      total_connections: wss.clients.size
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List users in a specific session/room
app.get('/admin/sessions/:code/users', adminAuth, async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    // Check full sessions first
    const session = await getAsync(db, 'SELECT id FROM sessions WHERE code = ?', [code]);
    if (session) {
      const participants = await allAsync(db,
        'SELECT username, joined_at, last_seen FROM participants WHERE session_id = ?',
        [session.id]
      );
      return res.json({ code, type: 'full', users: participants });
    }
    // Check WASM rooms
    const wasmRoom = wasmRooms.get(code);
    if (wasmRoom) {
      const users = Array.from(wasmRoom.users.values()).map(u => ({
        id: u.id,
        name: u.name,
        color: u.color
      }));
      return res.json({ code, type: 'wasm', users });
    }
    res.status(404).json({ error: `Session ${code} not found` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Close a session/room (kick all users)
app.delete('/admin/sessions/:code', adminAuth, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const reason = req.body?.reason || 'Session closed by administrator';
  try {
    // Close full session
    const sessionSet = sessions.get(code);
    if (sessionSet) {
      sessionSet.forEach((ws) => {
        sendMessage(ws, { type: 'error', payload: { error: reason } });
        ws.close();
      });
      sessions.delete(code);
      await runAsync(db, 'DELETE FROM participants WHERE session_id IN (SELECT id FROM sessions WHERE code = ?)', [code]);
      await runAsync(db, 'DELETE FROM sessions WHERE code = ?', [code]);
    }
    // Close WASM room
    const wasmRoom = wasmRooms.get(code);
    if (wasmRoom) {
      wasmRoom.users.forEach((user) => {
        sendMessage(user.ws, { type: 'error', message: reason, payload: { error: reason } });
        user.ws.close();
      });
      wasmRooms.delete(code);
    }
    if (!sessionSet && !wasmRoom) {
      return res.status(404).json({ error: `Session ${code} not found` });
    }
    console.log(`🔒 Admin closed session ${code}: ${reason}`);
    res.json({ success: true, code, reason });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Kick a specific user from a session
app.delete('/admin/sessions/:code/users/:userId', adminAuth, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const userId = req.params.userId;
  const reason = req.body?.reason || 'Kicked by administrator';
  try {
    // Full session
    const sessionSet = sessions.get(code);
    if (sessionSet) {
      for (const ws of sessionSet) {
        if (ws.username === userId) {
          sendMessage(ws, { type: 'error', payload: { error: reason } });
          ws.close();
          console.log(`🔒 Admin kicked ${userId} from ${code}: ${reason}`);
          return res.json({ success: true, code, userId, reason });
        }
      }
    }
    // WASM room
    const wasmRoom = wasmRooms.get(code);
    if (wasmRoom) {
      const user = wasmRoom.users.get(userId);
      if (user) {
        sendMessage(user.ws, { type: 'error', message: reason, payload: { error: reason } });
        user.ws.close();
        wasmRoom.users.delete(userId);
        broadcastWasmUserList(code);
        console.log(`🔒 Admin kicked ${userId} from ${code}: ${reason}`);
        return res.json({ success: true, code, userId, reason });
      }
    }
    res.status(404).json({ error: `User ${userId} not found in session ${code}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Broadcast message to all users in a session
app.post('/admin/sessions/:code/broadcast', adminAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  const { message, message_type = 'admin' } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }
  let count = 0;
  // Full session
  const sessionSet = sessions.get(code);
  if (sessionSet) {
    sessionSet.forEach((ws) => {
      sendMessage(ws, {
        type: 'chat_message',
        payload: { sender: 'ADMIN', message, message_type, timestamp: Date.now() }
      });
      count++;
    });
  }
  // WASM room
  const wasmRoom = wasmRooms.get(code);
  if (wasmRoom) {
    wasmRoom.users.forEach((user) => {
      sendMessage(user.ws, {
        type: 'chat_message',
        sender: 'ADMIN',
        message,
        message_type,
        timestamp: Date.now()
      });
      count++;
    });
  }
  if (count === 0) {
    return res.status(404).json({ error: `Session ${code} not found or empty` });
  }
  console.log(`📢 Admin broadcast to ${code}: ${message}`);
  res.json({ success: true, code, recipients: count });
});

// WASM-only admin helpers
app.get('/admin/wasm/rooms', adminAuth, (req, res) => {
  const rooms = Array.from(wasmRooms.entries()).map(([code, room]) => ({
    code,
    name: room.name,
    users: Array.from(room.users.values()).map((u) => ({
      id: u.id,
      name: u.name,
      color: u.color,
      last_activity: u.last_activity || null
    })),
    user_count: room.users.size,
    password_protected: !!room.password_hash,
    state_events: room.state_log ? room.state_log.length : 0,
    persisted: WASM_STATE_PERSIST
  }));
  res.json({ rooms, total: rooms.length });
});

app.delete('/admin/wasm/rooms/:code', adminAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  const room = wasmRooms.get(code);
  if (!room) {
    return res.status(404).json({ error: `WASM room ${code} not found` });
  }
  room.users.forEach((user) => {
    sendMessage(user.ws, { type: 'error', message: 'Room closed by admin', payload: { error: 'Room closed by admin' } });
    user.ws.close();
  });
  wasmRooms.delete(code);
  persistWasmState(code);
  res.json({ success: true, code });
});

app.post('/admin/wasm/rooms/:code/broadcast', adminAuth, (req, res) => {
  const code = req.params.code.toUpperCase();
  const { message, message_type = 'admin' } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }
  const room = wasmRooms.get(code);
  if (!room) {
    return res.status(404).json({ error: `WASM room ${code} not found` });
  }
  let recipients = 0;
  room.users.forEach((user) => {
    sendMessage(user.ws, {
      type: 'chat_message',
      sender: 'ADMIN',
      message,
      message_type,
      timestamp: Date.now()
    });
    recipients++;
  });
  res.json({ success: true, code, recipients });
});

app.post('/admin/wasm/rooms/:code/token', adminAuth, (req, res) => {
  if (!WASM_TOKEN_SECRET) {
    return res.status(400).json({ error: 'WASM_TOKEN_SECRET not configured' });
  }
  const code = req.params.code.toUpperCase();
  const { user_id, expires_in = 3600 } = req.body || {};
  if (!user_id) {
    return res.status(400).json({ error: 'user_id required' });
  }
  const exp = Date.now() + Number(expires_in) * 1000;
  const token = generateWasmToken(code, user_id, exp);
  res.json({ token, expires_at: exp });
});

const server = http.createServer(app);

// WebSocket server
const wss = new WebSocket.Server({ server });

// Start server after database initialization
async function startServer() {
  await initDatabase();
  ensureWasmStateDir();

  server.listen(PORT, () => {
    console.log(`🚀 YAZE Collaboration Server v2.0 listening on port ${PORT}`);
    console.log(`   HTTP Health Check: http://localhost:${PORT}/health`);
    console.log(`   WebSocket: ws://localhost:${PORT}`);
    console.log(`   Genkit Flow: POST http://localhost:${PORT}/yazeHello`);
    console.log(`   AI Agent: ${ENABLE_AI_AGENT ? 'Enabled' : 'Disabled'}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }
  const clientIp = req.socket.remoteAddress;
  console.log(`📡 New client connected from ${clientIp}`);
  
  ws.sessionId = null;
  ws.username = null;
  ws.isAlive = true;
  ws.clientIp = clientIp;
  ws.messageCount = 0;
  ws.lastMessageTime = Date.now();
  ws.lastActivity = Date.now();
  ws.wasmRoom = null;
  ws.wasmUserId = null;
  ws.protocolVersion = null;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('message', async (data) => {
    try {
      const start = Date.now();
      // Rate limiting check
      if (!checkRateLimit(ws)) {
        sendError(ws, 'Rate limit exceeded. Please slow down.');
        return;
      }
      
      const message = JSON.parse(data.toString());
      await handleMessage(ws, message);
      recordLatency(Date.now() - start);
      
      ws.messageCount++;
      ws.lastMessageTime = Date.now();
      ws.lastActivity = ws.lastMessageTime;
      touchWasmUser(ws);
    } catch (error) {
      console.error('Error handling message:', error);
      sendError(ws, 'Invalid message format');
    }
  });
  
  ws.on('close', () => {
    handleDisconnect(ws);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Heartbeat to detect broken connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      handleDisconnect(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const wasmHeartbeat = setInterval(cleanupWasmRooms, WASM_HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(wasmHeartbeat);
});

// Rate limiting
function checkRateLimit(ws) {
  const now = Date.now();
  const key = ws.clientIp;
  
  if (!rateLimitMap.has(key)) {
    rateLimitMap.set(key, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return true;
  }
  
  const limit = rateLimitMap.get(key);
  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + RATE_LIMIT_WINDOW;
    return true;
  }
  
  if (limit.count >= RATE_LIMIT_MAX_MESSAGES) {
    return false;
  }
  
  limit.count++;
  return true;
}

function checkJoinRateLimit(ws) {
  const now = Date.now();
  const key = ws.clientIp;

  if (!joinLimitMap.has(key)) {
    joinLimitMap.set(key, { count: 1, resetTime: now + JOIN_LIMIT_WINDOW });
    return true;
  }

  const limit = joinLimitMap.get(key);
  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + JOIN_LIMIT_WINDOW;
    return true;
  }

  if (limit.count >= JOIN_LIMIT_MAX_ATTEMPTS) {
    return false;
  }

  limit.count++;
  return true;
}

// Message handlers
async function handleMessage(ws, message) {
  const { type, payload } = message;
  
  logMessage('RECV', type, ws.username || 'anonymous', payload);
  
  switch (type) {
    case 'host_session':
      await handleHostSession(ws, payload);
      break;
    case 'join_session':
      await handleJoinSession(ws, payload);
      break;
    case 'leave_session':
      await handleLeaveSession(ws);
      break;
    case 'chat_message':
      await handleChatMessage(ws, payload);
      break;
    case 'rom_sync':
      await handleRomSync(ws, payload);
      break;
    case 'snapshot_share':
      await handleSnapshotShare(ws, payload);
      break;
    case 'proposal_share':
      await handleProposalShare(ws, payload);
      break;
    case 'proposal_update':
      await handleProposalUpdate(ws, payload);
      break;
    case 'proposal_vote':
      await handleProposalVote(ws, payload);
      break;
    case 'ai_query':
      await handleAIQuery(ws, payload);
      break;
    case 'create':  // WASM protocol: create a session with provided code
      await handleWasmCreate(ws, message);
      break;
    case 'join':  // WASM protocol: join existing session by code
      await handleWasmJoin(ws, message);
      break;
    case 'leave':  // WASM protocol: leave current session
      handleWasmLeave(ws);
      break;
    case 'change':  // WASM protocol: ROM byte-range patch
      handleWasmChange(ws, message);
      break;
    case 'cursor':  // WASM protocol: cursor/presence update
      handleWasmCursor(ws, message);
      break;
    case 'ping':
      sendMessage(ws, { type: 'pong', payload: { timestamp: Date.now() } });
      break;
    default:
      sendError(ws, `Unknown message type: ${type}`);
  }
}

async function handleHostSession(ws, payload) {
  const { session_name, username, rom_hash = null, ai_enabled = true, session_password = null } = payload;
  
  if (!session_name || !username) {
    return sendError(ws, 'session_name and username required');
  }

  if (!checkJoinRateLimit(ws)) {
    return sendError(ws, 'Too many host attempts. Please wait a moment.');
  }
  
  const sessionId = uuidv4();
  const sessionCode = generateSessionCode();
  const now = Date.now();
  const passwordHash = session_password ? generateHash(session_password) : null;
  
  try {
    await runAsync(db, 
      'INSERT INTO sessions (id, code, name, host, created_at, rom_hash, ai_enabled, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [sessionId, sessionCode, session_name, username, now, rom_hash, ai_enabled ? 1 : 0, passwordHash]
    );
    
    await runAsync(db,
      'INSERT INTO participants (session_id, username, joined_at, last_seen) VALUES (?, ?, ?, ?)',
      [sessionId, username, now, now]
    );
    
    ws.sessionId = sessionId;
    ws.username = username;
    
    if (!sessions.has(sessionCode)) {
      sessions.set(sessionCode, new Set());
    }
    sessions.get(sessionCode).add(ws);
    
    metrics.totalSessions++;
    
    sendMessage(ws, {
      type: 'session_hosted',
      payload: {
        session_id: sessionId,
        session_code: sessionCode,
        session_name: session_name,
        participants: [username],
        rom_hash,
        ai_enabled,
        password_protected: !!passwordHash
      }
    });
    
    console.log(`✓ Session hosted: ${sessionCode} by ${username} (AI: ${ai_enabled ? 'enabled' : 'disabled'})`);
  } catch (error) {
    console.error('Error hosting session:', error);
    sendError(ws, 'Failed to host session');
  }
}

async function handleJoinSession(ws, payload) {
  const { session_code, username, session_password = null } = payload;
  
  if (!session_code || !username) {
    return sendError(ws, 'session_code and username required');
  }

  if (!checkJoinRateLimit(ws)) {
    return sendError(ws, 'Too many join attempts. Please wait a moment.');
  }
  
  try {
    const session = await getAsync(db,
      'SELECT * FROM sessions WHERE code = ?',
      [session_code.toUpperCase()]
    );
    
    if (!session) {
      return sendError(ws, `Session ${session_code} not found`);
    }

    // Password check if required
    if (session.password_hash) {
      const providedHash = session_password ? generateHash(session_password) : null;
      if (!providedHash || providedHash !== session.password_hash) {
        return sendError(ws, 'Invalid session password');
      }
    }
    
    // Check if user already in session
    const existing = await getAsync(db,
      'SELECT * FROM participants WHERE session_id = ? AND username = ?',
      [session.id, username]
    );
    
    const joinTime = Date.now();
    
    if (!existing) {
      await runAsync(db,
        'INSERT INTO participants (session_id, username, joined_at, last_seen) VALUES (?, ?, ?, ?)',
        [session.id, username, joinTime, joinTime]
      );
    } else {
      // Update last_seen if rejoining
      await runAsync(db,
        'UPDATE participants SET last_seen = ? WHERE session_id = ? AND username = ?',
        [joinTime, session.id, username]
      );
    }
    
    ws.sessionId = session.id;
    ws.username = username;
    
    if (!sessions.has(session_code.toUpperCase())) {
      sessions.set(session_code.toUpperCase(), new Set());
    }
    sessions.get(session_code.toUpperCase()).add(ws);
    
    // Get all participants
    const participants = await allAsync(db,
      'SELECT username FROM participants WHERE session_id = ? ORDER BY joined_at',
      [session.id]
    );
    
    // Get recent messages
    const messages = await allAsync(db,
      'SELECT sender, message, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT 50',
      [session.id]
    );
    
    sendMessage(ws, {
      type: 'session_joined',
      payload: {
        session_id: session.id,
        session_code: session.code,
        session_name: session.name,
        participants: participants.map(p => p.username),
        messages: messages.reverse()
      }
    });
    
    // Notify others
    broadcast(session.code, ws, {
      type: 'participant_joined',
      payload: {
        username: username,
        participants: participants.map(p => p.username)
      }
    });
    
    console.log(`✓ ${username} joined session ${session.code}`);
  } catch (error) {
    console.error('Error joining session:', error);
    sendError(ws, 'Failed to join session');
  }
}

async function handleLeaveSession(ws) {
  if (!ws.sessionId) {
    return;
  }
  
  try {
    const session = await getAsync(db,
      'SELECT code FROM sessions WHERE id = ?',
      [ws.sessionId]
    );
    
    if (session) {
      await runAsync(db,
        'DELETE FROM participants WHERE session_id = ? AND username = ?',
        [ws.sessionId, ws.username]
      );
      
      const sessionSet = sessions.get(session.code);
      if (sessionSet) {
        sessionSet.delete(ws);
        if (sessionSet.size === 0) {
          sessions.delete(session.code);
        }
      }
      
      // Notify others
      const participants = await allAsync(db,
        'SELECT username FROM participants WHERE session_id = ?',
        [ws.sessionId]
      );
      
      broadcast(session.code, null, {
        type: 'participant_left',
        payload: {
          username: ws.username,
          participants: participants.map(p => p.username)
        }
      });
      
      console.log(`✓ ${ws.username} left session ${session.code}`);
    }
    
    ws.sessionId = null;
    ws.username = null;
  } catch (error) {
    console.error('Error leaving session:', error);
  }
}

async function handleChatMessage(ws, payload) {
  if (!ws.sessionId) {
    return sendError(ws, 'Not in a session');
  }
  
  const { message, sender, message_type = 'chat', metadata = null } = payload;
  const messageId = uuidv4();
  const timestamp = Date.now();
  
  try {
    await runAsync(db,
      'INSERT INTO messages (id, session_id, sender, message, timestamp, message_type, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [messageId, ws.sessionId, sender, message, timestamp, message_type, metadata ? JSON.stringify(metadata) : null]
    );
    
    const session = await getAsync(db,
      'SELECT code FROM sessions WHERE id = ?',
      [ws.sessionId]
    );
    
    if (session) {
      metrics.totalMessages++;
      
      broadcast(session.code, null, {
        type: 'chat_message',
        payload: {
          sender,
          message,
          timestamp,
          message_type,
          metadata
        }
      });
      
      console.log(`💬 [${session.code}] ${sender}: ${message.substring(0, 50)}...`);
    }
  } catch (error) {
    console.error('Error handling chat message:', error);
    sendError(ws, 'Failed to send message');
  }
}

async function handleRomSync(ws, payload) {
  if (!ws.sessionId) {
    return sendError(ws, 'Not in a session');
  }
  
  const { diff_data, rom_hash, sender } = payload;
  
  if (!diff_data || !rom_hash) {
    return sendError(ws, 'diff_data and rom_hash required');
  }
  
  // Check size limit
  const diffSize = Buffer.byteLength(diff_data, 'utf8');
  if (diffSize > MAX_ROM_DIFF_SIZE) {
    return sendError(ws, `ROM diff too large (${diffSize} bytes, max ${MAX_ROM_DIFF_SIZE})`);
  }
  
  const syncId = uuidv4();
  const timestamp = Date.now();
  
  try {
    await runAsync(db,
      'INSERT INTO rom_syncs (id, session_id, sender, diff_data, rom_hash, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      [syncId, ws.sessionId, sender, diff_data, rom_hash, timestamp]
    );
    
    // Update session ROM hash
    await runAsync(db,
      'UPDATE sessions SET rom_hash = ? WHERE id = ?',
      [rom_hash, ws.sessionId]
    );
    
    const session = await getAsync(db,
      'SELECT code FROM sessions WHERE id = ?',
      [ws.sessionId]
    );
    
    if (session) {
      metrics.totalRomSyncs++;
      
      broadcast(session.code, ws, {
        type: 'rom_sync',
        payload: {
          sync_id: syncId,
          sender,
          diff_data,
          rom_hash,
          timestamp
        }
      });
      
      console.log(`🎮 [${session.code}] ${sender} synced ROM (${diffSize} bytes)`);
    }
  } catch (error) {
    console.error('Error handling ROM sync:', error);
    sendError(ws, 'Failed to sync ROM');
  }
}

async function handleSnapshotShare(ws, payload) {
  if (!ws.sessionId) {
    return sendError(ws, 'Not in a session');
  }
  
  const { snapshot_data, snapshot_type, sender } = payload;
  
  if (!snapshot_data || !snapshot_type) {
    return sendError(ws, 'snapshot_data and snapshot_type required');
  }
  
  // Check size limit
  const snapshotSize = Buffer.byteLength(snapshot_data, 'utf8');
  if (snapshotSize > MAX_SNAPSHOT_SIZE) {
    return sendError(ws, `Snapshot too large (${snapshotSize} bytes, max ${MAX_SNAPSHOT_SIZE})`);
  }
  
  const snapshotId = uuidv4();
  const timestamp = Date.now();
  
  try {
    await runAsync(db,
      'INSERT INTO snapshots (id, session_id, sender, snapshot_data, snapshot_type, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      [snapshotId, ws.sessionId, sender, snapshot_data, snapshot_type, timestamp]
    );
    
    const session = await getAsync(db,
      'SELECT code FROM sessions WHERE id = ?',
      [ws.sessionId]
    );
    
    if (session) {
      metrics.totalSnapshots++;
      
      broadcast(session.code, ws, {
        type: 'snapshot_shared',
        payload: {
          snapshot_id: snapshotId,
          sender,
          snapshot_data,
          snapshot_type,
          timestamp
        }
      });
      
      console.log(`📸 [${session.code}] ${sender} shared snapshot (${snapshotSize} bytes, type: ${snapshot_type})`);
    }
  } catch (error) {
    console.error('Error handling snapshot share:', error);
    sendError(ws, 'Failed to share snapshot');
  }
}

async function handleProposalShare(ws, payload) {
  if (!ws.sessionId) {
    return sendError(ws, 'Not in a session');
  }
  
  const { proposal_data, sender } = payload;
  
  if (!proposal_data) {
    return sendError(ws, 'proposal_data required');
  }
  
  const proposalId = uuidv4();
  const timestamp = Date.now();
  
  try {
    await runAsync(db,
      'INSERT INTO proposals (id, session_id, sender, proposal_data, status, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
      [proposalId, ws.sessionId, sender, JSON.stringify(proposal_data), 'pending', timestamp]
    );
    
    const session = await getAsync(db,
      'SELECT code FROM sessions WHERE id = ?',
      [ws.sessionId]
    );
    
    if (session) {
      metrics.totalProposals++;
      
      broadcast(session.code, ws, {
        type: 'proposal_shared',
        payload: {
          proposal_id: proposalId,
          sender,
          proposal_data,
          status: 'pending',
          timestamp
        }
      });
      
      console.log(`💡 [${session.code}] ${sender} shared proposal`);
    }
  } catch (error) {
    console.error('Error handling proposal share:', error);
    sendError(ws, 'Failed to share proposal');
  }
}

async function handleProposalVote(ws, payload) {
  if (!ws.sessionId) {
    return sendError(ws, 'Not in a session');
  }
  
  const { proposal_id, approved, username } = payload;
  
  if (!proposal_id || approved === undefined || !username) {
    return sendError(ws, 'proposal_id, approved, and username required');
  }
  
  try {
    // Get the proposal
    const proposal = await getAsync(db,
      'SELECT * FROM proposals WHERE id = ? AND session_id = ?',
      [proposal_id, ws.sessionId]
    );
    
    if (!proposal) {
      return sendError(ws, `Proposal ${proposal_id} not found`);
    }
    
    // Parse current proposal data
    let proposalData = JSON.parse(proposal.proposal_data);
    if (!proposalData.votes) {
      proposalData.votes = {};
    }
    
    // Record vote
    proposalData.votes[username] = approved;
    
    // Update proposal with vote
    await runAsync(db,
      'UPDATE proposals SET proposal_data = ? WHERE id = ?',
      [JSON.stringify(proposalData), proposal_id]
    );
    
    // Get session for broadcast
    const session = await getAsync(db,
      'SELECT code, ai_enabled FROM sessions WHERE id = ?',
      [ws.sessionId]
    );
    
    if (session) {
      // Broadcast vote to all participants
      broadcast(session.code, null, {
        type: 'proposal_vote_received',
        payload: {
          proposal_id,
          username,
          approved,
          votes: proposalData.votes,
          timestamp: Date.now()
        }
      });
      
      console.log(`🗳️  [${session.code}] ${username} voted ${approved ? 'approve' : 'reject'} on proposal ${proposal_id}`);
    }
  } catch (error) {
    console.error('Error handling proposal vote:', error);
    sendError(ws, 'Failed to record vote');
  }
}

async function handleProposalUpdate(ws, payload) {
  if (!ws.sessionId) {
    return sendError(ws, 'Not in a session');
  }
  
  const { proposal_id, status } = payload;
  
  if (!proposal_id || !status) {
    return sendError(ws, 'proposal_id and status required');
  }
  
  try {
    await runAsync(db,
      'UPDATE proposals SET status = ? WHERE id = ? AND session_id = ?',
      [status, proposal_id, ws.sessionId]
    );
    
    const session = await getAsync(db,
      'SELECT code FROM sessions WHERE id = ?',
      [ws.sessionId]
    );
    
    if (session) {
      broadcast(session.code, null, {
        type: 'proposal_updated',
        payload: {
          proposal_id,
          status,
          timestamp: Date.now()
        }
      });
      
      console.log(`✅ [${session.code}] Proposal ${proposal_id} updated to ${status}`);
    }
  } catch (error) {
    console.error('Error handling proposal update:', error);
    sendError(ws, 'Failed to update proposal');
  }
}

async function handleAIQuery(ws, payload) {
  if (!ws.sessionId) {
    return sendError(ws, 'Not in a session');
  }
  
  const { query, username } = payload;
  
  if (!query) {
    return sendError(ws, 'query required');
  }
  
  const queryId = uuidv4();
  const timestamp = Date.now();
  
  try {
    // Check if AI is enabled for this session
    const session = await getAsync(db,
      'SELECT code, ai_enabled FROM sessions WHERE id = ?',
      [ws.sessionId]
    );
    
    if (!session || !session.ai_enabled) {
      return sendError(ws, 'AI agent not enabled for this session');
    }
    
    if (!ENABLE_AI_AGENT) {
      return sendError(ws, 'AI agent not configured on server');
    }
    if (!GEMINI_API_KEY && !AI_AGENT_ENDPOINT) {
      return sendError(ws, 'AI agent key/endpoint not configured');
    }
    
    // Store interaction
    await runAsync(db,
      'INSERT INTO agent_interactions (id, session_id, username, query, timestamp) VALUES (?, ?, ?, ?, ?)',
      [queryId, ws.sessionId, username, query, timestamp]
    );
    
    metrics.totalAIQueries++;
    
    let responseText = 'AI agent not available';

    if (AI_AGENT_ENDPOINT) {
      // Proxy mode: send to external agent endpoint
      try {
        const res = await fetch(AI_AGENT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, username, session: session.code })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        responseText = data.response || JSON.stringify(data);
      } catch (e) {
        responseText = `AI agent error: ${e.message}`;
      }
    } else if (GEMINI_API_KEY) {
      // Direct Gemini call
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: query }]}]
          })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const candidate = data?.candidates?.[0];
        const part = candidate?.content?.parts?.[0];
        responseText = part?.text || 'No response from Gemini';
      } catch (e) {
        responseText = `Gemini error: ${e.message}`;
      }
    }
    
    // Update interaction with response
    await runAsync(db,
      'UPDATE agent_interactions SET response = ? WHERE id = ?',
      [responseText, queryId]
    );
    
    // Broadcast AI response to all participants
    broadcast(session.code, null, {
      type: 'ai_response',
      payload: {
        query_id: queryId,
        username,
        query,
        response: responseText,
        timestamp: Date.now()
      }
    });
    
    console.log(`🤖 [${session.code}] AI query from ${username}`);
  } catch (error) {
    console.error('Error handling AI query:', error);
    sendError(ws, 'Failed to process AI query');
  }
}

function handleDisconnect(ws) {
  if (ws.sessionId) {
    handleLeaveSession(ws);
  }
  if (ws.wasmRoom && ws.wasmUserId) {
    removeWasmParticipant(ws);
  }
  console.log(`📡 Client disconnected (${ws.clientIp})`);
}

// Utility functions
function generateSessionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function sendMessage(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, error) {
  console.error(`❌ Error for ${ws.username || 'anonymous'}: ${error}`);
  sendMessage(ws, { type: 'error', payload: { error } });
}

function sendWasmError(ws, error) {
  // Send both legacy payload and direct message for compatibility
  sendMessage(ws, { type: 'error', message: error, payload: { error } });
}

function broadcast(sessionCode, exclude, message) {
  const sessionSet = sessions.get(sessionCode);
  if (!sessionSet) return;
  
  sessionSet.forEach((client) => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      sendMessage(client, message);
    }
  });
}

function logMessage(direction, type, user, payload) {
  const timestamp = new Date().toISOString();
  const payloadStr = payload ? JSON.stringify(payload).substring(0, 100) : '';
  console.log(`[${timestamp}] ${direction} ${type.padEnd(20)} | ${user.padEnd(15)} | ${payloadStr}`);
}

function generateHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function recordLatency(durationMs) {
  if (durationMs < 50) metrics.latencyBuckets.lt50++;
  else if (durationMs < 100) metrics.latencyBuckets.lt100++;
  else if (durationMs < 250) metrics.latencyBuckets.lt250++;
  else if (durationMs < 500) metrics.latencyBuckets.lt500++;
  else if (durationMs < 1000) metrics.latencyBuckets.lt1000++;
  else metrics.latencyBuckets.gte1000++;
}

function currentWasmUserCount() {
  let count = 0;
  wasmRooms.forEach((room) => (count += room.users.size));
  return count;
}

function buildMetricsSnapshot() {
  return {
    ...metrics,
    wasmRooms: wasmRooms.size,
    wasmUsers: currentWasmUserCount()
  };
}

function checkProtocolVersion(ws, clientVersion) {
  if (!clientVersion) {
    sendWasmError(ws, 'protocol_version required');
    return false;
  }
  const major = clientVersion.split('.')[0];
  if (major !== PROTOCOL_MAJOR) {
    sendWasmError(ws, `protocol_version mismatch (server ${PROTOCOL_VERSION}, client ${clientVersion})`);
    return false;
  }
  return true;
}

function validateWasmToken(room, userId, token) {
  if (!WASM_TOKEN_SECRET) {
    return true;
  }
  if (!token) {
    return !WASM_REQUIRE_TOKEN;
  }
  const parts = token.split('|');
  if (parts.length !== 4) return false;
  const [tokenRoom, tokenUser, expStr, sig] = parts;
  if (tokenRoom !== room || tokenUser !== userId) return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const payload = `${tokenRoom}|${tokenUser}|${exp}`;
  const expected = crypto.createHmac('sha256', WASM_TOKEN_SECRET).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'));
  } catch {
    return false;
  }
}

function generateWasmToken(room, userId, expiresAtMs) {
  const payload = `${room}|${userId}|${expiresAtMs}`;
  const sig = crypto.createHmac('sha256', WASM_TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}|${sig}`;
}

function ensureWasmStateDir() {
  if (!WASM_STATE_PERSIST) return;
  if (!fs.existsSync(WASM_STATE_DIR)) {
    fs.mkdirSync(WASM_STATE_DIR, { recursive: true });
  }
}

function loadPersistedWasmState(roomCode) {
  if (!WASM_STATE_PERSIST) return null;
  ensureWasmStateDir();
  const filePath = path.join(WASM_STATE_DIR, `${roomCode}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function persistWasmState(roomCode) {
  if (!WASM_STATE_PERSIST) return;
  ensureWasmStateDir();
  const room = wasmRooms.get(roomCode);
  if (!room) return;
  const filePath = path.join(WASM_STATE_DIR, `${roomCode}.json`);
  const payload = {
    name: room.name,
    password_hash: room.password_hash || null,
    state_log: room.state_log || []
  };
  try {
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error(`Failed to persist WASM state for ${roomCode}:`, err);
  }
}

function recordWasmState(roomCode, event) {
  const room = wasmRooms.get(roomCode);
  if (!room) return;
  room.state_log = room.state_log || [];
  room.state_log.push({ ...event, recorded_at: Date.now() });
  if (room.state_log.length > WASM_MAX_STATE_EVENTS) {
    room.state_log = room.state_log.slice(-WASM_MAX_STATE_EVENTS);
  }
  persistWasmState(roomCode);
}

function touchWasmUser(ws) {
  if (!ws.wasmRoom || !ws.wasmUserId) return;
  const room = wasmRooms.get(ws.wasmRoom);
  if (!room) return;
  const user = room.users.get(ws.wasmUserId);
  if (!user) return;
  user.last_activity = Date.now();
}

function cleanupWasmRooms() {
  const now = Date.now();
  wasmRooms.forEach((room, code) => {
    let removed = false;
    room.users.forEach((user, userId) => {
      const last = user.last_activity || 0;
      if (now - last > WASM_IDLE_TIMEOUT_MS) {
        metrics.wasmHeartbeatPruned++;
        metrics.wasmLeaves++;
        if (user.ws && user.ws.readyState === WebSocket.OPEN) {
          sendMessage(user.ws, { type: 'error', message: 'Idle timeout', payload: { error: 'Idle timeout' } });
          user.ws.close();
        }
        room.users.delete(userId);
        removed = true;
      }
    });
    if (room.users.size === 0) {
      persistWasmState(code);
      wasmRooms.delete(code);
      return;
    }
    if (removed) {
      broadcastWasmUserList(code);
    }
  });
}

// ---------------------------------------------------------------------------
// WASM collaboration protocol support
// ---------------------------------------------------------------------------
function broadcastWasm(roomCode, message, exclude) {
  const room = wasmRooms.get(roomCode);
  if (!room) return;
  room.users.forEach((user) => {
    if (user.ws !== exclude && user.ws.readyState === WebSocket.OPEN) {
      sendMessage(user.ws, message);
    }
  });
}

function broadcastWasmUserList(roomCode) {
  const room = wasmRooms.get(roomCode);
  if (!room) return;
  const list = Array.from(room.users.values()).map((user) => ({
    id: user.id,
    name: user.name,
    color: user.color,
    active: true,
    last_activity: user.last_activity || null
  }));
  broadcastWasm(roomCode, { type: 'users', list });
}

async function handleWasmCreate(ws, msg) {
  const { room, name, user, user_id, color, password, protocol_version, token } = msg;
  if (!room || !user || !user_id) {
    return sendWasmError(ws, 'room, user, and user_id are required');
  }
  if (!checkProtocolVersion(ws, protocol_version)) return;
  if (!validateWasmToken(room, user_id, token)) {
    return sendWasmError(ws, 'Invalid join token');
  }
  if (wasmRooms.has(room)) {
    return sendWasmError(ws, `Room ${room} already exists`);
  }

  const persisted = loadPersistedWasmState(room);
  const sessionName = name || persisted?.name || 'YAZE Session';
  const userColor = color || '#4ECDC4';
  const now = Date.now();
  const passwordHash = password ? generateHash(password) : (persisted?.password_hash || null);
  const stateLog = (persisted?.state_log || []).slice(-WASM_MAX_STATE_EVENTS);

  wasmRooms.set(room, {
    name: sessionName,
    password_hash: passwordHash,
    state_log: stateLog,
    users: new Map([
      [
        user_id,
        { id: user_id, name: user, color: userColor, last_activity: now, ws }
      ]
    ])
  });

  ws.wasmRoom = room;
  ws.wasmUserId = user_id;
  ws.protocolVersion = protocol_version;
  metrics.wasmJoins++;
  persistWasmState(room);

  sendMessage(ws, { type: 'create_response', success: true, session_name: sessionName, protocol_version: PROTOCOL_VERSION, state_log: stateLog });
  broadcastWasmUserList(room);
}

async function handleWasmJoin(ws, msg) {
  const { room, user, user_id, color, password, protocol_version, token } = msg;
  if (!room || !user || !user_id) {
    return sendWasmError(ws, 'room, user, and user_id are required');
  }
  if (!checkProtocolVersion(ws, protocol_version)) return;

  let roomEntry = wasmRooms.get(room);
  if (!roomEntry) {
    const persisted = loadPersistedWasmState(room);
    if (persisted) {
      roomEntry = {
        name: persisted.name || 'YAZE Session',
        password_hash: persisted.password_hash || null,
        state_log: (persisted.state_log || []).slice(-WASM_MAX_STATE_EVENTS),
        users: new Map()
      };
      wasmRooms.set(room, roomEntry);
    } else {
      return sendWasmError(ws, `Room ${room} not found`);
    }
  }

  if (roomEntry.password_hash) {
    const providedHash = password ? generateHash(password) : null;
    if (!providedHash || providedHash !== roomEntry.password_hash) {
      return sendWasmError(ws, 'Invalid session password');
    }
  }

  if (!validateWasmToken(room, user_id, token)) {
    return sendWasmError(ws, 'Invalid join token');
  }

  const now = Date.now();
  const existing = roomEntry.users.get(user_id);
  const userColor = color || (existing ? existing.color : '#4ECDC4');

  roomEntry.users.set(user_id, {
    id: user_id,
    name: user,
    color: userColor,
    last_activity: now,
    ws
  });

  ws.wasmRoom = room;
  ws.wasmUserId = user_id;
  ws.protocolVersion = protocol_version;
  metrics.wasmJoins++;
  persistWasmState(room);

  sendMessage(ws, {
    type: 'join_response',
    success: true,
    session_name: roomEntry.name,
    protocol_version: PROTOCOL_VERSION,
    state_log: roomEntry.state_log || []
  });
  broadcastWasmUserList(room);
}

function handleWasmLeave(ws) {
  removeWasmParticipant(ws);
}

function handleWasmChange(ws, msg) {
  const { room, user_id, offset, old_data, new_data, timestamp } = msg;
  if (!room || !user_id) {
    return sendWasmError(ws, 'room and user_id are required for change');
  }
  if (!wasmRooms.has(room)) {
    return sendWasmError(ws, `Room ${room} not found`);
  }
  const ts = timestamp || Date.now();
  broadcastWasm(
    room,
    {
      type: 'change',
      room,
      user_id,
      offset,
      old_data,
      new_data,
      timestamp: ts
    },
    ws
  );
  touchWasmUser(ws);
  recordWasmState(room, { type: 'change', user_id, offset, old_data, new_data, timestamp: ts });
}

function handleWasmCursor(ws, msg) {
  const { room, user_id, editor, x, y, map_id } = msg;
  if (!room || !user_id) {
    return sendWasmError(ws, 'room and user_id are required for cursor');
  }
  if (!wasmRooms.has(room)) {
    return sendWasmError(ws, `Room ${room} not found`);
  }
  broadcastWasm(
    room,
    {
      type: 'cursor',
      room,
      user_id,
      editor,
      x,
      y,
      map_id
    },
    ws
  );
  touchWasmUser(ws);
}

function removeWasmParticipant(ws) {
  if (!ws.wasmRoom || !ws.wasmUserId) return;
  const roomEntry = wasmRooms.get(ws.wasmRoom);
  if (roomEntry) {
    roomEntry.users.delete(ws.wasmUserId);
    metrics.wasmLeaves++;
    if (roomEntry.users.size === 0) {
      persistWasmState(ws.wasmRoom);
      wasmRooms.delete(ws.wasmRoom);
    } else {
      broadcastWasmUserList(ws.wasmRoom);
      persistWasmState(ws.wasmRoom);
    }
  }
  ws.wasmRoom = null;
  ws.wasmUserId = null;
}

// Synchronous database methods for sql.js
function runAsync(db, sql, params) {
  return db.run(sql, params);
}

function getAsync(db, sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function allAsync(db, sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...');

  // Notify all connected clients
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      sendMessage(ws, {
        type: 'server_shutdown',
        payload: {
          message: 'Server is shutting down. Please reconnect later.'
        }
      });
      ws.close();
    }
  });

  // Close server
  wss.close(() => {
    server.close(() => {
      try {
        // Save database before closing
        saveDatabase();
        if (db) {
          db.close();
        }
        console.log('✓ Server shut down gracefully');
      } catch (err) {
        console.error('Error closing database:', err);
      }
      process.exit(0);
    });
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
});
