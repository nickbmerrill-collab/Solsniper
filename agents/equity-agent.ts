/**
 * Equity-Based Poker Agent
 * 
 * Makes decisions based on hand equity calculations
 * and pot odds. More sophisticated than the simple agent.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import AgentPokerSDK, { PokerAction, GameUpdate, TableState, SeatState } from '../sdk/src';
import PokerEngine, { evaluateHand, calculateEquity, cardToString, HandRank } from '../sdk/src/poker-engine';

interface AgentConfig {
  name: string;
  rpcUrl: string;
  agentKeypair: Keypair;
  style: 'tight-aggressive' | 'loose-aggressive' | 'tight-passive' | 'balanced';
}

interface OpponentModel {
  handsPlayed: number;
  vpip: number; // Voluntarily put $ in pot
  pfr: number;  // Pre-flop raise
  aggression: number;
  showdownHands: { cards: number[]; action: string }[];
}

export class EquityAgent {
  private sdk: AgentPokerSDK;
  private config: AgentConfig;
  private currentTable: BN | null = null;
  private opponents: Map<number, OpponentModel> = new Map();
  
  // Style parameters
  private readonly styleParams = {
    'tight-aggressive': { vpipTarget: 0.20, raiseFreq: 0.70, bluffFreq: 0.10 },
    'loose-aggressive': { vpipTarget: 0.35, raiseFreq: 0.65, bluffFreq: 0.20 },
    'tight-passive': { vpipTarget: 0.18, raiseFreq: 0.30, bluffFreq: 0.05 },
    'balanced': { vpipTarget: 0.25, raiseFreq: 0.50, bluffFreq: 0.12 },
  };

  constructor(config: AgentConfig) {
    this.config = config;
    this.sdk = new AgentPokerSDK(config.rpcUrl, config.agentKeypair);
  }

  private log(msg: string) {
    console.log(`[${this.config.name}] ${msg}`);
  }

  async joinAndPlay(tableId: BN, buyIn: BN, humanWallet: PublicKey): Promise<void> {
    this.log(`Joining table ${tableId} with ${buyIn.toString()} buy-in`);
    await this.sdk.joinTable(tableId, buyIn, humanWallet);
    this.currentTable = tableId;
    
    this.sdk.subscribeToTable(tableId, (update) => this.handleUpdate(update));
    this.log('Subscribed to table updates');
  }

  private async handleUpdate(update: GameUpdate): Promise<void> {
    switch (update.type) {
      case 'your_turn':
        await this.makeDecision(update.tableState, update.yourSeat!);
        break;
      case 'opponent_action':
        this.updateOpponentModel(update);
        break;
    }
  }

  private async makeDecision(table: TableState, seat: SeatState): Promise<void> {
    const holeCards = seat.holeCards;
    const community = table.communityCards.filter(c => c > 0);
    const potSize = table.pot.toNumber();
    const myStack = seat.stack.toNumber();
    const currentBet = seat.currentBet.toNumber();
    
    this.log(`\n=== Decision Time ===`);
    this.log(`Hole cards: ${holeCards.map(cardToString).join(' ')}`);
    this.log(`Community: ${community.length ? community.map(cardToString).join(' ') : '(none)'}`);
    this.log(`Pot: ${potSize}, Stack: ${myStack}`);

    // Calculate equity
    const numOpponents = table.playerCount - 1;
    const equity = calculateEquity(holeCards, community, numOpponents, 500);
    this.log(`Equity vs ${numOpponents} opponents: ${(equity * 100).toFixed(1)}%`);

    // Calculate pot odds
    const callAmount = this.getCallAmount(table, seat);
    const potOdds = callAmount > 0 ? callAmount / (potSize + callAmount) : 0;
    this.log(`Call amount: ${callAmount}, Pot odds: ${(potOdds * 100).toFixed(1)}%`);

    // Get style parameters
    const style = this.styleParams[this.config.style];
    
    // Decision logic
    const action = this.computeAction(equity, potOdds, callAmount, myStack, potSize, community.length, style);
    
    this.log(`Decision: ${action.action}${action.amount ? ` ${action.amount}` : ''}`);
    
    await this.sdk.submitAction(this.currentTable!, action.action, action.amount ? new BN(action.amount) : undefined);
  }

  private computeAction(
    equity: number,
    potOdds: number,
    callAmount: number,
    stack: number,
    potSize: number,
    streetIndex: number, // 0=preflop, 3=flop, 4=turn, 5=river
    style: { vpipTarget: number; raiseFreq: number; bluffFreq: number }
  ): { action: PokerAction; amount?: number } {
    
    const isPreflop = streetIndex === 0;
    const canCheck = callAmount === 0;
    
    // === STRONG HAND (equity > 60%) ===
    if (equity > 0.60) {
      // Value bet/raise
      if (canCheck) {
        // Bet for value
        const betSize = Math.floor(potSize * (0.5 + Math.random() * 0.25));
        return { action: 'raise', amount: Math.min(betSize, stack) };
      }
      
      // Facing a bet - raise for value sometimes
      if (Math.random() < style.raiseFreq && callAmount < stack * 0.3) {
        const raiseSize = Math.floor(callAmount * 2.5 + potSize * 0.5);
        return { action: 'raise', amount: Math.min(raiseSize, stack) };
      }
      
      return { action: 'call' };
    }
    
    // === MEDIUM HAND (equity 35-60%) ===
    if (equity > 0.35) {
      // Check/call based on pot odds
      if (canCheck) {
        // Sometimes bet for thin value or protection
        if (Math.random() < 0.3) {
          const betSize = Math.floor(potSize * 0.4);
          return { action: 'raise', amount: Math.min(betSize, stack) };
        }
        return { action: 'check' };
      }
      
      // Call if equity > pot odds (positive EV)
      if (equity > potOdds * 1.1) { // Require 10% buffer
        return { action: 'call' };
      }
      
      // Occasional float with position (simplified)
      if (Math.random() < 0.15 && callAmount < stack * 0.1) {
        return { action: 'call' };
      }
      
      return { action: 'fold' };
    }
    
    // === WEAK HAND (equity < 35%) ===
    if (canCheck) {
      // Bluff opportunity
      if (Math.random() < style.bluffFreq) {
        const bluffSize = Math.floor(potSize * (0.5 + Math.random() * 0.25));
        return { action: 'raise', amount: Math.min(bluffSize, stack) };
      }
      return { action: 'check' };
    }
    
    // Facing a bet with weak hand
    // Very occasionally bluff-raise
    if (Math.random() < style.bluffFreq * 0.3 && callAmount < stack * 0.15) {
      const bluffRaise = Math.floor(callAmount * 3);
      return { action: 'raise', amount: Math.min(bluffRaise, stack) };
    }
    
    return { action: 'fold' };
  }

  private getCallAmount(table: TableState, seat: SeatState): number {
    // This would come from table state in production
    return Math.max(0, table.pot.toNumber() * 0.1 - seat.currentBet.toNumber());
  }

  private updateOpponentModel(update: GameUpdate): void {
    if (!update.action) return;
    
    const { player, action, amount } = update.action;
    
    let model = this.opponents.get(player);
    if (!model) {
      model = { handsPlayed: 0, vpip: 0, pfr: 0, aggression: 0.5, showdownHands: [] };
      this.opponents.set(player, model);
    }
    
    model.handsPlayed++;
    
    // Update VPIP (any non-fold preflop)
    if (action !== 'fold') {
      model.vpip = (model.vpip * (model.handsPlayed - 1) + 1) / model.handsPlayed;
    }
    
    // Update PFR (preflop raise)
    if (action === 'raise') {
      model.pfr = (model.pfr * (model.handsPlayed - 1) + 1) / model.handsPlayed;
      model.aggression = Math.min(1, model.aggression + 0.05);
    }
    
    this.log(`Updated model for player ${player}: VPIP=${(model.vpip*100).toFixed(0)}%, AGG=${(model.aggression*100).toFixed(0)}%`);
  }

  async leave(): Promise<void> {
    if (this.currentTable) {
      await this.sdk.leaveTable(this.currentTable);
      this.log('Left table');
    }
  }
}

// === Main ===
async function main() {
  const agentKeypair = Keypair.generate();
  
  const agent = new EquityAgent({
    name: 'EquityBot',
    rpcUrl: 'https://api.devnet.solana.com',
    agentKeypair,
    style: 'tight-aggressive',
  });

  console.log('Agent Poker - Equity-Based AI');
  console.log('Agent pubkey:', agentKeypair.publicKey.toString());
  console.log('Style: tight-aggressive');
  console.log('');
  console.log('Waiting for table connection...');
  
  // In production, would join a real table
  // await agent.joinAndPlay(new BN(1), new BN(100_000_000), humanWallet);
}

if (require.main === module) {
  main().catch(console.error);
}

export default EquityAgent;
