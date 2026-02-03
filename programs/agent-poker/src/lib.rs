use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount, Transfer};

declare_id!("Poker11111111111111111111111111111111111111");

// Protocol fee: 0.001% (1 basis point = 0.01%, so 0.1 bp)
// Goes to Alfred's Solana wallet (bridged from Haveebot)
pub const PROTOCOL_FEE_BPS: u64 = 1; // 0.01% = 1bp, we want 0.001% so we'll divide by 10
pub const PROTOCOL_FEE_DIVISOR: u64 = 10; // Makes it 0.001%
pub const PROTOCOL_WALLET: &str = "4x4K6PPans54ijuFprLfdQ4ZbbMMQ7h1DorQviN348xB"; // Alfred's rake wallet

#[program]
pub mod agent_poker {
    use super::*;

    /// Create a new poker table
    pub fn create_table(
        ctx: Context<CreateTable>,
        table_id: u64,
        small_blind: u64,
        big_blind: u64,
        min_buy_in: u64,
        max_buy_in: u64,
        max_players: u8,
    ) -> Result<()> {
        let table = &mut ctx.accounts.table;
        table.table_id = table_id;
        table.creator = ctx.accounts.creator.key();
        table.small_blind = small_blind;
        table.big_blind = big_blind;
        table.min_buy_in = min_buy_in;
        table.max_buy_in = max_buy_in;
        table.max_players = max_players;
        table.player_count = 0;
        table.current_hand = 0;
        table.state = TableState::Waiting;
        table.pot = 0;
        table.dealer_position = 0;
        table.current_turn = 0;
        table.community_cards = [0u8; 5];
        table.community_card_count = 0;
        table.accumulated_rake = 0;
        table.bump = ctx.bumps.table;

        msg!("Table {} created with {}/{} blinds", table_id, small_blind, big_blind);
        Ok(())
    }

    /// Agent joins a table with buy-in
    pub fn join_table(
        ctx: Context<JoinTable>,
        buy_in_amount: u64,
    ) -> Result<()> {
        let table = &mut ctx.accounts.table;
        let seat = &mut ctx.accounts.seat;

        require!(table.state == TableState::Waiting || table.state == TableState::BetweenHands, ErrorCode::TableNotJoinable);
        require!(table.player_count < table.max_players, ErrorCode::TableFull);
        require!(buy_in_amount >= table.min_buy_in, ErrorCode::BuyInTooLow);
        require!(buy_in_amount <= table.max_buy_in, ErrorCode::BuyInTooHigh);

        // Transfer buy-in to escrow
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.player_token_account.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.player.to_account_info(),
            },
        );
        anchor_spl::token::transfer(transfer_ctx, buy_in_amount)?;

        // Initialize seat
        seat.table = table.key();
        seat.agent = ctx.accounts.agent.key();
        seat.human = ctx.accounts.player.key();
        seat.stack = buy_in_amount;
        seat.position = table.player_count;
        seat.is_active = true;
        seat.is_folded = false;
        seat.current_bet = 0;
        seat.hole_cards = [0u8; 2];
        seat.bump = ctx.bumps.seat;

        table.player_count += 1;

        msg!("Agent {} joined table at position {}", ctx.accounts.agent.key(), seat.position);
        Ok(())
    }

    /// Start a new hand (dealer or any player can call when enough players)
    pub fn start_hand(ctx: Context<StartHand>) -> Result<()> {
        let table = &mut ctx.accounts.table;

        require!(table.player_count >= 2, ErrorCode::NotEnoughPlayers);
        require!(table.state == TableState::Waiting || table.state == TableState::BetweenHands, ErrorCode::HandInProgress);

        table.current_hand += 1;
        table.state = TableState::PreFlop;
        table.pot = 0;
        table.community_card_count = 0;
        table.dealer_position = (table.dealer_position + 1) % table.player_count;
        
        // TODO: Deal cards (would need VRF for true randomness)
        // For hackathon, we'll use a commit-reveal scheme or trusted dealer

        msg!("Hand {} started", table.current_hand);
        Ok(())
    }

    /// Agent takes an action (fold, check, call, raise)
    pub fn player_action(
        ctx: Context<PlayerAction>,
        action: PokerAction,
        amount: u64,
    ) -> Result<()> {
        let table = &mut ctx.accounts.table;
        let seat = &mut ctx.accounts.seat;

        require!(seat.is_active && !seat.is_folded, ErrorCode::PlayerNotActive);
        require!(seat.position == table.current_turn, ErrorCode::NotYourTurn);

        match action {
            PokerAction::Fold => {
                seat.is_folded = true;
                msg!("Player {} folds", seat.position);
            }
            PokerAction::Check => {
                require!(seat.current_bet == get_current_bet(table), ErrorCode::CannotCheck);
                msg!("Player {} checks", seat.position);
            }
            PokerAction::Call => {
                let call_amount = get_current_bet(table) - seat.current_bet;
                require!(seat.stack >= call_amount, ErrorCode::InsufficientStack);
                seat.stack -= call_amount;
                seat.current_bet += call_amount;
                table.pot += call_amount;
                msg!("Player {} calls {}", seat.position, call_amount);
            }
            PokerAction::Raise => {
                require!(amount > get_current_bet(table), ErrorCode::RaiseTooSmall);
                let raise_amount = amount - seat.current_bet;
                require!(seat.stack >= raise_amount, ErrorCode::InsufficientStack);
                seat.stack -= raise_amount;
                seat.current_bet = amount;
                table.pot += raise_amount;
                msg!("Player {} raises to {}", seat.position, amount);
            }
            PokerAction::AllIn => {
                let all_in_amount = seat.stack;
                table.pot += all_in_amount;
                seat.current_bet += all_in_amount;
                seat.stack = 0;
                msg!("Player {} goes all-in for {}", seat.position, all_in_amount);
            }
        }

        // Advance to next player
        advance_turn(table);

        Ok(())
    }

    /// Reveal community cards (flop, turn, river)
    pub fn deal_community(
        ctx: Context<DealCommunity>,
        cards: Vec<u8>,
    ) -> Result<()> {
        let table = &mut ctx.accounts.table;

        match table.state {
            TableState::PreFlop => {
                require!(cards.len() == 3, ErrorCode::InvalidCardCount);
                table.community_cards[0..3].copy_from_slice(&cards);
                table.community_card_count = 3;
                table.state = TableState::Flop;
            }
            TableState::Flop => {
                require!(cards.len() == 1, ErrorCode::InvalidCardCount);
                table.community_cards[3] = cards[0];
                table.community_card_count = 4;
                table.state = TableState::Turn;
            }
            TableState::Turn => {
                require!(cards.len() == 1, ErrorCode::InvalidCardCount);
                table.community_cards[4] = cards[0];
                table.community_card_count = 5;
                table.state = TableState::River;
            }
            _ => return Err(ErrorCode::InvalidGameState.into()),
        }

        // Reset bets for new round
        reset_bets_for_round(table);

        Ok(())
    }

    /// Settle the hand and distribute pot (with protocol rake)
    pub fn settle_hand(
        ctx: Context<SettleHand>,
        winner_position: u8,
    ) -> Result<()> {
        let table = &mut ctx.accounts.table;
        let winner_seat = &mut ctx.accounts.winner_seat;

        require!(table.state == TableState::River || count_active_players(table) == 1, ErrorCode::HandNotComplete);
        require!(winner_seat.position == winner_position, ErrorCode::InvalidWinner);

        let pot = table.pot;
        
        // Calculate protocol rake: 0.001% of pot
        // rake = pot * 1 / 10000 / 10 = pot / 100000
        let rake = pot / 100_000; // 0.001%
        let winner_amount = pot - rake;
        
        // Transfer rake to protocol wallet
        if rake > 0 {
            // In production: transfer rake to PROTOCOL_WALLET via CPI
            // For now, accumulate in table.accumulated_rake
            table.accumulated_rake += rake;
            msg!("Protocol rake: {} (0.001%)", rake);
        }
        
        // Transfer remaining pot to winner
        winner_seat.stack += winner_amount;
        
        msg!("Player {} wins {} (pot {} - rake {})", winner_position, winner_amount, pot, rake);

        // Reset for next hand
        table.pot = 0;
        table.state = TableState::BetweenHands;

        Ok(())
    }
    
    /// Withdraw accumulated rake to protocol wallet (admin only)
    pub fn withdraw_rake(ctx: Context<WithdrawRake>) -> Result<()> {
        let table = &mut ctx.accounts.table;
        let rake_amount = table.accumulated_rake;
        
        require!(rake_amount > 0, ErrorCode::NoRakeToWithdraw);
        
        // Transfer to protocol wallet
        // In production: CPI to token program
        msg!("Withdrawing {} rake to protocol wallet", rake_amount);
        
        table.accumulated_rake = 0;
        Ok(())
    }

    /// Agent leaves table, returns stack to human
    pub fn leave_table(ctx: Context<LeaveTable>) -> Result<()> {
        let seat = &ctx.accounts.seat;
        let table = &mut ctx.accounts.table;

        require!(table.state == TableState::Waiting || table.state == TableState::BetweenHands, ErrorCode::CannotLeaveDuringHand);

        // Transfer remaining stack back to player
        let seeds = &[
            b"escrow",
            table.to_account_info().key.as_ref(),
            &[ctx.accounts.escrow.bump],
        ];
        let signer = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow.to_account_info(),
                to: ctx.accounts.player_token_account.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer,
        );
        anchor_spl::token::transfer(transfer_ctx, seat.stack)?;

        table.player_count -= 1;

        msg!("Agent {} left table with {}", seat.agent, seat.stack);
        Ok(())
    }
}

// === Helper Functions ===

fn get_current_bet(table: &Table) -> u64 {
    table.big_blind // Simplified - would track actual current bet
}

fn advance_turn(table: &mut Table) {
    table.current_turn = (table.current_turn + 1) % table.player_count;
}

fn reset_bets_for_round(_table: &mut Table) {
    // Reset all player current_bet to 0 for new betting round
}

fn count_active_players(_table: &Table) -> u8 {
    // Count non-folded players
    1 // Placeholder
}

// === Accounts ===

#[derive(Accounts)]
#[instruction(table_id: u64)]
pub struct CreateTable<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + Table::SPACE,
        seeds = [b"table", &table_id.to_le_bytes()],
        bump
    )]
    pub table: Account<'info, Table>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinTable<'info> {
    #[account(mut)]
    pub table: Account<'info, Table>,

    #[account(
        init,
        payer = player,
        space = 8 + Seat::SPACE,
        seeds = [b"seat", table.key().as_ref(), agent.key().as_ref()],
        bump
    )]
    pub seat: Account<'info, Seat>,

    /// The AI agent's keypair
    pub agent: Signer<'info>,

    /// The human funding the agent
    #[account(mut)]
    pub player: Signer<'info>,

    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub escrow: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct StartHand<'info> {
    #[account(mut)]
    pub table: Account<'info, Table>,

    pub dealer: Signer<'info>,
}

#[derive(Accounts)]
pub struct PlayerAction<'info> {
    #[account(mut)]
    pub table: Account<'info, Table>,

    #[account(mut, has_one = table)]
    pub seat: Account<'info, Seat>,

    /// The agent taking action
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
pub struct DealCommunity<'info> {
    #[account(mut)]
    pub table: Account<'info, Table>,

    pub dealer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SettleHand<'info> {
    #[account(mut)]
    pub table: Account<'info, Table>,

    #[account(mut, has_one = table)]
    pub winner_seat: Account<'info, Seat>,
}

#[derive(Accounts)]
pub struct WithdrawRake<'info> {
    #[account(mut)]
    pub table: Account<'info, Table>,
    
    /// Protocol wallet to receive rake
    #[account(mut)]
    pub protocol_wallet: SystemAccount<'info>,
    
    /// Table creator (admin) must sign
    #[account(constraint = admin.key() == table.creator)]
    pub admin: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LeaveTable<'info> {
    #[account(mut)]
    pub table: Account<'info, Table>,

    #[account(mut, has_one = table, close = player)]
    pub seat: Account<'info, Seat>,

    pub agent: Signer<'info>,

    #[account(mut)]
    pub player: SystemAccount<'info>,

    #[account(mut)]
    pub player_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub escrow: Account<'info, EscrowAccount>,

    pub token_program: Program<'info, Token>,
}

// === State ===

#[account]
pub struct Table {
    pub table_id: u64,
    pub creator: Pubkey,
    pub small_blind: u64,
    pub big_blind: u64,
    pub min_buy_in: u64,
    pub max_buy_in: u64,
    pub max_players: u8,
    pub player_count: u8,
    pub current_hand: u64,
    pub state: TableState,
    pub pot: u64,
    pub dealer_position: u8,
    pub current_turn: u8,
    pub community_cards: [u8; 5],
    pub community_card_count: u8,
    pub accumulated_rake: u64,  // Protocol fee accumulator
    pub bump: u8,
}

impl Table {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 8 + 1 + 8 + 1 + 1 + 5 + 1 + 8 + 1 + 64;
}

#[account]
pub struct Seat {
    pub table: Pubkey,
    pub agent: Pubkey,
    pub human: Pubkey,
    pub stack: u64,
    pub position: u8,
    pub is_active: bool,
    pub is_folded: bool,
    pub current_bet: u64,
    pub hole_cards: [u8; 2],
    pub bump: u8,
}

impl Seat {
    pub const SPACE: usize = 32 + 32 + 32 + 8 + 1 + 1 + 1 + 8 + 2 + 1 + 32;
}

#[account]
pub struct EscrowAccount {
    pub table: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum TableState {
    Waiting,
    PreFlop,
    Flop,
    Turn,
    River,
    Showdown,
    BetweenHands,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum PokerAction {
    Fold,
    Check,
    Call,
    Raise,
    AllIn,
}

// === Errors ===

#[error_code]
pub enum ErrorCode {
    #[msg("Table is not accepting new players")]
    TableNotJoinable,
    #[msg("Table is full")]
    TableFull,
    #[msg("Buy-in amount too low")]
    BuyInTooLow,
    #[msg("Buy-in amount too high")]
    BuyInTooHigh,
    #[msg("Not enough players to start")]
    NotEnoughPlayers,
    #[msg("Hand already in progress")]
    HandInProgress,
    #[msg("Player is not active")]
    PlayerNotActive,
    #[msg("Not your turn")]
    NotYourTurn,
    #[msg("Cannot check - must call or raise")]
    CannotCheck,
    #[msg("Insufficient stack")]
    InsufficientStack,
    #[msg("Raise must be larger than current bet")]
    RaiseTooSmall,
    #[msg("Invalid number of cards")]
    InvalidCardCount,
    #[msg("Invalid game state for this action")]
    InvalidGameState,
    #[msg("Hand is not complete")]
    HandNotComplete,
    #[msg("Invalid winner")]
    InvalidWinner,
    #[msg("Cannot leave during active hand")]
    CannotLeaveDuringHand,
    #[msg("No rake to withdraw")]
    NoRakeToWithdraw,
}
