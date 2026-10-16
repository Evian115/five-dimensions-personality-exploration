/** Chinese adaptations of @bigfive-org/results@1.2.9 domain/result/facet text.
 * English originals and MIT notice are retained in vendor/bigfive/results/.
 * 'medium' means the scale midpoint, never a norm-referenced population average.
 */
import type { Domain } from './data/questions.ts';
import type { Scores, Level } from './scoring.ts';

const summaries: Record<Domain, Record<Level, string>> = {
  O: { low: '你更倾向于具体、直观的思考方式，重视实际经验，对熟悉的事物和做法感到自在。', medium: '你的开放性处于量表中点：既欣赏熟悉的传统，也愿意在合适的时候尝试新事物。', high: '你喜欢新鲜、多样和变化，通常好奇、富有想象力，愿意探索新的想法与体验。' },
  C: { low: '你更重视当下的感受和灵活性，在计划、条理或坚持长期任务方面可能需要更多支持。', medium: '你的尽责性处于量表中点：能够保持一定的可靠性、条理性和自我约束，也会因情境调整。', high: '你倾向于设定清晰目标，并坚定地付诸行动，通常给人可靠、勤勉和自律的印象。' },
  E: { low: '你倾向于内敛、安静，享受独处或独自活动，社交往往集中在少数亲近的人身上。', medium: '你的外向性处于量表中点：既能享受与人相处，也需要独处的时间，不必总是热闹或安静。', high: '你倾向于善于交际、积极表达且精力充沛，通常愿意花较多时间与他人相处。' },
  A: { low: '你更倾向于优先考虑自己的需求，面对分歧时可能更直接、审慎或坚持立场。', medium: '你的宜人性处于量表中点：会关心他人的需要，也倾向于保留自己的边界，不轻易牺牲自身利益。', high: '你重视他人的需求与感受，通常待人友善、富有同情心，并愿意合作与提供帮助。' },
  N: { low: '你面对压力时通常比较平静、沉着，即使情境令人紧张，也较少出现强烈的情绪反应。', medium: '你的神经质处于量表中点：压力与挫折会引起不适，但通常也能逐步调节情绪并应对。', high: '你对压力和负面情绪比较敏感，日常要求也可能带来明显的不安或烦扰，需要留意自己的情绪负荷。' },
};
// [Chinese facet name, lower-end meaning, higher-end meaning], in upstream facet order.
const facets: Record<Domain, [string, string, string][]> = {
  O: [['想象力','更重视事实与现实','更常借助幻想和想象丰富内心体验'],['艺术兴趣','较少被艺术和美感吸引','更容易被艺术与美感打动'],['情感丰富性','较少关注自身情绪体验','更容易察觉并深入体验自身情绪'],['冒险性','偏好熟悉的环境与习惯','更愿意尝试新活动和不同体验'],['思辨兴趣','偏好具体直接的任务','喜欢抽象观念与智力挑战'],['观念开放性','更重视传统与既有规则','更愿意质疑权威和接纳新价值观']],
  C: [['自我效能感','较容易怀疑自身完成任务的能力','更相信自己能够解决问题和完成目标'],['条理性','更能接受随性与不规则的安排','更喜欢整洁、有序和事先计划'],['责任感','较少受规则与义务约束','更看重承诺、职责和规则'],['成就追求','更满足于适度的目标和投入','更有进取心并努力追求出色表现'],['自律性','较容易分心或拖延困难任务','更能坚持完成枯燥或困难的任务'],['审慎性','更倾向于即时决策和行动','更倾向于行动前充分思考后果']],
  E: [['友善性','较慢与人建立亲近关系','更容易表达亲近和积极感受'],['乐群性','更偏爱少量社交和独处','更享受人群与热闹聚会'],['自信表达','更愿意让他人主导局面','更愿意表达主张并影响群体'],['活跃度','更喜欢从容悠闲的节奏','更喜欢忙碌、快节奏的生活'],['刺激寻求','偏好安静稳定的体验','更渴望兴奋和较强刺激'],['积极情绪','较少表现出强烈的兴奋与热情','更容易体验快乐、热情和乐观']],
  A: [['信任','对他人的动机较谨慎或怀疑','更倾向于相信他人真诚可靠'],['坦诚','更倾向于保留或策略性表达','更倾向于直接、坦率地与人相处'],['利他','较少主动介入他人的困难','更愿意从帮助他人中获得满足'],['合作','更愿意竞争或坚持自身立场','更愿意妥协以减少冲突'],['谦逊','更愿意突出自身优势','更倾向于谦和低调'],['同情心','更侧重客观判断和实际原则','更容易被他人的处境和苦难触动']],
  N: [['焦虑','面对风险时较少紧张担忧','更容易担忧、紧张和感到威胁'],['愤怒','面对不顺时较少被激怒','更容易因挫折或不公而生气'],['低落倾向','较少陷入消沉和失落','更容易体验沮丧、失落等情绪'],['自我意识','较少担心他人的评价','更容易在意他人眼光并感到局促'],['冲动控制困难','更容易克制一时欲望','更难抵御当下的欲望与诱惑'],['压力脆弱性','压力下较能保持沉着','压力下更容易慌乱并感到难以应对']],
};
export interface FacetInterpretation { facet: number; title: string; score: number; rawScore: number; count: number; level: Level; text: string; }
export interface DomainInterpretation { text: string; facets: FacetInterpretation[]; }
export type Interpretations = Record<Domain, DomainInterpretation>;
export function buildInterpretations(scores: Scores, legacy = false): Interpretations {
  return Object.fromEntries((Object.keys(summaries) as Domain[]).map(domain => [domain, {
    text: legacy ? summaries[domain][scores[domain].level].replace('处于量表中点', '处于原 50 题版的中等区间') : summaries[domain][scores[domain].level],
    facets: (scores[domain].facets || []).map(f => {
      const [title, low, high] = facets[domain][f.facet - 1]!;
      const text = f.level === 'low' ? `你${low}。` : f.level === 'high' ? `你${high}。` : `这项倾向处于量表中点，${low}与${high}之间较为均衡。`;
      return { ...f, title, text };
    }),
  }])) as Interpretations;
}
