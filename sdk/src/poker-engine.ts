/**
 * Poker Game Engine
 * 
 * Pure TypeScript poker logic for hand evaluation, 
 * game state management, and winner determination.
 */

// Card representation: 0-51
// rank = card % 13 (0=2, 1=3, ..., 12=A)
// suit = floor(card / 13) (0=hearts, 1=diamonds, 2=clubs, 3=spades)

export type Card = number;
export type Hand = Card[];

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUITS = ['h', 'd', 'c', 's'];

export enum HandRank {
  HIGH_CARD = 0,
  PAIR = 1,
  TWO_PAIR = 2,
  THREE_OF_A_KIND = 3,
  STRAIGHT = 4,
  FLUSH = 5,
  FULL_HOUSE = 6,
  FOUR_OF_A_KIND = 7,
  STRAIGHT_FLUSH = 8,
  ROYAL_FLUSH = 9,
}

export interface EvaluatedHand {
  rank: HandRank;
  rankName: string;
  highCards: number[]; // For tiebreakers, highest first
  score: number; // Single number for comparison
}

export function cardToString(card: Card): string {
  const rank = RANKS[card % 13];
  const suit = SUITS[Math.floor(card / 13)];
  return `${rank}${suit}`;
}

export function stringToCard(str: string): Card {
  const rank = RANKS.indexOf(str[0].toUpperCase());
  const suit = SUITS.indexOf(str[1].toLowerCase());
  return suit * 13 + rank;
}

export function getRank(card: Card): number {
  return card % 13;
}

export function getSuit(card: Card): number {
  return Math.floor(card / 13);
}

/**
 * Create a shuffled deck
 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (let i = 0; i < 52; i++) {
    deck.push(i);
  }
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Evaluate a 5-7 card hand and return its ranking
 */
export function evaluateHand(cards: Card[]): EvaluatedHand {
  if (cards.length < 5) {
    throw new Error('Need at least 5 cards to evaluate');
  }

  // If more than 5 cards, find the best 5-card combination
  if (cards.length > 5) {
    let bestHand: EvaluatedHand | null = null;
    const combos = combinations(cards, 5);
    for (const combo of combos) {
      const hand = evaluateFiveCards(combo);
      if (!bestHand || hand.score > bestHand.score) {
        bestHand = hand;
      }
    }
    return bestHand!;
  }

  return evaluateFiveCards(cards);
}

function evaluateFiveCards(cards: Card[]): EvaluatedHand {
  const ranks = cards.map(getRank).sort((a, b) => b - a);
  const suits = cards.map(getSuit);
  
  const rankCounts = new Map<number, number>();
  for (const r of ranks) {
    rankCounts.set(r, (rankCounts.get(r) || 0) + 1);
  }
  
  const isFlush = suits.every(s => s === suits[0]);
  const isStraight = checkStraight(ranks);
  const isWheel = ranks[0] === 12 && ranks[1] === 3 && ranks[2] === 2 && ranks[3] === 1 && ranks[4] === 0; // A-2-3-4-5
  
  const counts = Array.from(rankCounts.values()).sort((a, b) => b - a);
  
  // Royal Flush
  if (isFlush && isStraight && ranks[0] === 12 && ranks[4] === 8) {
    return {
      rank: HandRank.ROYAL_FLUSH,
      rankName: 'Royal Flush',
      highCards: ranks,
      score: 9_00_00_00_00_00 + ranks[0],
    };
  }
  
  // Straight Flush
  if (isFlush && (isStraight || isWheel)) {
    const highCard = isWheel ? 3 : ranks[0]; // Wheel's high card is 5 (index 3)
    return {
      rank: HandRank.STRAIGHT_FLUSH,
      rankName: 'Straight Flush',
      highCards: [highCard],
      score: 8_00_00_00_00_00 + highCard,
    };
  }
  
  // Four of a Kind
  if (counts[0] === 4) {
    const quadRank = [...rankCounts.entries()].find(([_, c]) => c === 4)![0];
    const kicker = [...rankCounts.entries()].find(([_, c]) => c === 1)![0];
    return {
      rank: HandRank.FOUR_OF_A_KIND,
      rankName: 'Four of a Kind',
      highCards: [quadRank, kicker],
      score: 7_00_00_00_00_00 + quadRank * 100 + kicker,
    };
  }
  
  // Full House
  if (counts[0] === 3 && counts[1] === 2) {
    const tripRank = [...rankCounts.entries()].find(([_, c]) => c === 3)![0];
    const pairRank = [...rankCounts.entries()].find(([_, c]) => c === 2)![0];
    return {
      rank: HandRank.FULL_HOUSE,
      rankName: 'Full House',
      highCards: [tripRank, pairRank],
      score: 6_00_00_00_00_00 + tripRank * 100 + pairRank,
    };
  }
  
  // Flush
  if (isFlush) {
    return {
      rank: HandRank.FLUSH,
      rankName: 'Flush',
      highCards: ranks,
      score: 5_00_00_00_00_00 + ranks[0] * 10000 + ranks[1] * 1000 + ranks[2] * 100 + ranks[3] * 10 + ranks[4],
    };
  }
  
  // Straight
  if (isStraight || isWheel) {
    const highCard = isWheel ? 3 : ranks[0];
    return {
      rank: HandRank.STRAIGHT,
      rankName: 'Straight',
      highCards: [highCard],
      score: 4_00_00_00_00_00 + highCard,
    };
  }
  
  // Three of a Kind
  if (counts[0] === 3) {
    const tripRank = [...rankCounts.entries()].find(([_, c]) => c === 3)![0];
    const kickers = [...rankCounts.entries()].filter(([_, c]) => c === 1).map(([r]) => r).sort((a, b) => b - a);
    return {
      rank: HandRank.THREE_OF_A_KIND,
      rankName: 'Three of a Kind',
      highCards: [tripRank, ...kickers],
      score: 3_00_00_00_00_00 + tripRank * 10000 + kickers[0] * 100 + kickers[1],
    };
  }
  
  // Two Pair
  if (counts[0] === 2 && counts[1] === 2) {
    const pairs = [...rankCounts.entries()].filter(([_, c]) => c === 2).map(([r]) => r).sort((a, b) => b - a);
    const kicker = [...rankCounts.entries()].find(([_, c]) => c === 1)![0];
    return {
      rank: HandRank.TWO_PAIR,
      rankName: 'Two Pair',
      highCards: [...pairs, kicker],
      score: 2_00_00_00_00_00 + pairs[0] * 10000 + pairs[1] * 100 + kicker,
    };
  }
  
  // Pair
  if (counts[0] === 2) {
    const pairRank = [...rankCounts.entries()].find(([_, c]) => c === 2)![0];
    const kickers = [...rankCounts.entries()].filter(([_, c]) => c === 1).map(([r]) => r).sort((a, b) => b - a);
    return {
      rank: HandRank.PAIR,
      rankName: 'Pair',
      highCards: [pairRank, ...kickers],
      score: 1_00_00_00_00_00 + pairRank * 1000000 + kickers[0] * 10000 + kickers[1] * 100 + kickers[2],
    };
  }
  
  // High Card
  return {
    rank: HandRank.HIGH_CARD,
    rankName: 'High Card',
    highCards: ranks,
    score: ranks[0] * 100000000 + ranks[1] * 1000000 + ranks[2] * 10000 + ranks[3] * 100 + ranks[4],
  };
}

function checkStraight(sortedRanks: number[]): boolean {
  for (let i = 0; i < sortedRanks.length - 1; i++) {
    if (sortedRanks[i] - sortedRanks[i + 1] !== 1) {
      return false;
    }
  }
  return true;
}

function combinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length === 0) return [];
  
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
  const withoutFirst = combinations(rest, k);
  
  return [...withFirst, ...withoutFirst];
}

/**
 * Compare two hands. Returns:
 * - positive if hand1 wins
 * - negative if hand2 wins
 * - 0 if tie
 */
export function compareHands(hand1: EvaluatedHand, hand2: EvaluatedHand): number {
  return hand1.score - hand2.score;
}

/**
 * Determine winners from multiple hands
 * Returns indices of winning players (can be multiple for split pot)
 */
export function determineWinners(hands: EvaluatedHand[]): number[] {
  let maxScore = -1;
  let winners: number[] = [];
  
  for (let i = 0; i < hands.length; i++) {
    if (hands[i].score > maxScore) {
      maxScore = hands[i].score;
      winners = [i];
    } else if (hands[i].score === maxScore) {
      winners.push(i);
    }
  }
  
  return winners;
}

/**
 * Calculate hand equity via Monte Carlo simulation
 * Returns probability of winning (0-1)
 */
export function calculateEquity(
  holeCards: Card[],
  communityCards: Card[],
  numOpponents: number,
  simulations: number = 1000
): number {
  const deck = createDeck().filter(c => 
    !holeCards.includes(c) && !communityCards.includes(c)
  );
  
  let wins = 0;
  
  for (let i = 0; i < simulations; i++) {
    // Shuffle remaining deck
    const shuffled = [...deck].sort(() => Math.random() - 0.5);
    
    // Deal remaining community cards
    const cardsNeeded = 5 - communityCards.length;
    const fullBoard = [...communityCards, ...shuffled.slice(0, cardsNeeded)];
    let deckIndex = cardsNeeded;
    
    // Evaluate our hand
    const ourHand = evaluateHand([...holeCards, ...fullBoard]);
    
    // Deal opponent hands and evaluate
    let weWin = true;
    for (let j = 0; j < numOpponents; j++) {
      const oppCards = [shuffled[deckIndex++], shuffled[deckIndex++]];
      const oppHand = evaluateHand([...oppCards, ...fullBoard]);
      if (oppHand.score >= ourHand.score) {
        weWin = false;
        break;
      }
    }
    
    if (weWin) wins++;
  }
  
  return wins / simulations;
}

export default {
  createDeck,
  evaluateHand,
  compareHands,
  determineWinners,
  calculateEquity,
  cardToString,
  stringToCard,
  HandRank,
};
