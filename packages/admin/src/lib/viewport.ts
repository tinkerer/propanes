import { signal, effect } from '@preact/signals';

const MOBILE_QUERY = '(max-width: 768px)';

const mq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia(MOBILE_QUERY)
  : null;

export const isMobile = signal(mq ? mq.matches : false);

if (mq) {
  const onChange = (e: MediaQueryListEvent) => { isMobile.value = e.matches; };
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', onChange);
  } else if (typeof (mq as any).addListener === 'function') {
    (mq as any).addListener(onChange);
  }
}

effect(() => {
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('pw-mobile', isMobile.value);
});
