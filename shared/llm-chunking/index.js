/**
 * ============================================================
 * shared/llm-chunking — Découpage intelligent de blocs pour LLM
 * ------------------------------------------------------------
 * Évite la troncature quand la réponse JSON dépasse max_tokens.
 *
 * Principe :
 *  - On estime le nombre de tokens par bloc (~4 chars = 1 token).
 *  - On regroupe les blocs en batches de taille sûre (ex: 6000 tokens).
 *  - Chaque batch est envoyé au LLM séparément.
 *  - On concatène les sorties.
 *
 * Usage :
 *   import { chunkBlocks, estimateTokens } from '@docforge/shared/llm-chunking';
 *   const batches = chunkBlocks(blocks, { maxTokensPerBatch: 6000 });
 *   for (const batch of batches) { ... }
 * ============================================================
 */

/**
 * Estime le nombre de tokens d'une chaîne (approximation).
 * 1 token ≈ 4 caractères en français.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

/**
 * Estime le nombre de tokens d'un bloc (content + rows).
 */
export function estimateBlockTokens(block) {
  let total = estimateTokens(block.content || '');
  if (Array.isArray(block.rows)) {
    for (const row of block.rows) {
      for (const cell of row) {
        total += estimateTokens(String(cell));
      }
    }
  }
  // Overhead JSON (clés, guillemets, virgules)
  total += 10;
  return total;
}

/**
 * Découpe un tableau de blocs en batches dont la somme des tokens
 * ne dépasse pas `maxTokensPerBatch`.
 *
 * @param {Array} blocks
 * @param {Object} opts
 * @param {number} opts.maxTokensPerBatch - Limite de tokens par batch (défaut: 6000)
 * @param {number} opts.overheadTokens - Marge pour prompt système + overhead (défaut: 500)
 * @returns {Array<Array>} - Batches de blocs
 */
export function chunkBlocks(blocks, opts = {}) {
  const maxTokensPerBatch = opts.maxTokensPerBatch ?? 6000;
  const overheadTokens = opts.overheadTokens ?? 500;
  const safeLimit = maxTokensPerBatch - overheadTokens;

  if (!Array.isArray(blocks) || blocks.length === 0) return [[]];

  const batches = [];
  let currentBatch = [];
  let currentTokens = 0;

  for (const block of blocks) {
    const blockTokens = estimateBlockTokens(block);

    // Bloc seul trop gros ? On le garde quand même (LLM le tronquera si besoin)
    if (blockTokens > safeLimit) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push([block]);
      continue;
    }

    // Ajouter au batch si ça rentre
    if (currentTokens + blockTokens <= safeLimit) {
      currentBatch.push(block);
      currentTokens += blockTokens;
    } else {
      // Batch plein → on le ferme et on commence un nouveau
      if (currentBatch.length > 0) batches.push(currentBatch);
      currentBatch = [block];
      currentTokens = blockTokens;
    }
  }

  if (currentBatch.length > 0) batches.push(currentBatch);

  return batches.length > 0 ? batches : [[]];
}