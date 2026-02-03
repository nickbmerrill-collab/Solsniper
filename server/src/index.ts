/**
 * Agent Poker Server
 * 
 * HTTP + WebSocket server for the poker game coordinator.
 * Agents connect via WebSocket to play, spectators can watch.
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { PublicKey } from '@solana/web3.js';
import { GameCoordinator, getCoordinator } from './coordinator';

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

const coordinator = getCoordinator(process.env.RPC_URL);

// Track WebSocket connections
const connections = new Map<string, { ws: WebSocket; agentId?: string; tableId?: string }>();

// === REST API ===

// List tables
app.get('/api/tables', (req, res) => {
  const tables = coordinator.listTables().map(t => ({
    id: t.id,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    players: t.players.size,
    maxPlayers: t.maxPlayers,
    street: t.street,
  }));
  res.json({ tables });
});

// Create table
app.post('/api/tables', (req, res) => {
  const { smallBlind, bigBlind, minBuyIn, maxBuyIn, maxPlayers } = req.body;
  
  const tableId = coordinator.createTable({
    smallBlind: smallBlind || 1,
    bigBlind: bigBlind || 2,
    minBuyIn: minBuyIn || 40,
    maxBuyIn: maxBuyIn || 200,
    maxPlayers: maxPlayers || 6,
  });
  
  res.json({ tableId });
});

// Get table state
app.get('/api/tables/:tableId', (req, res) => {
  const state = coordinator.getGameState(req.params.tableId);
  if (!state) {
    return res.status(404).json({ error: 'Table not found' });
  }
  res.json(state);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    tables: coordinator.listTables().length,
    connections: connections.size,
  });
});

// === WebSocket Handler ===

wss.on('connection', (ws) => {
  const connId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  connections.set(connId, { ws });
  
  console.log(`[WS] New connection: ${connId}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWebSocketMessage(connId, msg);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    const conn = connections.get(connId);
    if (conn?.agentId && conn?.tableId) {
      coordinator.leaveTable(conn.tableId, conn.agentId);
    }
    connections.delete(connId);
    console.log(`[WS] Connection closed: ${connId}`);
  });

  ws.send(JSON.stringify({ type: 'connected', connId }));
});

function handleWebSocketMessage(connId: string, msg: any) {
  const conn = connections.get(connId);
  if (!conn) return;

  const { ws } = conn;

  switch (msg.type) {
    case 'join': {
      const { tableId, agentId, agentPubkey, humanPubkey, buyIn } = msg;
      
      try {
        const success = coordinator.joinTable(
          tableId,
          agentId,
          new PublicKey(agentPubkey),
          new PublicKey(humanPubkey),
          buyIn
        );

        if (success) {
          conn.agentId = agentId;
          conn.tableId = tableId;
          
          // Subscribe to table events
          coordinator.subscribe(tableId, (event) => {
            ws.send(JSON.stringify(event));
          });

          ws.send(JSON.stringify({ type: 'joined', tableId, agentId }));
          
          // Send current game state
          const state = coordinator.getGameState(tableId, agentId);
          ws.send(JSON.stringify({ type: 'state', ...state }));
        } else {
          ws.send(JSON.stringify({ type: 'error', error: 'Failed to join table' }));
        }
      } catch (e: any) {
        ws.send(JSON.stringify({ type: 'error', error: e.message }));
      }
      break;
    }

    case 'action': {
      const { action, amount } = msg;
      
      if (!conn.tableId || !conn.agentId) {
        ws.send(JSON.stringify({ type: 'error', error: 'Not at a table' }));
        return;
      }

      const result = coordinator.handleAction(conn.tableId, conn.agentId, action, amount);
      
      if (!result.success) {
        ws.send(JSON.stringify({ type: 'error', error: result.error }));
      }
      break;
    }

    case 'leave': {
      if (conn.tableId && conn.agentId) {
        const stack = coordinator.leaveTable(conn.tableId, conn.agentId);
        ws.send(JSON.stringify({ type: 'left', stack }));
        conn.tableId = undefined;
        conn.agentId = undefined;
      }
      break;
    }

    case 'state': {
      if (conn.tableId) {
        const state = coordinator.getGameState(conn.tableId, conn.agentId);
        ws.send(JSON.stringify({ type: 'state', ...state }));
      }
      break;
    }

    case 'spectate': {
      const { tableId } = msg;
      conn.tableId = tableId;
      
      coordinator.subscribe(tableId, (event) => {
        // Don't send private card info to spectators
        if (event.type === 'cards_dealt' && event.data.private) return;
        ws.send(JSON.stringify(event));
      });

      const state = coordinator.getGameState(tableId);
      ws.send(JSON.stringify({ type: 'state', ...state }));
      break;
    }

    default:
      ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }));
  }
}

// === Start Server ===

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║       AGENT POKER SERVER 🃏🤖          ║
╠═══════════════════════════════════════╣
║  HTTP:  http://localhost:${PORT}          ║
║  WS:    ws://localhost:${PORT}            ║
╚═══════════════════════════════════════╝
  `);

  // Create a default table
  const tableId = coordinator.createTable({
    smallBlind: 1,
    bigBlind: 2,
    minBuyIn: 40,
    maxBuyIn: 200,
    maxPlayers: 6,
  });
  console.log(`Default table created: ${tableId}`);
});

export default server;
