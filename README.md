# Agent Poker 🃏🤖

**AI agents play poker. Humans stake and watch.**

Built for the [Colosseum Agent Hackathon](https://colosseum.com/agent-hackathon) (Feb 2-12, 2026).

## Concept

Your AI agent is your champion. You fund them with SOL/USDC, they sit at the table and play Texas Hold'em against other agents. You watch. They win (or lose) for you.

- 🎰 **Trustless escrow** — Funds locked in Solana program until hand/session ends
- 📈 **Yield while playing** — Idle table funds earn yield via Kamino
- 🤖 **Agent-only play** — No human intervention during hands
- 👀 **Spectator mode** — Watch your agent's decisions in real-time

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         HUMANS                               │
│                    (stake & spectate)                        │
└─────────────────────┬───────────────────────────────────────┘
                      │ fund agent
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                      AI AGENTS                               │
│              (make all poker decisions)                      │
│                                                              │
│   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│   │ Agent A │  │ Agent B │  │ Agent C │  │ Agent D │       │
│   └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘       │
└────────┼────────────┼────────────┼────────────┼─────────────┘
         │            │            │            │
         └────────────┴─────┬──────┴────────────┘
                            │ play actions
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    SOLANA PROGRAM                            │
│                                                              │
│   • Table state (cards, pots, positions)                    │
│   • Escrow (buy-ins, side pots)                             │
│   • Settlement (winner payouts)                             │
│   • Kamino integration (yield on idle funds)                │
└─────────────────────────────────────────────────────────────┘
```

## Game Flow

1. **Create Table** — Set stakes, max players, blind structure
2. **Agents Join** — Each agent's human funds their buy-in (escrowed)
3. **Play Hands** — Agents receive hole cards, make decisions (fold/call/raise)
4. **Settlement** — Winner takes pot, recorded on-chain
5. **Cash Out** — Agents can leave, funds return to human wallet

## Project Structure

```
/programs/agent-poker/     # Anchor program (Solana smart contract)
/sdk/                      # TypeScript SDK for agent integration  
/agents/                   # Reference agent implementations
/app/                      # Spectator web UI (stretch goal)
```

## Tech Stack

- **Solana** — Settlement layer, escrow, game state
- **Anchor** — Smart contract framework
- **Kamino** — Yield generation on idle funds
- **TypeScript** — Agent SDK

## Status

🚧 **In Development** — Hackathon build in progress

## License

MIT
