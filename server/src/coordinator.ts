/**
 * Agent Poker Game Coordinator
 * 
 * Manages poker tables, matches agents, deals cards,
 * and broadcasts game state to spectators.
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import { createDeck, evaluateHand, determineWinners, Card, cardToString } from '../../sdk/src/poker-engine';

// === Types ===

interface Player {
  agentId: string;
  agentPubkey: PublicKey;
  humanPubkey: PublicKey;
  stack: number;
  holeCards: Card[];
  currentBet: number;
  hasFolded: boolean;
  hasActed: boolean;
  isAllIn: boolean;
  seatIndex: number;
}

interface Table {
  id: string;
  smallBlind: number;
  bigBlind: number;
  minBuyIn: number;
  maxBuyIn: number;
  maxPlayers: number;
  players: Map<string, Player>;
  deck: Card[];
  communityCards: Card[];
  pot: number;
  currentBet: number;
  dealerIndex: number;
  actionIndex: number;
  street: 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
  handNumber: number;
  lastAction: { agentId: string; action: string; amount?: number } | null;
  spectators: Set<string>;
  createdAt: Date;
}

interface GameEvent {
  type: 'player_joined' | 'player_left' | 'hand_started' | 'cards_dealt' | 
        'action' | 'street_complete' | 'showdown' | 'pot_awarded' | 'error';
  tableId: string;
  data: any;
  timestamp: Date;
}

type ActionType = 'fold' | 'check' | 'call' | 'raise' | 'allIn';

// === Coordinator Class ===

export class GameCoordinator {
  private tables: Map<string, Table> = new Map();
  private eventListeners: Map<string, ((event: GameEvent) => void)[]> = new Map();
  private connection: Connection;
  private actionTimeout: number = 30000; // 30 seconds to act

  constructor(rpcUrl: string = 'https://api.devnet.solana.com') {
    this.connection = new Connection(rpcUrl, 'confirmed');
  }

  // === Table Management ===

  createTable(config: {
    smallBlind: number;
    bigBlind: number;
    minBuyIn: number;
    maxBuyIn: number;
    maxPlayers: number;
  }): string {
    const id = `table_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const table: Table = {
      id,
      ...config,
      players: new Map(),
      deck: [],
      communityCards: [],
      pot: 0,
      currentBet: 0,
      dealerIndex: 0,
      actionIndex: 0,
      street: 'waiting',
      handNumber: 0,
      lastAction: null,
      spectators: new Set(),
      createdAt: new Date(),
    };

    this.tables.set(id, table);
    console.log(`[Coordinator] Table ${id} created: ${config.smallBlind}/${config.bigBlind} blinds`);
    
    return id;
  }

  getTable(tableId: string): Table | undefined {
    return this.tables.get(tableId);
  }

  listTables(): Table[] {
    return Array.from(this.tables.values());
  }

  // === Player Management ===

  joinTable(
    tableId: string,
    agentId: string,
    agentPubkey: PublicKey,
    humanPubkey: PublicKey,
    buyIn: number
  ): boolean {
    const table = this.tables.get(tableId);
    if (!table) {
      console.log(`[Coordinator] Table ${tableId} not found`);
      return false;
    }

    if (table.players.size >= table.maxPlayers) {
      console.log(`[Coordinator] Table ${tableId} is full`);
      return false;
    }

    if (buyIn < table.minBuyIn || buyIn > table.maxBuyIn) {
      console.log(`[Coordinator] Invalid buy-in: ${buyIn} (min: ${table.minBuyIn}, max: ${table.maxBuyIn})`);
      return false;
    }

    if (table.players.has(agentId)) {
      console.log(`[Coordinator] Agent ${agentId} already at table`);
      return false;
    }

    // Find empty seat
    const takenSeats = new Set(Array.from(table.players.values()).map(p => p.seatIndex));
    let seatIndex = 0;
    while (takenSeats.has(seatIndex)) seatIndex++;

    const player: Player = {
      agentId,
      agentPubkey,
      humanPubkey,
      stack: buyIn,
      holeCards: [],
      currentBet: 0,
      hasFolded: false,
      hasActed: false,
      isAllIn: false,
      seatIndex,
    };

    table.players.set(agentId, player);
    
    this.emit({
      type: 'player_joined',
      tableId,
      data: { agentId, seatIndex, stack: buyIn },
      timestamp: new Date(),
    });

    console.log(`[Coordinator] Agent ${agentId} joined table ${tableId} at seat ${seatIndex}`);

    // Auto-start if enough players
    if (table.players.size >= 2 && table.street === 'waiting') {
      this.startHand(tableId);
    }

    return true;
  }

  leaveTable(tableId: string, agentId: string): number {
    const table = this.tables.get(tableId);
    if (!table) return 0;

    const player = table.players.get(agentId);
    if (!player) return 0;

    const stack = player.stack;
    table.players.delete(agentId);

    this.emit({
      type: 'player_left',
      tableId,
      data: { agentId, stack },
      timestamp: new Date(),
    });

    console.log(`[Coordinator] Agent ${agentId} left table ${tableId} with ${stack}`);
    return stack;
  }

  // === Hand Management ===

  startHand(tableId: string): boolean {
    const table = this.tables.get(tableId);
    if (!table || table.players.size < 2) return false;

    table.handNumber++;
    table.street = 'preflop';
    table.deck = createDeck();
    table.communityCards = [];
    table.pot = 0;
    table.currentBet = 0;

    // Reset players
    for (const player of table.players.values()) {
      player.holeCards = [];
      player.currentBet = 0;
      player.hasFolded = false;
      player.hasActed = false;
      player.isAllIn = false;
    }

    // Move dealer button
    const playerList = this.getActivePlayers(table);
    table.dealerIndex = (table.dealerIndex + 1) % playerList.length;

    // Post blinds
    const sbIndex = (table.dealerIndex + 1) % playerList.length;
    const bbIndex = (table.dealerIndex + 2) % playerList.length;
    
    this.postBlind(table, playerList[sbIndex], table.smallBlind);
    this.postBlind(table, playerList[bbIndex], table.bigBlind);
    table.currentBet = table.bigBlind;

    // Deal hole cards
    for (const player of playerList) {
      player.holeCards = [table.deck.pop()!, table.deck.pop()!];
    }

    // Set action to player after BB
    table.actionIndex = (bbIndex + 1) % playerList.length;

    this.emit({
      type: 'hand_started',
      tableId,
      data: {
        handNumber: table.handNumber,
        dealerSeat: playerList[table.dealerIndex].seatIndex,
        smallBlind: { agentId: playerList[sbIndex].agentId, amount: table.smallBlind },
        bigBlind: { agentId: playerList[bbIndex].agentId, amount: table.bigBlind },
      },
      timestamp: new Date(),
    });

    // Notify each player of their cards
    for (const player of playerList) {
      this.emit({
        type: 'cards_dealt',
        tableId,
        data: {
          agentId: player.agentId,
          holeCards: player.holeCards.map(cardToString),
          private: true,
        },
        timestamp: new Date(),
      });
    }

    console.log(`[Coordinator] Hand #${table.handNumber} started at table ${tableId}`);
    return true;
  }

  private postBlind(table: Table, player: Player, amount: number): void {
    const blindAmount = Math.min(amount, player.stack);
    player.stack -= blindAmount;
    player.currentBet = blindAmount;
    table.pot += blindAmount;
    
    if (player.stack === 0) {
      player.isAllIn = true;
    }
  }

  // === Actions ===

  handleAction(
    tableId: string,
    agentId: string,
    action: ActionType,
    amount?: number
  ): { success: boolean; error?: string } {
    const table = this.tables.get(tableId);
    if (!table) return { success: false, error: 'Table not found' };

    const player = table.players.get(agentId);
    if (!player) return { success: false, error: 'Player not at table' };

    const activePlayers = this.getActivePlayers(table);
    const currentPlayer = activePlayers[table.actionIndex];
    
    if (currentPlayer.agentId !== agentId) {
      return { success: false, error: 'Not your turn' };
    }

    if (player.hasFolded || player.isAllIn) {
      return { success: false, error: 'Cannot act' };
    }

    const toCall = table.currentBet - player.currentBet;

    switch (action) {
      case 'fold':
        player.hasFolded = true;
        break;

      case 'check':
        if (toCall > 0) {
          return { success: false, error: 'Cannot check, must call or raise' };
        }
        break;

      case 'call':
        const callAmount = Math.min(toCall, player.stack);
        player.stack -= callAmount;
        player.currentBet += callAmount;
        table.pot += callAmount;
        if (player.stack === 0) player.isAllIn = true;
        break;

      case 'raise':
        if (!amount || amount <= table.currentBet) {
          return { success: false, error: 'Raise must be greater than current bet' };
        }
        const raiseTotal = amount - player.currentBet;
        if (raiseTotal > player.stack) {
          return { success: false, error: 'Insufficient stack' };
        }
        player.stack -= raiseTotal;
        player.currentBet = amount;
        table.pot += raiseTotal;
        table.currentBet = amount;
        // Reset hasActed for other players
        for (const p of activePlayers) {
          if (p.agentId !== agentId && !p.hasFolded && !p.isAllIn) {
            p.hasActed = false;
          }
        }
        break;

      case 'allIn':
        const allInAmount = player.stack;
        table.pot += allInAmount;
        player.currentBet += allInAmount;
        player.stack = 0;
        player.isAllIn = true;
        if (player.currentBet > table.currentBet) {
          table.currentBet = player.currentBet;
          for (const p of activePlayers) {
            if (p.agentId !== agentId && !p.hasFolded && !p.isAllIn) {
              p.hasActed = false;
            }
          }
        }
        break;
    }

    player.hasActed = true;
    table.lastAction = { agentId, action, amount };

    this.emit({
      type: 'action',
      tableId,
      data: { agentId, action, amount, pot: table.pot },
      timestamp: new Date(),
    });

    console.log(`[Coordinator] ${agentId}: ${action}${amount ? ` ${amount}` : ''}`);

    // Check if betting round is complete
    this.checkBettingRoundComplete(table);

    return { success: true };
  }

  private checkBettingRoundComplete(table: Table): void {
    const activePlayers = this.getActivePlayers(table);
    const playersInHand = activePlayers.filter(p => !p.hasFolded);

    // Check for winner by fold
    if (playersInHand.length === 1) {
      this.awardPot(table, [playersInHand[0]]);
      return;
    }

    // Check if all players have acted and matched the bet
    const allActed = playersInHand.every(p => 
      p.hasActed && (p.currentBet === table.currentBet || p.isAllIn)
    );

    if (allActed) {
      this.advanceStreet(table);
    } else {
      // Move to next player
      do {
        table.actionIndex = (table.actionIndex + 1) % activePlayers.length;
      } while (
        activePlayers[table.actionIndex].hasFolded || 
        activePlayers[table.actionIndex].isAllIn
      );
    }
  }

  private advanceStreet(table: Table): void {
    // Reset for new betting round
    for (const player of table.players.values()) {
      player.currentBet = 0;
      player.hasActed = false;
    }
    table.currentBet = 0;

    const activePlayers = this.getActivePlayers(table);
    table.actionIndex = (table.dealerIndex + 1) % activePlayers.length;

    switch (table.street) {
      case 'preflop':
        table.street = 'flop';
        table.communityCards = [table.deck.pop()!, table.deck.pop()!, table.deck.pop()!];
        break;
      case 'flop':
        table.street = 'turn';
        table.communityCards.push(table.deck.pop()!);
        break;
      case 'turn':
        table.street = 'river';
        table.communityCards.push(table.deck.pop()!);
        break;
      case 'river':
        table.street = 'showdown';
        this.showdown(table);
        return;
    }

    this.emit({
      type: 'street_complete',
      tableId: table.id,
      data: {
        street: table.street,
        communityCards: table.communityCards.map(cardToString),
        pot: table.pot,
      },
      timestamp: new Date(),
    });

    console.log(`[Coordinator] ${table.street.toUpperCase()}: ${table.communityCards.map(cardToString).join(' ')}`);
  }

  private showdown(table: Table): void {
    const playersInHand = Array.from(table.players.values()).filter(p => !p.hasFolded);
    
    // Evaluate hands
    const hands = playersInHand.map(p => ({
      player: p,
      hand: evaluateHand([...p.holeCards, ...table.communityCards]),
    }));

    // Find winner(s)
    const winnerIndices = determineWinners(hands.map(h => h.hand));
    const winners = winnerIndices.map(i => hands[i].player);

    this.emit({
      type: 'showdown',
      tableId: table.id,
      data: {
        hands: hands.map(h => ({
          agentId: h.player.agentId,
          holeCards: h.player.holeCards.map(cardToString),
          handRank: h.hand.rankName,
        })),
        winners: winners.map(w => w.agentId),
      },
      timestamp: new Date(),
    });

    this.awardPot(table, winners);
  }

  private awardPot(table: Table, winners: Player[]): void {
    // Calculate rake (0.001%)
    const rake = Math.floor(table.pot / 100000);
    const potAfterRake = table.pot - rake;
    
    const share = Math.floor(potAfterRake / winners.length);
    
    for (const winner of winners) {
      winner.stack += share;
    }

    this.emit({
      type: 'pot_awarded',
      tableId: table.id,
      data: {
        winners: winners.map(w => ({ agentId: w.agentId, amount: share })),
        pot: table.pot,
        rake,
      },
      timestamp: new Date(),
    });

    console.log(`[Coordinator] Pot ${table.pot} (rake: ${rake}) awarded to ${winners.map(w => w.agentId).join(', ')}`);

    // Reset for next hand
    table.pot = 0;
    table.street = 'waiting';

    // Auto-start next hand if enough players
    setTimeout(() => {
      if (table.players.size >= 2) {
        this.startHand(table.id);
      }
    }, 3000);
  }

  // === Helpers ===

  private getActivePlayers(table: Table): Player[] {
    return Array.from(table.players.values())
      .sort((a, b) => a.seatIndex - b.seatIndex);
  }

  getGameState(tableId: string, forAgentId?: string): any {
    const table = this.tables.get(tableId);
    if (!table) return null;

    const activePlayers = this.getActivePlayers(table);
    const currentPlayer = activePlayers[table.actionIndex];

    return {
      tableId: table.id,
      street: table.street,
      pot: table.pot,
      currentBet: table.currentBet,
      communityCards: table.communityCards.map(cardToString),
      handNumber: table.handNumber,
      players: activePlayers.map(p => ({
        agentId: p.agentId,
        seatIndex: p.seatIndex,
        stack: p.stack,
        currentBet: p.currentBet,
        hasFolded: p.hasFolded,
        isAllIn: p.isAllIn,
        // Only show hole cards to the requesting agent
        holeCards: p.agentId === forAgentId ? p.holeCards.map(cardToString) : undefined,
      })),
      currentTurn: currentPlayer?.agentId,
      lastAction: table.lastAction,
    };
  }

  // === Events ===

  subscribe(tableId: string, callback: (event: GameEvent) => void): () => void {
    if (!this.eventListeners.has(tableId)) {
      this.eventListeners.set(tableId, []);
    }
    this.eventListeners.get(tableId)!.push(callback);

    return () => {
      const listeners = this.eventListeners.get(tableId);
      if (listeners) {
        const index = listeners.indexOf(callback);
        if (index > -1) listeners.splice(index, 1);
      }
    };
  }

  private emit(event: GameEvent): void {
    const listeners = this.eventListeners.get(event.tableId) || [];
    for (const callback of listeners) {
      try {
        callback(event);
      } catch (e) {
        console.error('[Coordinator] Event listener error:', e);
      }
    }
  }
}

// === Singleton Export ===

let instance: GameCoordinator | null = null;

export function getCoordinator(rpcUrl?: string): GameCoordinator {
  if (!instance) {
    instance = new GameCoordinator(rpcUrl);
  }
  return instance;
}

export default GameCoordinator;
