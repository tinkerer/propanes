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

// iOS Safari keyboard handling: the on-screen keyboard shrinks the *visual*
// viewport but leaves the layout viewport unchanged, so `position: fixed;
// bottom: N` elements (like the CoS popout) get covered by the keyboard.
// Track visualViewport and expose the keyboard height as --pw-keyboard-inset
// so docked panels can lift above the keyboard when an input is focused.
if (typeof window !== 'undefined' && window.visualViewport && typeof document !== 'undefined') {
  const vv = window.visualViewport;
  const update = () => {
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--pw-keyboard-inset', `${Math.round(inset)}px`);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
