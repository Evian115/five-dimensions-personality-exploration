import type { Scores } from './scoring.ts';
import type { Interpretations } from './interpretations.ts';

export interface SavedResult {
  id: string;
  scores: Scores;
  assessmentId: string;
  interpretations: Interpretations;
  relativePath: string;
  shareUrl: string;
}
