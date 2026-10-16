# Upstream sources and MIT notices

This integration uses the exact package versions declared by rubynor/bigfive-web's `web/package.json`:

| Component | Version | Local use |
| --- | --- | --- |
| `@bigfive-org/questions` | 1.3.3 | Johnson IPIP-NEO-120 questions with locally corrected Chinese translations, item UUIDs, domain, facet, and keying in `src/data/ipip120.json` |
| `@bigfive-org/score` | 1.2.2 | Pure TypeScript adapter in `src/scoring.ts`; pinned CommonJS reducer retained in `score/` for parity tests |
| `@bigfive-org/results` | 1.2.9 | Original English result template retained in `results/en.json`; Chinese domain/result and facet adaptations in `src/interpretations.ts` |

Sources: <https://github.com/rubynor/bigfive-web>, <https://registry.npmjs.org/@bigfive-org/questions>, <https://registry.npmjs.org/@bigfive-org/score>, <https://registry.npmjs.org/@bigfive-org/results>.

The results package is the report component currently used by bigfive-web, rather than directly installing the older `@alheimsins/b5-result-text` API. Each directory retains the package's MIT LICENSE and copyright notice (B5 Holding AS, 2024). The Chinese report is a local adaptation; it is not claimed to be an upstream Chinese translation or a norm-validated interpretation.

Scoring: convert reverse-keyed raw selections with `6 - value`, sum the selected items (12 per domain and 2 per facet in the current exploratory subset; 24 and 4 in the original 120-item inventory), then classify the **unrounded mean** below/equal/above 3 as low/neutral/high. Locally `neutral` is named `medium` for compatibility with the existing UI. Display scores are `round((mean - 1) / 4 * 100)` and are **not population percentiles**. No 24-character archetype classifier is included.

The current inventory is the locally selected 60-item exploratory subset `shiji-ipip60-exploratory-zh-v1`, with item choices and limitations documented in `docs/ipip60-selection.md`. It is not the published Maples-Keller IPIP-NEO-60. Original 120-item source material remains for provenance and regression tests.

Legacy IPIP-50 results keep their saved raw score, normalized score and level, without inferred facet scores. Historic 120-item results retain `johnson-120-ipip-neo-pi-r-zh-v2` or `johnson-120-ipip-neo-pi-r`. Result links are decoded by the server using their stored format version. The database records submissions with an autoincrement ID, result JSON, result link, created time and updated time; it does not retain answer-by-answer data or interpretation snapshots.

Chinese item wording was reviewed against the pinned English inventory in `questions/en.json`. Only `text` was adapted; source UUID, English wording, domain, facet and keying are unchanged. This local translation has not been independently validated in a Chinese sample.
