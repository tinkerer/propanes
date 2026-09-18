import { test } from 'node:test';
import assert from 'node:assert/strict';
import { starterProject } from '../src/starter-project.js';

test('starter connects the real widget and uses the selected port without silently moving it', () => {
  const files = starterProject('Hello', 'hello-world', 'http://localhost:3101', 'pw_example', 5178);
  const pkg = JSON.parse(files['package.json']);
  assert.match(pkg.scripts.dev, /--port 5178 --strictPort/);
  assert.ok(pkg.devDependencies.vite);
  assert.match(files['index.html'], /src="http:\/\/localhost:3101\/widget\/propanes.js"/);
  assert.match(files['index.html'], /data-endpoint="http:\/\/localhost:3101\/api\/v1\/feedback"/);
  assert.match(files['index.html'], /data-app-key="pw_example"/);
  assert.match(files['index.html'], /type="module" src="\/main.js"/);
  assert.match(files['main.js'], /import '\.\/style.css'/);
});

test('starter escapes user-controlled text and widget attributes', () => {
  const files = starterProject('<script>alert("test")</script>', 'hello-world', 'https://example.com/"x', 'pw_"x', 5173);
  assert.ok(!files['index.html'].includes('<script>alert'));
  assert.match(files['index.html'], /&lt;script&gt;alert\(&quot;test&quot;\)&lt;\/script&gt;/);
  assert.match(files['index.html'], /data-app-key="pw_&quot;x"/);
});
