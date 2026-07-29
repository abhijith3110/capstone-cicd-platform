const API_BASE = window.__ENV__ && window.__ENV__.API_BASE_URL ? window.__ENV__.API_BASE_URL : '/api';

fetch(`${API_BASE}/version`)
  .then((r) => r.json())
  .then((data) => {
    document.getElementById('version-box').innerText =
      `Version: ${data.version} | Build: ${data.buildNumber} | Env: ${data.env}`;
  })
  .catch(() => {
    document.getElementById('version-box').innerText = 'Backend unreachable';
  });
fetch(`${API_BASE}/items`)
  .then((r) => r.json())
  .then((items) => {
    const ul = document.getElementById('items');
    items.forEach((item) => {
      const li = document.createElement('li');
      li.innerText = item.name;
      ul.appendChild(li);
    });
  })
  .catch(() => {});
