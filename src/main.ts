import { ASSESSMENT, QUESTIONS, isTestComplete, type Answers } from './index.ts';
import './style.css';
import { createSubmissionId } from './submission-id.ts';
import { restoreDraft, saveDraft, completeDraft, draftPage } from './assessment-draft.ts';
import { CURRENT_ASSESSMENT_ID, assessmentName, assessmentCount } from './assessment-versions.ts';
import type { SavedResult } from './result.ts';

const labels = ['非常不同意', '不同意', '中立', '同意', '非常同意'];
const domains = [
  { key: 'O', name: '开放性', en: 'Openness', description: '好奇心、想象力与接纳新体验的倾向。', color: '#8570b6' },
  { key: 'C', name: '尽责性', en: 'Conscientiousness', description: '做事有条理、可靠且自律的倾向。', color: '#cc806b' },
  { key: 'E', name: '外向性', en: 'Extraversion', description: '社交活力、主动表达与积极情绪的倾向。', color: '#e2ae53' },
  { key: 'A', name: '宜人性', en: 'Agreeableness', description: '合作、信任与体谅他人的倾向。', color: '#79a99b' },
  { key: 'N', name: '神经质', en: 'Neuroticism', description: '对压力和负面情绪的敏感程度。', color: '#7098c4' },
] as const;

const app = document.querySelector<HTMLDivElement>('#app')!;
const entryUrl = new URL(window.location.href);
const startNew = /^\/assessment\/?$/.test(entryUrl.pathname) && entryUrl.searchParams.get('start') === '1';
const draft = restoreDraft(localStorage, startNew);
if (startNew) {
  entryUrl.searchParams.delete('start');
  history.replaceState(null, '', entryUrl.pathname + entryUrl.search + entryUrl.hash);
}
let answers: Answers = draft.answers;
let submissionId = draft.submissionId;
let page = draftPage(answers);
let showingResult = false;
let savedResult: SavedResult | null = null;
let loadingResult = false;
let resultError = '';
let submitting = false;
let routeVersion = 0;
let transitioning = false;
const pageCount = QUESTIONS.length;

function save() { saveDraft(localStorage, { answers, submissionId }); }
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
function progress() { return Object.keys(answers).length; }

function render() {
  app.innerHTML = `
    <header class="topbar"><div class="brand"><a class="brand-home" href="/" aria-label="识己，回到首页"><img src="/assets/home/images/branding/favicon-96x96.png?v=copper-v2" width="30" height="30" alt="" /><span>识己</span></a><span class="brand-sub">/ 五维人格探索</span></div><span class="top-note">${assessmentName(savedResult?.assessmentId ?? ASSESSMENT.id)} · 免费自测</span></header>
    <main class="shell">
      <section class="hero"><div class="eyebrow">THE BIG FIVE PERSONALITY TEST</div><h1>了解自己，<em>从五个维度开始。</em></h1><p>回答 ${assessmentCount(savedResult?.assessmentId ?? ASSESSMENT.id)} 道简短的问题，探索你的大五人格特质。根据平时真实的自己作答，无需追求“正确”答案。</p></section>
      ${showingResult ? resultHtml() : questionHtml()}
      <footer>基于公开的 ${assessmentName(savedResult?.assessmentId ?? ASSESSMENT.id)} 题库 · 仅供自我了解与教育参考，不用于临床诊断。</footer>
    </main>`;
  bind();
}

function questionHtml() {
  const q = QUESTIONS[page]!;
  return `<section class="panel"><div class="section-head"><div><span class="eyebrow">YOUR RESPONSES</span><h2>请按直觉作答</h2></div><div class="counter"><strong>${progress()}</strong><span> / ${QUESTIONS.length} 已完成</span></div></div>
    <div class="progress-track"><div style="width:${progress() / QUESTIONS.length * 100}%"></div></div>
    <p class="hint">请根据平时的真实感受，选择这些描述与你的符合程度。</p>
    <div class="question single-question"><div class="question-title"><span class="number">第 ${q.id} 题 · 必答</span><strong id="question-title" tabindex="-1">${escapeHtml(q.text)}</strong></div><div class="options" role="radiogroup" aria-labelledby="question-title" aria-required="true">${labels.map((label, i) => `<label class="option ${answers[q.id] === i + 1 ? 'selected' : ''}"><input type="radio" required name="q${q.id}" value="${i + 1}" ${answers[q.id] === i + 1 ? 'checked' : ''}><span class="option-dot"></span><span>${label}</span></label>`).join('')}</div></div>
    <div class="actions"><button id="previous" class="button secondary" ${page === 0 ? 'disabled' : ''}>← 上一题</button><span class="page-indicator">${page + 1} / ${pageCount}</span><button id="next" class="button primary">${page === pageCount - 1 ? '查看结果' : '下一题'} <span>→</span></button></div>
    <p id="message" class="message" aria-live="polite"></p>
    <div class="dev-shortcut"><button id="skip-test" class="button secondary">跳过，查看随机结果 →</button></div></section>`;
}

async function navigate(update: () => void, direction: number) {
  if (transitioning) return;
  transitioning = true;
  const panel = app.querySelector<HTMLElement>('.panel')!;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const distance = reducedMotion ? 0 : 18 * direction;
  const stage = document.createElement('div');
  stage.className = 'panel-transition';
  panel.replaceWith(stage);
  stage.append(panel);
  let controls: (HTMLButtonElement | HTMLInputElement)[] = [];
  let disabledStates: boolean[] = [];
  try {
    update();
    panel.insertAdjacentHTML('afterend', showingResult ? resultHtml() : questionHtml());
    // Keep the outgoing panel visible while the incoming panel starts to appear.
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    const nextPanel = stage.lastElementChild as HTMLElement;
    bind();
    controls = Array.from(nextPanel.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input'));
    disabledStates = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    const focusTarget = nextPanel.querySelector<HTMLElement>('#question-title, h2');
    focusTarget?.setAttribute('tabindex', '-1');
    focusTarget?.focus({ preventScroll: true });
    await Promise.all([
      panel.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: `translateX(${-distance}px)` }], { duration: reducedMotion ? 0 : 180, easing: 'ease-in', fill: 'forwards' }).finished,
      nextPanel.animate([{ opacity: 0, transform: `translateX(${distance}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: reducedMotion ? 0 : 220, easing: 'ease-out' }).finished,
    ]);
  } finally {
    panel.remove();
    stage.replaceWith(...Array.from(stage.childNodes));
    controls.forEach((control, index) => { control.disabled = disabledStates[index]!; });
    transitioning = false;
  }
}

function resultHtml() {
  if (loadingResult) return '<section class="panel" aria-live="polite"><h2>正在读取测试结果…</h2></section>';
  if (!savedResult) return `<section class="panel"><h2>暂时无法读取结果</h2><p class="hint" role="alert">${escapeHtml(resultError)}</p><div class="result-actions"><button id="retry-result" class="button secondary">重试</button><button id="new-test" class="button primary">开始测试</button></div></section>`;
  const scores = savedResult.scores;
  const level = { low: '偏低', medium: '中等', high: '偏高' };
  return `<section class="panel results"><div class="section-head"><div><span class="eyebrow">YOUR PERSONALITY PROFILE</span><h2>你的五维画像</h2></div><div class="result-seal">✳</div></div><p class="hint">分数表示你在各维度上的相对倾向。高低本身没有好坏之分。</p>
    ${savedResult.assessmentId === CURRENT_ASSESSMENT_ID ? '<p class="hint">60 题探索版，每个细分维度仅含 2 题；细分结果仅供探索参考，尚未完成独立的信效度验证。</p>' : ''}
    <figure class="profile-chart" aria-label="五维分数柱状图，满分 100 分">
      <div class="chart-axis" aria-hidden="true"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
      <div class="chart-plot"><ul class="chart-columns">${domains.map(d => `<li class="chart-column" aria-label="${d.name}：${scores[d.key].score} 分，满分 100 分"><div class="chart-bar-space"><div class="chart-bar" style="height:${scores[d.key].score}%;--bar-color:${d.color}"><span class="chart-value" aria-hidden="true">${scores[d.key].score}</span></div></div><span class="chart-label" aria-hidden="true">${d.name}</span></li>`).join('')}</ul></div>
    </figure>
    <div class="score-list">${domains.map(d => { const score = scores[d.key].score; const explanation = savedResult!.interpretations?.[d.key]; return `<div class="score-row"><div class="score-heading"><div><span class="domain-dot" style="background:${d.color}"></span><strong>${d.name}</strong><span class="domain-en">${d.en}</span></div><span class="score-number">${score}<small>/100</small></span></div><div class="score-track"><div style="width:${score}%;background:${d.color}"></div></div><p>${escapeHtml(explanation?.text || d.description)} <span>当前水平：${level[scores[d.key].level]}</span>${(explanation?.facets || []).map(f => `<br>${escapeHtml(f.title)}：${f.score}/100（${level[f.level]}）。${escapeHtml(f.text)}`).join('')}</p></div>`; }).join('')}</div>
    <div class="result-actions"><button id="reset" class="button secondary">重新测试</button><button id="share" class="button primary">分享 ↗</button></div></section>`;
}

async function readJson(response: Response): Promise<SavedResult> {
  let value;
  try { value = await response.json(); }
  catch { throw new Error('服务返回的数据格式不正确，请刷新页面后重试。'); }
  if (!response.ok) throw new Error(value.error || '操作失败，请稍后重试。');
  return value as SavedResult;
}

async function loadRoute() {
  const version = ++routeVersion;
  const match = /^\/results\/([^/]+)\/?$/.exec(window.location.pathname);
  showingResult = Boolean(match);
  savedResult = null;
  resultError = '';
  loadingResult = Boolean(match);
  render();
  if (!match) return;
  try {
    if (match[1] === 'view') {
      const token = window.location.hash.slice(1);
      const result = await readJson(await fetch(`/api/results/decode?token=${encodeURIComponent(token)}`, {
        cache: 'no-store',
      }));
      if (version !== routeVersion) return;
      savedResult = result;
      history.replaceState(null, '', result.relativePath);
      loadingResult = false;
      render();
      return;
    }
    const result = await readJson(await fetch(`/api/results/${encodeURIComponent(match[1]!)}`));
    if (version !== routeVersion) return;
    savedResult = result;
    history.replaceState(null, '', result.relativePath);
  } catch (error) {
    if (version !== routeVersion) return;
    resultError = error instanceof Error ? error.message : '读取结果失败，请稍后重试。';
  }
  loadingResult = false;
  render();
}

async function submitResult() {
  if (submitting) return;
  submitting = true;
  const next = document.querySelector<HTMLButtonElement>('#next')!;
  const previous = document.querySelector<HTMLButtonElement>('#previous')!;
  next.disabled = previous.disabled = true;
  const skip = document.querySelector<HTMLButtonElement>('#skip-test');
  if (skip) skip.disabled = true;
  document.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(input => { input.disabled = true; });
  next.textContent = '正在保存…';
  document.querySelector('#message')!.textContent = '';
  const submittedId = submissionId;
  let result: SavedResult;
  try {
    // Persist the request identity before sending, including for restored complete drafts.
    save();
    result = await readJson(await fetch('/api/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submissionId: submittedId, answers, assessmentId: ASSESSMENT.id }),
    }));
  } catch (error) {
    document.querySelector('#message')!.textContent = error instanceof Error ? error.message : '保存失败，请重试。';
    next.disabled = false;
    previous.disabled = page === 0;
    if (skip) skip.disabled = false;
    document.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(input => { input.disabled = false; });
    next.textContent = '重新提交 →';
    submitting = false;
    return;
  }
  savedResult = result;
  completeDraft(localStorage, submittedId);
  answers = {};
  page = 0;
  submissionId = createSubmissionId();
  history.pushState(null, '', result.relativePath);
  try {
    await navigate(() => { showingResult = true; }, 1);
  } catch {
    // A display/animation failure after a successful write must not offer another submission.
    showingResult = true;
    render();
  } finally { submitting = false; }
}

function showShareDialog() {
  if (!savedResult || document.querySelector('#share-dialog')) return;
  const url = new URL(savedResult.shareUrl, window.location.origin).href;
  const trigger = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.id = 'share-dialog';
  dialog.className = 'confirm-dialog';
  dialog.setAttribute('aria-labelledby', 'share-title');
  dialog.innerHTML = `<span class="dialog-mark" aria-hidden="true">↗</span><p class="eyebrow">SHARE YOUR PROFILE</p><h2 id="share-title">分享这份五维画像</h2><p class="hint">复制分享链接，打开即可查看本次测试结果。</p><label class="share-label" for="share-url">结果摘要</label><input id="share-url" class="share-input" readonly value="${domains.map(d => `${d.name} ${savedResult!.scores[d.key].score}`).join(' · ')}"><p id="copy-status" class="copy-status" aria-live="polite"></p><div class="dialog-actions"><button id="close-share" class="button secondary">关闭</button><button id="copy-share" class="button primary">复制链接 ↗</button></div>`;
  dialog.querySelector('#close-share')!.addEventListener('click', () => dialog.close());
  dialog.querySelector<HTMLInputElement>('#share-url')!.addEventListener('click', event => (event.target as HTMLInputElement).select());
  function copyWithSelection() {
    // Keep the temporary field inside the modal so it can receive focus on HTTP.
    const field = document.createElement('textarea');
    field.value = url;
    field.readOnly = true;
    field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
    const focused = document.activeElement as HTMLElement | null;
    dialog.append(field);
    try {
      field.select();
      field.setSelectionRange(0, field.value.length);
      if (!document.execCommand('copy')) throw new Error('Copy failed');
    } finally {
      field.remove();
      focused?.focus({ preventScroll: true });
    }
  }
  dialog.querySelector('#copy-share')!.addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(url); }
        catch { copyWithSelection(); }
      } else {
        copyWithSelection();
      }
      dialog.querySelector('#copy-status')!.textContent = '链接已复制，可以发给朋友了。';
    } catch {
      dialog.querySelector('#copy-status')!.textContent = '复制失败，请检查浏览器剪贴板权限后重试。';
    }
  });
  dialog.addEventListener('click', event => {
    const bounds = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => { dialog.remove(); trigger?.focus({ preventScroll: true }); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function showResetDialog() {
  if (document.querySelector('#reset-dialog')) return;
  const trigger = document.activeElement as HTMLElement | null;
  const dialog = document.createElement('dialog');
  dialog.id = 'reset-dialog';
  dialog.className = 'confirm-dialog';
  dialog.setAttribute('aria-labelledby', 'reset-title');
  dialog.setAttribute('aria-describedby', 'reset-description');
  dialog.innerHTML = `
    <form method="dialog">
      <span class="dialog-mark" aria-hidden="true">✳</span>
      <p class="eyebrow">A FRESH START</p>
      <h2 id="reset-title">准备重新认识自己？</h2>
      <p id="reset-description">重新测试将从第一题开始。已提交的结果和分享链接仍会保留。</p>
      <div class="dialog-actions">
        <button class="button secondary" value="cancel" autofocus>取消</button>
        <button class="button primary" value="confirm">确认重新测试</button>
      </div>
    </form>`;
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close('cancel');
  });
  dialog.addEventListener('close', () => {
    const confirmed = dialog.returnValue === 'confirm';
    dialog.remove();
    if (confirmed) {
      answers = {};
      submissionId = createSubmissionId();
      savedResult = null;
      history.pushState(null, '', '/assessment');
      save();
      showingResult = false;
      page = 0;
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      document.querySelector<HTMLElement>('#question-title')?.focus({ preventScroll: true });
    } else {
      trigger?.focus({ preventScroll: true });
    }
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

function bind() {
  const root = app.querySelector<HTMLElement>('.panel-transition > .panel:last-child') ?? app;
  if (showingResult) {
    root.querySelector('#reset')?.addEventListener('click', showResetDialog);
    root.querySelector('#share')?.addEventListener('click', showShareDialog);
    root.querySelector('#retry-result')?.addEventListener('click', () => { void loadRoute(); });
    root.querySelector('#new-test')?.addEventListener('click', () => { history.pushState(null, '', '/assessment'); void loadRoute(); });
    return;
  }
  {
    root.querySelector('#skip-test')?.addEventListener('click', () => {
      if (submitting || transitioning) return;
      answers = Object.fromEntries(QUESTIONS.map(q => [q.id, Math.floor(Math.random() * 5) + 1])) as Answers;
      submissionId = createSubmissionId();
      page = pageCount - 1;
      save();
      render();
      void submitResult();
    });
  }
  root.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach(input => input.addEventListener('change', () => {
    submissionId = createSubmissionId();
    answers[Number(input.name.slice(1))] = Number(input.value) as 1 | 2 | 3 | 4 | 5;
    save();
    root.querySelectorAll('.option').forEach(option => option.classList.toggle('selected', option.contains(input)));
    const next = root.querySelector<HTMLButtonElement>('#next')!;
    next.disabled = false;
    root.querySelector('#message')!.textContent = '';
    root.querySelector('.counter strong')!.textContent = String(progress());
    root.querySelector<HTMLElement>('.progress-track div')!.style.width = `${progress() / QUESTIONS.length * 100}%`;
  }));
  root.querySelector('#previous')?.addEventListener('click', () => { if (page > 0) void navigate(() => { page--; }, -1); });
  root.querySelector('#next')?.addEventListener('click', () => {
    if (answers[QUESTIONS[page]!.id] === undefined) {
      root.querySelector('#message')!.textContent = '请选择一个答案后继续。';
      return;
    }
    if (page < pageCount - 1) { void navigate(() => { page++; }, 1); }
    else if (isTestComplete(answers)) { void submitResult(); }
    else { void navigate(() => { page = QUESTIONS.findIndex(q => answers[q.id] === undefined); }, -1); }
  });
}

window.addEventListener('hashchange', () => { void loadRoute(); });
window.addEventListener('popstate', () => { void loadRoute(); });
void loadRoute();
