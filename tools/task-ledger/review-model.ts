export type ReviewModel = 'sonnet' | 'gpt-6.1-terra';
export type ReviewChoiceInput = { claudeRemaining: number | null; codexRemaining: number | null };
export type ReviewChoice = { model: ReviewModel; reason: string; claudeRemaining: number | null; codexRemaining: number | null };

/** Choose deterministically; unknown quota is ignored and Claude wins ties/fallback. */
export function chooseReviewModel(input: ReviewChoiceInput): ReviewChoice {
  const claude = Number.isFinite(input.claudeRemaining) ? input.claudeRemaining : null;
  const codex = Number.isFinite(input.codexRemaining) ? input.codexRemaining : null;
  if (claude === null && codex === null) return { model: 'sonnet', reason: '両方の残量を読めないため既定の sonnet', claudeRemaining: null, codexRemaining: null };
  if (codex === null) return { model: 'sonnet', reason: 'Codex の週枠が読めないため読めた Claude を選択', claudeRemaining: claude, codexRemaining: null };
  if (claude === null) return { model: 'gpt-6.1-terra', reason: 'Claude の残量が読めないため読めた Codex 週枠を選択', claudeRemaining: null, codexRemaining: codex };
  return codex > claude
    ? { model: 'gpt-6.1-terra', reason: `Codex の残量 ${codex} が Claude ${claude} より多い`, claudeRemaining: claude, codexRemaining: codex }
    : { model: 'sonnet', reason: `Claude の残量 ${claude} が Codex ${codex} 以上`, claudeRemaining: claude, codexRemaining: codex };
}
