// IDs and binary version order are immutable: old shared links depend on them.
export const CURRENT_ASSESSMENT_ID = 'shiji-ipip60-exploratory-zh-v1';
export const RESULT_VERSIONS = [
  'johnson-120-ipip-neo-pi-r-zh-v2',
  'johnson-120-ipip-neo-pi-r',
  'ipip-50-v1',
  CURRENT_ASSESSMENT_ID,
] as const;
export function assessmentName(id: string) {
  if (id === CURRENT_ASSESSMENT_ID) return 'IPIP 60题探索版';
  return id === 'ipip-50-v1' ? 'IPIP-50' : 'IPIP-NEO-120';
}
export function assessmentCount(id: string) {
  return id === CURRENT_ASSESSMENT_ID ? 60 : id === 'ipip-50-v1' ? 50 : 120;
}
