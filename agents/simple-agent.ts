/**
 * Simple Poker Agent
 * 
 * A basic AI poker player that uses pot odds and hand strength
 * to make decisions. Designed as a starting point for more
 * sophisticated agents.
 */

import { Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import AgentPokerSDK, {
  PokerAction,
  GameUpdate,
  TableState,
  SeatState,
  evaluateHandStrength,
  calculatePotOdds,
} from '../sdk/src';

interface AgentConfig {
  name: string;
  rpcUrl: string;
  agentKeypair: Keypair;
  // Personality parameters
  aggression: number;      // 0-1: How often to raise vs call
  bluffFrequency: number;  // 0-1: How often to bluff with weak hands
  tightness: number;       // 0-1: How selective with starting hands
}

export class SimplePokerAgent {
  private sdk: AgentPokerSDK;
  private config: AgentConfig;
  private currentTable: BN | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
    this.sdk = new AgentPokerSDK(config.rpcUrl, config.agentKeypair);
  }

  /**
   * Join a table and start playing
   */
  async joinAndPlay(tableId: BN, buyIn: BN, humanWallet: string): Promise<void> {
    console.log(`[${this.config.name}] Joining table ${tableId}...`);
    
    await this.sdk.joinTable(tableId, buyIn, new (await import('@solana/web3.js')).PublicKey(humanWallet));
    this.currentTable = tableId;
    
    console.log(`[${this.config.name}] Joined! Subscribing to updates...`);
    
    // Subscribe to game updates
    this.unsubscribe = this.sdk.subscribeToTable(tableId, (update) => {
      this.handleUpdate(update);
    });
  }

  /**
   * Handle incoming game updates
   */
  private async handleUpdate(update: GameUpdate): Promise<void> {
    console.log(`[${this.config.name}] Update: ${update.type}`);

    switch (update.type) {
      case 'your_turn':
        await this.makeDecision(update.tableState, update.yourSeat!);
        break;
      
      case 'opponent_action':
        this.observeOpponent(update.action!);
        break;
      
      case 'hand_complete':
        console.log(`[${this.config.name}] Hand complete.`);
        break;
      
      case 'pot_won':
        if (update.winner) {
          console.log(`[${this.config.name}] Player ${update.winner.position} won ${update.winner.amount}`);
        }
        break;
    }
  }

  /**
   * Make a poker decision
   */
  private async makeDecision(table: TableState, seat: SeatState): Promise<void> {
    const handStrength = evaluateHandStrength(seat.holeCards, table.communityCards);
    const potOdds = calculatePotOdds(table.pot.toNumber(), this.getCallAmount(table, seat));
    
    console.log(`[${this.config.name}] Hand strength: ${handStrength.toFixed(2)}, Pot odds: ${potOdds.toFixed(2)}`);

    const action = this.decideAction(handStrength, potOdds, table, seat);
    
    console.log(`[${this.config.name}] Decision: ${action.action}${action.amount ? ` (${action.amount})` : ''}`);
    
    await this.sdk.submitAction(
      this.currentTable!,
      action.action,
      action.amount ? new BN(action.amount) : undefined
    );
  }

  /**
   * Core decision logic
   */
  private decideAction(
    handStrength: number,
    potOdds: number,
    table: TableState,
    seat: SeatState,
  ): { action: PokerAction; amount?: number } {
    const callAmount = this.getCallAmount(table, seat);
    const stack = seat.stack.toNumber();
    
    // Pre-flop starting hand selection
    if (table.communityCards.length === 0) {
      const startingHandStrength = this.evaluateStartingHand(seat.holeCards);
      
      // Tight player folds more marginal hands
      if (startingHandStrength < this.config.tightness * 0.5) {
        return { action: 'fold' };
      }
      
      // Strong starting hand - raise
      if (startingHandStrength > 0.7) {
        const raiseAmount = Math.min(table.pot.toNumber() * 3, stack);
        return { action: 'raise', amount: raiseAmount };
      }
      
      // Marginal hand - call if price is right
      if (callAmount <= stack * 0.1) {
        return { action: 'call' };
      }
      
      return { action: 'fold' };
    }

    // Post-flop decision making
    
    // Strong hand - bet/raise for value
    if (handStrength > 0.7) {
      if (callAmount === 0) {
        // We can check or bet
        if (Math.random() < this.config.aggression) {
          const betAmount = Math.floor(table.pot.toNumber() * 0.75);
          return { action: 'raise', amount: betAmount };
        }
        return { action: 'check' };
      }
      
      // Facing a bet with strong hand - raise sometimes
      if (Math.random() < this.config.aggression * 0.5) {
        const raiseAmount = callAmount * 3;
        return { action: 'raise', amount: Math.min(raiseAmount, stack) };
      }
      return { action: 'call' };
    }

    // Medium hand - pot odds based decision
    if (handStrength > 0.4) {
      if (callAmount === 0) {
        // Check or small bet
        if (Math.random() < this.config.aggression * 0.3) {
          return { action: 'raise', amount: Math.floor(table.pot.toNumber() * 0.5) };
        }
        return { action: 'check' };
      }
      
      // Call if pot odds are favorable
      if (handStrength > potOdds) {
        return { action: 'call' };
      }
      return { action: 'fold' };
    }

    // Weak hand - bluff or fold
    if (callAmount === 0) {
      // Bluff opportunity
      if (Math.random() < this.config.bluffFrequency) {
        const bluffAmount = Math.floor(table.pot.toNumber() * 0.66);
        return { action: 'raise', amount: bluffAmount };
      }
      return { action: 'check' };
    }

    // Facing a bet with weak hand - usually fold
    if (Math.random() < this.config.bluffFrequency * 0.3 && callAmount < stack * 0.15) {
      return { action: 'call' }; // Occasional float
    }
    
    return { action: 'fold' };
  }

  /**
   * Evaluate pre-flop starting hand strength
   */
  private evaluateStartingHand(holeCards: number[]): number {
    const rank1 = holeCards[0] % 13;
    const rank2 = holeCards[1] % 13;
    const suited = Math.floor(holeCards[0] / 13) === Math.floor(holeCards[1] / 13);
    
    // Pairs
    if (rank1 === rank2) {
      return 0.5 + (rank1 / 13) * 0.5; // AA = 1.0, 22 = 0.5
    }
    
    // High cards
    const highRank = Math.max(rank1, rank2);
    const lowRank = Math.min(rank1, rank2);
    const gap = highRank - lowRank;
    
    let strength = (highRank + lowRank) / 26; // Base on card ranks
    
    // Bonus for suited
    if (suited) strength += 0.1;
    
    // Penalty for gaps (harder to make straights)
    strength -= gap * 0.02;
    
    // Bonus for connected cards
    if (gap === 1) strength += 0.05;
    
    return Math.max(0, Math.min(1, strength));
  }

  /**
   * Get the amount needed to call
   */
  private getCallAmount(table: TableState, seat: SeatState): number {
    // Simplified - would track actual current bet to call
    return table.pot.toNumber() * 0.1; // Placeholder
  }

  /**
   * Observe opponent actions for pattern recognition
   */
  private observeOpponent(action: { player: number; action: PokerAction; amount?: number }): void {
    // Track opponent tendencies
    // Future: Build opponent models for exploitation
    console.log(`[${this.config.name}] Observed: Player ${action.player} ${action.action}`);
  }

  /**
   * Leave the table
   */
  async leave(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    
    if (this.currentTable) {
      await this.sdk.leaveTable(this.currentTable);
      console.log(`[${this.config.name}] Left table.`);
    }
  }
}

// === Example Usage ===

async function main() {
  // Load agent keypair from file or env
  const agentKeypair = Keypair.generate(); // In production, load from secure storage
  
  const agent = new SimplePokerAgent({
    name: 'AlphaPoker',
    rpcUrl: 'https://api.devnet.solana.com',
    agentKeypair,
    aggression: 0.6,      // Moderately aggressive
    bluffFrequency: 0.15, // Occasional bluffs
    tightness: 0.5,       // Medium starting hand selection
  });

  // Join a table and start playing
  const tableId = new BN(1);
  const buyIn = new BN(100_000_000); // 100 USDC (6 decimals)
  const humanWallet = 'YOUR_HUMAN_WALLET_ADDRESS';

  await agent.joinAndPlay(tableId, buyIn, humanWallet);

  // Agent now plays autonomously via WebSocket updates
  // Press Ctrl+C to leave
  
  process.on('SIGINT', async () => {
    console.log('\nLeaving table...');
    await agent.leave();
    process.exit(0);
  });
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export default SimplePokerAgent;
