// Shared helper for computing the recommended account balance needed to
// run the bot safely long-term. Used by both ConfigPanel (sidebar hint)
// and Dashboard (confirm modal) so the two values ALWAYS match.
//
// Design rationale:
//   The bot opens a hedged buy+sell pair. For long-term stable running,
//   we want to survive (a) initial margin for BOTH sides, (b) adverse
//   price moves during the brief window when only one side is open,
//   (c) accumulated fees + slippage over many cycles, and (d) some
//   unknown drift.
//
//   The simplest robust rule that captures all of this is:
//     required = notional × max(1.0, 3 / leverage)
//
//   At leverage ≥ 3x: required = notional (1:1 collateralization, super safe)
//   At 2x leverage:   required = 1.5 × notional
//   At 1x leverage:   required = 3 × notional (spot-like, both sides + buffer)
//
//   Requiring >= 1x notional even at high leverage guarantees that short-term
//   price drifts can NEVER leave the account too underfunded to open the
//   opposite side — which was the original failure mode the user reported
//   (0.005 BTC @ 5x with only $200 collateral → failed to open sell).

const MARGIN_FIXED_LEVERAGE = 10;

/**
 * Compute the recommended minimum account balance in USD.
 *
 * @param {object} args
 * @param {number} args.qtyBtc     Trade size in BTC.
 * @param {number} args.btcPrice   Reference BTC/USD price.
 * @param {number} args.leverage   Requested leverage multiplier.
 * @param {boolean} [args.isMargin] Whether this is Kraken Margin (fixed 10x).
 * @returns {{ notionalUsd:number, recommendedUsd:number, minBalanceUsd:number }}
 *   notionalUsd    — raw notional (qty × price)
 *   recommendedUsd — unrounded recommended balance
 *   minBalanceUsd  — final value rounded UP to the nearest $10
 */
export function computeRequiredBalance({ qtyBtc, btcPrice, leverage, isMargin = false }) {
  const qty = Number(qtyBtc) || 0;
  const price = Number(btcPrice) || 0;
  const lev = isMargin
    ? MARGIN_FIXED_LEVERAGE
    : Math.max(1, Number(leverage) || 1);

  const notionalUsd = qty * price;
  if (!notionalUsd) {
    return { notionalUsd: 0, recommendedUsd: 0, minBalanceUsd: 0 };
  }

  // For margin mode the leveraged position value is notional × leverage.
  // We recommend having at least the full position value in the account so
  // the user can comfortably cover initial margin + maintenance + adverse
  // price swings across multiple cycles.
  //
  // For futures / non-margin, we keep the original rule:
  //   notional × max(1, 3/lev)
  const multiplier = isMargin
    ? lev                     // full position value (e.g. 10x → 10 × notional)
    : Math.max(1, 3 / lev);
  const recommendedUsd = notionalUsd * multiplier;

  // Round up to the nearest $10 for a clean display.
  const minBalanceUsd = Math.ceil(recommendedUsd / 10) * 10;
  return { notionalUsd, recommendedUsd, minBalanceUsd };
}

export { MARGIN_FIXED_LEVERAGE };
