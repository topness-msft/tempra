import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');

if (app) {
  app.innerHTML = `
    <main class="boot">
      <p class="mark">Tempra</p>
      <p class="tag">A quiet record of how you feel.</p>
      <p class="status" id="status">checking&hellip;</p>
    </main>
  `;
}

const status = document.querySelector<HTMLElement>('#status');

fetch('/health')
  .then((r) => r.json())
  .then((h: { commit?: string }) => {
    if (status) status.textContent = `server ok · ${h.commit ?? 'dev'}`;
  })
  .catch(() => {
    if (status) status.textContent = 'offline';
  });
