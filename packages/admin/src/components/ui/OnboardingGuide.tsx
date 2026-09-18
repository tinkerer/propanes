import { useState } from 'preact/hooks';
import { addAppModalOpen, applications, selectedAppId, navigate } from '../../lib/state.js';
import { copyText } from '../../lib/clipboard.js';

const lessons = [
  { title: 'Make your first change', prompt: 'Change the heading to “My first app” and add a click counter. Keep Vite hot reload and the ProPanes widget working.', check: 'Click the button twice, then edit the heading and save. The preview should update without a manual refresh.' },
  { title: 'Add a 3D scene', prompt: 'Turn this app into a 3D viewer using Three.js. Start with a demo box, orbit controls, a responsive canvas, and a Reset view button. Use a slate, blue, and orange palette. Keep the ProPanes widget and Vite hot reload. Do not add STEP import yet.', check: 'Drag to orbit, scroll to zoom, resize the window, and reset the camera. Confirm the widget still opens over the canvas.' },
  { title: 'Open a real STEP file', prompt: 'Add real .step and .stp file import using occt-import-js. Load its WASM locally and parse in a Web Worker so the UI stays responsive. Convert the returned meshes to Three.js geometry, fit the camera to the model, and show loading and error states. Include a small real STEP sample with its source and license. Do not substitute a demo shape for an imported file. Preserve the widget and hot reload.', check: 'Load the sample, then your own STEP file. Confirm the geometry changes and an invalid file shows a useful error.' },
  { title: 'Make it useful', prompt: 'Improve the STEP viewer with drag-and-drop, a parts list with visibility controls, model bounds labeled with their units, fit-to-model, and reset view. Dispose replaced geometries and materials. Reject unsupported or oversized files with clear messages, preserve the current model on failure, and handle worker errors. Keep the widget usable on desktop and mobile.', check: 'Hide a part, reset the view, drop an invalid file, and load a second model. Verify the old model is replaced cleanly.' },
];

export function OnboardingGuide() {
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const app = applications.value.find(a => a.id === selectedAppId.value);
  const lesson = lessons[step];
  const preview = app?.serverUrl && /^https?:\/\//.test(app.serverUrl) ? app.serverUrl : null;
  return <section class="onboarding-guide">
    <div class="onboarding-eyebrow">BUILD YOUR FIRST APP</div>
    <h1>Small start. Real possibilities.</h1>
    <p class="onboarding-intro">Go from Hello World to a working app, one prompt at a time.</p>
    <div class="onboarding-steps">
      <article><span class="onboarding-number">01</span><h3>Create</h3><p>Start with Hello World. Hot reload and the prompt widget are included.</p><button class="btn btn-primary" onClick={() => { addAppModalOpen.value = true; }}>Create an app</button></article>
      <article><span class="onboarding-number">02</span><h3>Run & preview</h3><p>Use <strong>Start dev server</strong> in your app controls. Keep the terminal open and wait for Vite to say “ready”.</p>{preview ? <a class="btn" href={preview} target="_blank" rel="noopener">Open {app.name} ↗</a> : <span class="onboarding-muted">Create or select an app to open its preview.</span>}</article>
      <article><span class="onboarding-number">03</span><h3>Prompt & improve</h3><p>Open the widget in your app. Choose an agent, describe one change, then review its work in the preview.</p><button class="btn" onClick={() => navigate('/settings/agents')}>Set up an agent</button></article>
    </div>
    <p class="onboarding-note">Before your first prompt: configure an agent in Settings → Agents and sign in to its CLI on the machine running ProPanes. Creating and editing the starter manually does not require an agent.</p>
    <div class="onboarding-lesson">
      <div class="onboarding-eyebrow">TRY IT · HELLO WORLD → 3D STEP VIEWER</div>
      <h2>Build in small, testable steps</h2>
      <p class="onboarding-muted">Send one prompt from your app’s widget. Wait for the agent to finish and check the result before moving on.</p>
      <div class="onboarding-tabs" role="tablist" aria-label="Tutorial steps">
        {lessons.map((item, index) => <button key={item.title} id={'lesson-tab-' + index} role="tab" tabIndex={step === index ? 0 : -1} aria-selected={step === index} aria-controls="lesson-content" class={step === index ? 'active' : ''} onClick={() => { setStep(index); setCopied(false); }} onKeyDown={e => {
          const next = e.key === 'ArrowRight' ? (index + 1) % lessons.length : e.key === 'ArrowLeft' ? (index + lessons.length - 1) % lessons.length : e.key === 'Home' ? 0 : e.key === 'End' ? lessons.length - 1 : null;
          if (next === null) return;
          e.preventDefault(); setStep(next); setCopied(false);
          (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
        }}>{index + 1}. {item.title}</button>)}
      </div>
      <div id="lesson-content" role="tabpanel" aria-labelledby={'lesson-tab-' + step}>
        <div class="onboarding-prompt">{lesson.prompt}</div>
        <button class="btn btn-primary" onClick={() => { copyText(lesson.prompt); setCopied(true); }}>{copied ? 'Copied — paste into your app widget' : 'Copy prompt'}</button>
        <p class="onboarding-check"><strong>Check before continuing</strong><br />{lesson.check}</p>
      </div>
    </div>
  </section>;
}
