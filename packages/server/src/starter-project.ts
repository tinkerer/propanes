/** The starter is deliberately small: edit main.js and Vite reloads the preview. */
export function starterProject(name: string, projectName: string, serverUrl: string, apiKey: string, port: number) {
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const widget = `<script src="${escape(serverUrl)}/widget/propanes.js" data-endpoint="${escape(serverUrl)}/api/v1/feedback" data-app-key="${escape(apiKey)}" data-mode="always"></script>`;
  return {
    'package.json': JSON.stringify({ name: projectName.toLowerCase(), version: '0.0.1', private: true, type: 'module', scripts: { dev: `vite --host 127.0.0.1 --port ${port} --strictPort`, start: 'npm run dev', build: 'vite build', preview: `vite preview --host 127.0.0.1 --port ${port} --strictPort` }, devDependencies: { vite: '^6.4.1' } }, null, 2) + '\n',
    'index.html': `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escape(name)}</title></head>
<body><main>
  <div class="eyebrow">YOUR FIRST PROPANES APP</div>
  <h1>Hello World<span>.</span></h1>
  <p class="intro">One small app. Your next big idea.</p>
  <section><h2>Make your first change</h2><p>Edit <code>main.js</code> and save. This page updates automatically.</p><button id="hello">Say hello</button><p id="message" aria-live="polite">Ready when you are.</p></section>
  <section><h2>Build with a prompt</h2><p>Open the ProPanes prompt widget in the corner. Describe one change, send it to your agent, and watch your app evolve.</p><blockquote>Change the heading to “My first app” and add a click counter. Keep hot reload and the ProPanes widget working.</blockquote></section>
  <a href="${escape(serverUrl)}/admin/#/settings/getting-started" target="_blank" rel="noopener">Continue the guide →</a>
</main><script type="module" src="/main.js"></script>${widget}</body></html>\n`,
    'main.js': `import './style.css';\nlet clicks = 0;\ndocument.querySelector('#hello').addEventListener('click', () => {\n  document.querySelector('#message').textContent = 'Hello! You clicked ' + (++clicks) + (clicks === 1 ? ' time.' : ' times.');\n});\n`,
    'style.css': `:root { font-family: system-ui, sans-serif; color: #e2e8f0; background: #0f172a; color-scheme: dark; }\n* { box-sizing: border-box; }\nbody { margin: 0; }\nmain { max-width: 800px; margin: 0 auto; padding: 64px 24px 120px; }\n.eyebrow { color: #fb923c; font-size: 12px; font-weight: 700; letter-spacing: .14em; }\nh1 { font-size: clamp(40px, 8vw, 72px); letter-spacing: -.05em; margin: 16px 0; }\nh1 span { color: #1d9bf0; }\n.intro { font-size: 22px; color: #94a3b8; margin-bottom: 40px; }\nsection { padding: 24px; margin: 16px 0; border: 1px solid #334155; border-radius: 16px; background: #1e293b; }\nh2 { font-size: 18px; margin-top: 0; }\np, blockquote { line-height: 1.7; }\nblockquote { margin: 16px 0 0; padding-left: 16px; border-left: 2px solid #1d9bf0; color: #cbd5e1; }\nbutton { border: 0; border-radius: 8px; background: #1d9bf0; color: #020617; font: inherit; font-weight: 600; padding: 12px 20px; cursor: pointer; }\na { color: #60a5fa; display: inline-block; margin-top: 16px; }\ncode { color: #fcd34d; }\nbutton:focus-visible, a:focus-visible { outline: 2px solid #fcd34d; outline-offset: 4px; }\n`,
    '.gitignore': 'node_modules/\ndist/\n',
    'README.md': `# ${name}\n\n## Run locally\n\nRequires Node.js 18+ and npm.\n\n\`\`\`sh\nnpm install\nnpm run dev\n\`\`\`\n\nOpen http://localhost:${port}. Edit main.js, style.css, or index.html and save to see changes immediately. Keep the terminal running. If the port is occupied, stop that server or change the port in package.json and the app URL in ProPanes settings.\n\nThe ProPanes widget is already installed and linked to this application. Open it to send a prompt; select an agent with a working CLI login on the server machine. Review its work in ProPanes and check the preview after each change.\n\n## Try a 3D STEP viewer\n\nBuild in small steps: a Three.js scene with orbit controls; real STEP import using occt-import-js in a worker; then file validation, fit-to-model, reset view, and a parts list. Keep the widget and hot reload working. Test with a real .step file after adding the importer.\n`,
  };
}
