#!/usr/bin/env ts-node
/**
 * Agent Battle Runner
 * 
 * Spawns multiple AI agents to battle at a poker table.
 * Used for testing and demonstration.
 */

import WebSocket from 'ws';
import { Keypair, PublicKey } from '@solana/web3.js';
import { evaluateHandStrength, calculatePotOdds } from '../sdk/src';

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:3000';

interface AgentConfig {
  name: string;
  style: 'aggressive' | 'passive' | 'random' | 'tight';
  buyIn: number;
}

class BattleAgent {
  private ws: WebSocket | null = null;
  private config: AgentConfig;
  private keypair: Keypair;
  private tableId: string = '';
  private currentState: any = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.keypair = Keypair.generate();
  }

  async connect(serverUrl: string, tableId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(serverUrl);
      this.tableId = tableId;

      this.ws.on('open', () => {
        console.log(`[${this.config.name}] Connected to server`);
        this.join();
        resolve();
      });

      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      });

      this.ws.on('error', (err) => {
        console.error(`[${this.config.name}] WebSocket error:`, err);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log(`[${this.config.name}] Disconnected`);
      });
    });
  }

  private join(): void {
    this.send({
      type: 'join',
      tableId: this.tableId,
      agentId: this.config.name,
      agentPubkey: this.keypair.publicKey.toString(),
      humanPubkey: this.keypair.publicKey.toString(), // Same for testing
      buyIn: this.config.buyIn,
    });
  }

  private send(msg: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'state':
        this.currentState = msg;
        this.checkMyTurn();
        break;

      case 'hand_started':
        console.log(`[${this.config.name}] New hand #${msg.data.handNumber}`);
        break;

      case 'cards_dealt':
        if (msg.data.agentId === this.config.name) {
          console.log(`[${this.config.name}] Hole cards: ${msg.data.holeCards.join(' ')}`);
        }
        break;

      case 'action':
        console.log(`[${this.config.name}] ${msg.data.agentId}: ${msg.data.action}${msg.data.amount ? ' ' + msg.data.amount : ''}`);
        this.checkMyTurn();
        break;

      case 'street_complete':
        console.log(`[${this.config.name}] ${msg.data.street.toUpperCase()}: ${msg.data.communityCards.join(' ')}`);
        this.checkMyTurn();
        break;

      case 'pot_awarded':
        const myWin = msg.data.winners.find((w: any) => w.agentId === this.config.name);
        if (myWin) {
          console.log(`[${this.config.name}] 🎉 WON ${myWin.amount}!`);
        }
        break;

      case 'error':
        console.error(`[${this.config.name}] Error: ${msg.error}`);
        break;
    }
  }

  private checkMyTurn(): void {
    if (!this.currentState) return;
    if (this.currentState.currentTurn !== this.config.name) return;

    // Small delay to make it feel more natural
    setTimeout(() => this.makeDecision(), 500 + Math.random() * 1000);
  }

  private makeDecision(): void {
    if (!this.currentState) return;

    const me = this.currentState.players.find((p: any) => p.agentId === this.config.name);
    if (!me || me.hasFolded || me.isAllIn) return;

    const toCall = this.currentState.currentBet - me.currentBet;
    const pot = this.currentState.pot;

    let action: string;
    let amount: number | undefined;

    switch (this.config.style) {
      case 'aggressive':
        // Raise often, rarely fold
        if (Math.random() < 0.4) {
          action = 'raise';
          amount = this.currentState.currentBet + Math.floor(pot * 0.75);
        } else if (toCall === 0) {
          action = Math.random() < 0.6 ? 'raise' : 'check';
          if (action === 'raise') amount = Math.floor(pot * 0.5);
        } else {
          action = 'call';
        }
        break;

      case 'passive':
        // Call and check, rarely raise
        if (toCall === 0) {
          action = 'check';
        } else if (toCall < me.stack * 0.1) {
          action = 'call';
        } else {
          action = Math.random() < 0.3 ? 'call' : 'fold';
        }
        break;

      case 'tight':
        // Fold often unless strong position
        if (toCall === 0) {
          action = Math.random() < 0.2 ? 'raise' : 'check';
          if (action === 'raise') amount = Math.floor(pot * 0.5);
        } else if (toCall < me.stack * 0.05) {
          action = 'call';
        } else {
          action = Math.random() < 0.8 ? 'fold' : 'call';
        }
        break;

      case 'random':
      default:
        // Pure chaos
        const actions = toCall === 0 
          ? ['check', 'raise'] 
          : ['fold', 'call', 'raise'];
        action = actions[Math.floor(Math.random() * actions.length)];
        if (action === 'raise') {
          amount = this.currentState.currentBet + Math.floor(Math.random() * pot);
        }
        break;
    }

    console.log(`[${this.config.name}] Decision: ${action}${amount ? ' ' + amount : ''}`);
    this.send({ type: 'action', action, amount });
  }

  disconnect(): void {
    this.send({ type: 'leave' });
    this.ws?.close();
  }
}

// === Main ===

async function runBattle() {
  console.log('🃏 AGENT POKER BATTLE 🃏\n');

  // Define agents
  const agents: AgentConfig[] = [
    { name: 'AggressiveAndy', style: 'aggressive', buyIn: 100 },
    { name: 'PassivePete', style: 'passive', buyIn: 100 },
    { name: 'TightTom', style: 'tight', buyIn: 100 },
    { name: 'RandomRandy', style: 'random', buyIn: 100 },
  ];

  // Get or create table
  const tableResponse = await fetch('http://localhost:3000/api/tables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      smallBlind: 1,
      bigBlind: 2,
      minBuyIn: 40,
      maxBuyIn: 200,
      maxPlayers: 6,
    }),
  });
  const { tableId } = await tableResponse.json();
  console.log(`Table created: ${tableId}\n`);

  // Connect agents
  const battleAgents: BattleAgent[] = [];
  
  for (const config of agents) {
    const agent = new BattleAgent(config);
    await agent.connect(SERVER_URL, tableId);
    battleAgents.push(agent);
    await new Promise(r => setTimeout(r, 500)); // Stagger joins
  }

  console.log('\n--- Battle started! Press Ctrl+C to stop ---\n');

  // Run until interrupted
  process.on('SIGINT', () => {
    console.log('\n\nStopping battle...');
    for (const agent of battleAgents) {
      agent.disconnect();
    }
    process.exit(0);
  });
}

// Run if executed directly
if (require.main === module) {
  runBattle().catch(console.error);
}

export { BattleAgent };
