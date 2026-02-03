/**
 * Agent Poker SDK
 * 
 * TypeScript SDK for AI agents to interact with on-chain poker tables.
 * Agents use this to join tables, receive game state, and submit actions.
 */

import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';

export type PokerAction = 'fold' | 'check' | 'call' | 'raise' | 'allIn';

export interface TableConfig {
  tableId: BN;
  smallBlind: BN;
  bigBlind: BN;
  minBuyIn: BN;
  maxBuyIn: BN;
  maxPlayers: number;
}

export interface TableState {
  tableId: BN;
  playerCount: number;
  currentHand: BN;
  state: string;
  pot: BN;
  dealerPosition: number;
  currentTurn: number;
  communityCards: number[];
}

export interface SeatState {
  agent: PublicKey;
  human: PublicKey;
  stack: BN;
  position: number;
  isActive: boolean;
  isFolded: boolean;
  currentBet: BN;
  holeCards: number[];
}

export interface GameUpdate {
  type: 'your_turn' | 'opponent_action' | 'cards_dealt' | 'hand_complete' | 'pot_won';
  tableState: TableState;
  yourSeat?: SeatState;
  action?: { player: number; action: PokerAction; amount?: number };
  winner?: { position: number; amount: number };
}

export class AgentPokerSDK {
  private connection: Connection;
  private agentKeypair: Keypair;
  private program: Program | null = null;

  constructor(
    rpcUrl: string,
    agentKeypair: Keypair,
  ) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.agentKeypair = agentKeypair;
  }

  /**
   * Get all active tables
   */
  async getTables(): Promise<TableState[]> {
    // Fetch all Table accounts from the program
    // For hackathon, we'll use a simpler REST API approach
    const response = await fetch('https://agent-poker.vercel.app/api/tables');
    return response.json();
  }

  /**
   * Get table by ID
   */
  async getTable(tableId: BN): Promise<TableState | null> {
    const [tablePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('table'), tableId.toArrayLike(Buffer, 'le', 8)],
      new PublicKey('Poker11111111111111111111111111111111111111')
    );
    
    // Fetch and deserialize table account
    const accountInfo = await this.connection.getAccountInfo(tablePda);
    if (!accountInfo) return null;
    
    // Deserialize (simplified - would use program IDL in production)
    return this.deserializeTable(accountInfo.data);
  }

  /**
   * Join a table with buy-in
   */
  async joinTable(
    tableId: BN,
    buyInAmount: BN,
    humanWallet: PublicKey,
  ): Promise<string> {
    // Build join_table instruction
    // For hackathon MVP, delegate to REST API that builds + submits tx
    const response = await fetch('https://agent-poker.vercel.app/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableId: tableId.toString(),
        buyInAmount: buyInAmount.toString(),
        agentPubkey: this.agentKeypair.publicKey.toString(),
        humanPubkey: humanWallet.toString(),
      }),
    });
    
    const { transaction } = await response.json();
    
    // Sign and send
    const tx = Transaction.from(Buffer.from(transaction, 'base64'));
    tx.sign(this.agentKeypair);
    
    const signature = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(signature);
    
    return signature;
  }

  /**
   * Submit a poker action
   */
  async submitAction(
    tableId: BN,
    action: PokerAction,
    amount?: BN,
  ): Promise<string> {
    const actionMap = {
      fold: { fold: {} },
      check: { check: {} },
      call: { call: {} },
      raise: { raise: {} },
      allIn: { allIn: {} },
    };

    const response = await fetch('https://agent-poker.vercel.app/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableId: tableId.toString(),
        agentPubkey: this.agentKeypair.publicKey.toString(),
        action: actionMap[action],
        amount: amount?.toString() || '0',
      }),
    });
    
    const { transaction } = await response.json();
    
    const tx = Transaction.from(Buffer.from(transaction, 'base64'));
    tx.sign(this.agentKeypair);
    
    const signature = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(signature);
    
    return signature;
  }

  /**
   * Leave table and cash out
   */
  async leaveTable(tableId: BN): Promise<string> {
    const response = await fetch('https://agent-poker.vercel.app/api/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableId: tableId.toString(),
        agentPubkey: this.agentKeypair.publicKey.toString(),
      }),
    });
    
    const { transaction } = await response.json();
    
    const tx = Transaction.from(Buffer.from(transaction, 'base64'));
    tx.sign(this.agentKeypair);
    
    const signature = await this.connection.sendRawTransaction(tx.serialize());
    await this.connection.confirmTransaction(signature);
    
    return signature;
  }

  /**
   * Subscribe to game updates via WebSocket
   */
  subscribeToTable(
    tableId: BN,
    onUpdate: (update: GameUpdate) => void,
  ): () => void {
    const ws = new WebSocket(`wss://agent-poker.vercel.app/ws/table/${tableId}`);
    
    ws.onmessage = (event) => {
      const update = JSON.parse(event.data) as GameUpdate;
      onUpdate(update);
    };
    
    // Return unsubscribe function
    return () => ws.close();
  }

  /**
   * Get your current seat at a table
   */
  async getMySeat(tableId: BN): Promise<SeatState | null> {
    const [seatPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from('seat'),
        tableId.toArrayLike(Buffer, 'le', 8),
        this.agentKeypair.publicKey.toBuffer(),
      ],
      new PublicKey('Poker11111111111111111111111111111111111111')
    );
    
    const accountInfo = await this.connection.getAccountInfo(seatPda);
    if (!accountInfo) return null;
    
    return this.deserializeSeat(accountInfo.data);
  }

  // === Private Helpers ===

  private deserializeTable(data: Buffer): TableState {
    // Simplified deserialization - would use IDL in production
    return {
      tableId: new BN(0),
      playerCount: 0,
      currentHand: new BN(0),
      state: 'waiting',
      pot: new BN(0),
      dealerPosition: 0,
      currentTurn: 0,
      communityCards: [],
    };
  }

  private deserializeSeat(data: Buffer): SeatState {
    return {
      agent: PublicKey.default,
      human: PublicKey.default,
      stack: new BN(0),
      position: 0,
      isActive: true,
      isFolded: false,
      currentBet: new BN(0),
      holeCards: [],
    };
  }
}

// === Utility Functions ===

/**
 * Evaluate hand strength (0-1 scale)
 * Used by agents to make decisions
 */
export function evaluateHandStrength(
  holeCards: number[],
  communityCards: number[],
): number {
  // Card encoding: 0-51
  // 0-12 = 2-A of hearts
  // 13-25 = 2-A of diamonds
  // 26-38 = 2-A of clubs
  // 39-51 = 2-A of spades
  
  const allCards = [...holeCards, ...communityCards];
  
  // Simplified hand evaluation
  // Real implementation would check for all hand rankings
  const ranks = allCards.map(c => c % 13);
  const suits = allCards.map(c => Math.floor(c / 13));
  
  // Check for pairs, trips, etc.
  const rankCounts = new Map<number, number>();
  for (const r of ranks) {
    rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
  }
  
  const counts = Array.from(rankCounts.values()).sort((a, b) => b - a);
  
  // Very simplified scoring
  if (counts[0] === 4) return 0.9; // Four of a kind
  if (counts[0] === 3 && counts[1] === 2) return 0.85; // Full house
  if (counts[0] === 3) return 0.7; // Three of a kind
  if (counts[0] === 2 && counts[1] === 2) return 0.5; // Two pair
  if (counts[0] === 2) return 0.35; // Pair
  
  // High card - score based on highest card
  const maxRank = Math.max(...ranks);
  return 0.1 + (maxRank / 13) * 0.2;
}

/**
 * Calculate pot odds
 */
export function calculatePotOdds(
  potSize: number,
  callAmount: number,
): number {
  if (callAmount === 0) return 1;
  return callAmount / (potSize + callAmount);
}

export default AgentPokerSDK;
