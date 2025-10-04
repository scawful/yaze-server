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
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const http = require('http');
const crypto = require('crypto');

// Configuration
const PORT = process.env.PORT || 8765;
const MAX_SNAPSHOT_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROM_DIFF_SIZE = 5 * 1024 * 1024; // 5MB
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX_MESSAGES = 100;
const ENABLE_AI_AGENT = process.env.ENABLE_AI_AGENT !== 'false';
const AI_AGENT_ENDPOINT = process.env.AI_AGENT_ENDPOINT || '';

// Rate limiting tracker
const rateLimitMap = new Map(); // ip -> { count, resetTime }

// Database setup
const db = new sqlite3.Database(':memory:', (err) => {
  if (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
  console.log('✓ Connected to in-memory SQLite database');
});

// Initialize database schema
db.serialize(() => {
  db.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      rom_hash TEXT,
      ai_enabled INTEGER DEFAULT 1
    )
  `);
  
  db.run(`
    CREATE TABLE participants (
      session_id TEXT NOT NULL,
      username TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
  
  db.run(`
    CREATE TABLE messages (
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
    CREATE TABLE rom_syncs (
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
    CREATE TABLE snapshots (
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
    CREATE TABLE proposals (
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
    CREATE TABLE agent_interactions (
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
});

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
  startTime: Date.now()
};

// Create HTTP server for health checks
const server = http.createServer((req, res) => {
  const url = req.url;
  
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      uptime: Date.now() - metrics.startTime,
      sessions: sessions.size,
      metrics
    }));
  } else if (url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metrics));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// WebSocket server
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`🚀 YAZE Collaboration Server v2.0 listening on port ${PORT}`);
  console.log(`   HTTP Health Check: http://localhost:${PORT}/health`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   AI Agent: ${ENABLE_AI_AGENT ? 'Enabled' : 'Disabled'}`);
});

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`📡 New client connected from ${clientIp}`);
  
  ws.sessionId = null;
  ws.username = null;
  ws.isAlive = true;
  ws.clientIp = clientIp;
  ws.messageCount = 0;
  ws.lastMessageTime = Date.now();
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.on('message', async (data) => {
    try {
      // Rate limiting check
      if (!checkRateLimit(ws)) {
        sendError(ws, 'Rate limit exceeded. Please slow down.');
        return;
      }
      
      const message = JSON.parse(data.toString());
      await handleMessage(ws, message);
      
      ws.messageCount++;
      ws.lastMessageTime = Date.now();
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

wss.on('close', () => {
  clearInterval(heartbeat);
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
    case 'ai_query':
      await handleAIQuery(ws, payload);
      break;
    case 'ping':
      sendMessage(ws, { type: 'pong', payload: { timestamp: Date.now() } });
      break;
    default:
      sendError(ws, `Unknown message type: ${type}`);
  }
}

async function handleHostSession(ws, payload) {
  const { session_name, username, rom_hash = null, ai_enabled = true } = payload;
  
  if (!session_name || !username) {
    return sendError(ws, 'session_name and username required');
  }
  
  const sessionId = uuidv4();
  const sessionCode = generateSessionCode();
  const now = Date.now();
  
  try {
    await runAsync(db, 
      'INSERT INTO sessions (id, code, name, host, created_at, rom_hash, ai_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sessionId, sessionCode, session_name, username, now, rom_hash, ai_enabled ? 1 : 0]
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
        ai_enabled
      }
    });
    
    console.log(`✓ Session hosted: ${sessionCode} by ${username} (AI: ${ai_enabled ? 'enabled' : 'disabled'})`);
  } catch (error) {
    console.error('Error hosting session:', error);
    sendError(ws, 'Failed to host session');
  }
}

async function handleJoinSession(ws, payload) {
  const { session_code, username } = payload;
  
  if (!session_code || !username) {
    return sendError(ws, 'session_code and username required');
  }
  
  try {
    const session = await getAsync(db,
      'SELECT * FROM sessions WHERE code = ?',
      [session_code.toUpperCase()]
    );
    
    if (!session) {
      return sendError(ws, `Session ${session_code} not found`);
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
    
    // Store interaction
    await runAsync(db,
      'INSERT INTO agent_interactions (id, session_id, username, query, timestamp) VALUES (?, ?, ?, ?, ?)',
      [queryId, ws.sessionId, username, query, timestamp]
    );
    
    metrics.totalAIQueries++;
    
    // In a real implementation, this would call an AI service
    // For now, send a placeholder response
    const aiResponse = {
      query_id: queryId,
      response: 'AI agent endpoint not configured. Set AI_AGENT_ENDPOINT environment variable.',
      timestamp: Date.now()
    };
    
    // Update interaction with response
    await runAsync(db,
      'UPDATE agent_interactions SET response = ? WHERE id = ?',
      [aiResponse.response, queryId]
    );
    
    // Broadcast AI response to all participants
    broadcast(session.code, null, {
      type: 'ai_response',
      payload: {
        query_id: queryId,
        username,
        query,
        response: aiResponse.response,
        timestamp: aiResponse.timestamp
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

// Promisify database methods
function runAsync(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getAsync(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allAsync(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
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
      db.close((err) => {
        if (err) {
          console.error('Error closing database:', err);
        }
        console.log('✓ Server shut down gracefully');
        process.exit(0);
      });
    });
  });
  
  // Force exit after 5 seconds
  setTimeout(() => {
    console.error('⚠️  Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
});
