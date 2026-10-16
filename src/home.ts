import './home.css';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const header = document.querySelector<HTMLElement>('[data-home-header]');
function updateHeader() { header?.classList.toggle('is-scrolled', window.scrollY > 16); }
updateHeader();
window.addEventListener('scroll', updateHeader, { passive: true });
window.addEventListener('pageshow', () => {
  updateHeader();
  document.body.classList.remove('is-leaving');
  document.querySelectorAll('[aria-busy]').forEach(element => element.removeAttribute('aria-busy'));
});

// Only animate elements entering the viewport, once, with a small fade and vertical offset.
if (!reducedMotion.matches && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('motion-ready');
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  document.querySelectorAll('[data-reveal]').forEach(element => observer.observe(element));
}

const dimensionDetails: Record<string, { color: string; title: string; description: string }> = {
  O: { color: '#8570b6', title: '关于好奇心，也关于想象力。', description: '你如何看待陌生的事物，又是否享受新想法带来的可能？这个维度观察你对新体验的开放程度。' },
  C: { color: '#cc806b', title: '关于做事的节奏，也关于自我要求。', description: '你更喜欢提前安排，还是随情境灵活应对？这个维度观察你的条理性、责任感和自律倾向。' },
  E: { color: '#d5a34a', title: '关于社交，也关于你的能量来源。', description: '热闹的相聚让你更有活力，还是独处更让你自在？这个维度观察你在互动和表达中的倾向。' },
  A: { color: '#79a99b', title: '关于靠近他人，也关于相处的方式。', description: '你如何理解别人的感受，又如何对待彼此的差异？这个维度观察你的信任、合作和体谅倾向。' },
  N: { color: '#7098c4', title: '关于情绪的起伏，也关于感受的深浅。', description: '面对压力时，你通常平静应对，还是更容易感到紧张？这个维度观察你对压力和负面情绪的敏感程度。' },
};
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-dimension]'));
const panel = document.querySelector<HTMLElement>('#dimension-detail')!;
let detailAnimation: Animation | undefined;
function selectDimension(tab: HTMLButtonElement) {
  const detail = dimensionDetails[tab.dataset.dimension!];
  if (!detail || tab.getAttribute('aria-selected') === 'true') return;
  for (const candidate of tabs) {
    const selected = candidate === tab;
    candidate.setAttribute('aria-selected', String(selected));
    candidate.tabIndex = selected ? 0 : -1;
  }
  panel.setAttribute('aria-labelledby', tab.id);
  panel.style.setProperty('--dimension-color', detail.color);
  panel.querySelector('.detail-label')!.textContent = detail.title;
  panel.querySelector('.detail-description')!.textContent = detail.description;
  detailAnimation?.cancel();
  if (!reducedMotion.matches) {
    detailAnimation = panel.animate([{ opacity: .25, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 200, easing: 'ease-out' });
  }
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectDimension(tab));
  tab.addEventListener('keydown', event => {
    let next: number;
    switch (event.key) {
      case 'ArrowDown': case 'ArrowRight': next = (index + 1) % tabs.length; break;
      case 'ArrowUp': case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break;
      case 'Home': next = 0; break;
      case 'End': next = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const target = tabs[next]!;
    target.focus({ preventScroll: true });
    selectDimension(target);
  });
}


// Preserve ordinary new-tab and keyboard link behavior; fade only a normal same-tab start.
let leaving = false;
document.querySelectorAll<HTMLAnchorElement>('[data-start-test]').forEach(link => {
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || reducedMotion.matches) return;
    event.preventDefault();
    if (leaving) return;
    leaving = true;
    link.setAttribute('aria-busy', 'true');
    document.body.classList.add('is-leaving');
    window.setTimeout(() => window.location.assign(link.href), 140);
  });
});
window.addEventListener('pageshow', () => { leaving = false; });
