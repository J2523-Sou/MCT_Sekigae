const loginPanel = document.querySelector('#login-panel');
const adminApp = document.querySelector('#admin-app');
const notice = document.querySelector('#notice');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function setNotice(message, isOk = false) {
  notice.hidden = !message;
  notice.textContent = message || '';
  notice.classList.toggle('ok', isOk);
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '通信に失敗しました。');
  return data;
}

function render(state) {
  const { settings, excludedSeats, participants } = state;
  const phaseText = settings.phase === 'results' ? '結果公開中' : '投票受付中';
  const excluded = new Set(excludedSeats);
  const seatButtons = Array.from({ length: settings.rows_count }, (_, row) =>
    Array.from({ length: settings.columns_count }, (_, column) => {
      const code = `${row + 1}-${column + 1}`;
      const selected = excluded.has(code);
      return `<button type="button" class="seat${selected ? ' excluded' : ''}" data-exclude="${code}" aria-pressed="${selected}"><span class="seat-label">${row + 1}行 ${column + 1}列</span><span class="seat-number">${code}</span></button>`;
    }).join('')
  ).join('');
  const rows = participants.length
    ? participants.map((person) => `
        <div class="participant-row">
          <strong>${escapeHtml(person.name)}</strong>
          <span class="muted">希望 ${escapeHtml(person.vote || '—')}</span>
          <span class="muted">結果 ${escapeHtml(person.assignment || '—')}</span>
          <button class="danger small" data-delete="${escapeHtml(person.id)}" aria-label="${escapeHtml(person.name)}を削除">削除</button>
        </div>`).join('')
    : '<p class="empty-state">まだ参加者はいません。</p>';
  adminApp.innerHTML = `
    <div class="toolbar">
      <span class="phase ${settings.phase}">${phaseText}</span>
      <span class="muted">参加者 ${participants.length} 人</span>
      <span class="spacer"></span>
      <button id="refresh" class="secondary small">更新</button>
      <button id="logout" class="secondary small">ログアウト</button>
    </div>
    <section class="card">
      <h2>投票の設定</h2>
      <form id="settings-form">
        <div class="settings-grid">
          <label>タイトル<input name="title" maxlength="60" value="${escapeHtml(settings.title)}" required></label>
          <label>行数<input name="rows" type="number" min="1" max="12" value="${settings.rows_count}" required></label>
          <label>列数<input name="columns" type="number" min="1" max="12" value="${settings.columns_count}" required></label>
        </div>
        <div>
          <div class="seat-config-label"><span>使わない席を選択</span><span id="excluded-count">${excludedSeats.length} 席を除外中</span></div>
          <div class="seat-grid admin-seat-grid" style="--columns: ${settings.columns_count}">${seatButtons}</div>
        </div>
        <button class="secondary" type="submit">設定を保存</button>
      </form>
      <p class="warning-box">行数・列数または使わない席を変更すると、現在の希望席と公開結果は消去されます。参加者名は残ります。</p>
    </section>
    <div class="dashboard-grid">
      <section class="card">
        <h2>結果の操作</h2>
        <p class="help">同じ席を希望した人の中からランダムに1人を選び、残りの人には空いている席をランダムに割り当てます。</p>
        <div class="toolbar">
          ${settings.phase === 'voting'
            ? '<button id="publish" class="primary">投票を締め切って結果を公開</button>'
            : '<button id="reopen" class="secondary">投票を再開</button>'}
          <button id="reset" class="danger">全データをリセット</button>
        </div>
      </section>
      <section class="card">
        <h2>参加者と希望席</h2>
        <div class="mini-list">${rows}</div>
      </section>
    </div>`;
  bindActions();
}

function bindActions() {
  document.querySelector('#refresh').addEventListener('click', load);
  document.querySelector('#logout').addEventListener('click', logout);
  document.querySelector('#settings-form').addEventListener('submit', saveSettings);
  document.querySelectorAll('[data-exclude]').forEach((button) => button.addEventListener('click', () => {
    const selected = button.getAttribute('aria-pressed') === 'true';
    button.setAttribute('aria-pressed', String(!selected));
    button.classList.toggle('excluded', !selected);
    const count = document.querySelectorAll('[data-exclude][aria-pressed="true"]').length;
    document.querySelector('#excluded-count').textContent = `${count} 席を除外中`;
  }));
  document.querySelector('#publish')?.addEventListener('click', publish);
  document.querySelector('#reopen')?.addEventListener('click', reopen);
  document.querySelector('#reset').addEventListener('click', reset);
  document.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteParticipant(button.dataset.delete)));
}

async function load() {
  try {
    const state = await request('/api/admin/state');
    loginPanel.hidden = true;
    adminApp.hidden = false;
    render(state);
  } catch (error) {
    loginPanel.hidden = false;
    adminApp.hidden = true;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  data.excludedSeats = Array.from(document.querySelectorAll('[data-exclude][aria-pressed="true"]'), (button) => button.dataset.exclude);
  try {
    const result = await request('/api/admin/settings', { method: 'POST', body: JSON.stringify(data) });
    setNotice(result.seatsChanged ? '設定を保存し、希望席と結果を消去しました。' : '設定を保存しました。', true);
    await load();
  } catch (error) { setNotice(error.message); }
}

async function publish() {
  if (!confirm('投票を締め切り、抽選結果を全員に公開します。よろしいですか？')) return;
  try {
    await request('/api/admin/publish', { method: 'POST', body: '{}' });
    setNotice('結果を公開しました。', true);
    await load();
  } catch (error) { setNotice(error.message); }
}

async function reopen() {
  if (!confirm('公開結果を取り消して、投票を再開します。よろしいですか？')) return;
  try {
    await request('/api/admin/reopen', { method: 'POST', body: '{}' });
    setNotice('投票を再開しました。希望席はそのまま残っています。', true);
    await load();
  } catch (error) { setNotice(error.message); }
}

async function reset() {
  if (!confirm('参加者、希望席、結果をすべて削除します。この操作は取り消せません。よろしいですか？')) return;
  try {
    await request('/api/admin/reset', { method: 'POST', body: '{}' });
    setNotice('全データをリセットしました。', true);
    await load();
  } catch (error) { setNotice(error.message); }
}

async function deleteParticipant(id) {
  if (!confirm('この参加者を削除しますか？')) return;
  try {
    await request('/api/admin/participant/delete', { method: 'POST', body: JSON.stringify({ id }) });
    setNotice('参加者を削除しました。', true);
    await load();
  } catch (error) { setNotice(error.message); }
}

async function logout() {
  await request('/api/admin/logout', { method: 'POST', body: '{}' });
  setNotice('');
  loginPanel.hidden = false;
  adminApp.hidden = true;
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: form.querySelector('#password').value }) });
    form.reset();
    setNotice('');
    await load();
  } catch (error) { setNotice(error.message); }
});

load();
