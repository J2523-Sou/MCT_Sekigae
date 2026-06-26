const app = document.querySelector('#app');
const titleElement = document.querySelector('#title');
const statusElement = document.querySelector('#status');
const notice = document.querySelector('#notice');
let enteredThisVisit = false;

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

function makeSeatGrid(state, selected) {
  const grid = document.createElement('div');
  grid.className = 'seat-grid';
  grid.style.setProperty('--columns', state.columns);
  for (let row = 1; row <= state.rows; row += 1) {
    for (let column = 1; column <= state.columns; column += 1) {
      const code = `${row}-${column}`;
      const isExcluded = state.excludedSeats.includes(code);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `seat${code === selected ? ' selected' : ''}${isExcluded ? ' excluded' : ''}`;
      button.innerHTML = `<span class="seat-label">${row}行 ${column}列</span><span class="seat-number">${code}</span>`;
      button.disabled = isExcluded;
      button.setAttribute('aria-pressed', String(code === selected));
      button.setAttribute('aria-label', isExcluded ? `${row}行 ${column}列：使用しない席` : `${row}行 ${column}列を希望する`);
      if (!isExcluded) button.addEventListener('click', () => castVote(code, button));
      grid.append(button);
    }
  }
  return grid;
}

async function castVote(seat, button) {
  setNotice('');
  button.disabled = true;
  try {
    await request('/api/vote', { method: 'POST', body: JSON.stringify({ seat }) });
    setNotice(`希望席「${seat}」を受け付けました。`, true);
    await load();
  } catch (error) {
    setNotice(error.message);
  } finally {
    button.disabled = false;
  }
}

function renderJoin(state) {
  const section = document.createElement('section');
  section.className = 'card join-card';
  section.innerHTML = `
    <h2>投票に参加</h2>
    <p class="help">名前を入力してから、希望する席を1つ選んでください。名前はこの画面を開くたびに入力します。同じ席を希望した場合は、結果公開時に抽選で決めます。</p>
    <form id="join-form" autocomplete="off"><label>名前<input id="name" name="display-name" type="text" maxlength="30" autocomplete="off" autocapitalize="words" required placeholder="例：山田 太郎"></label><button class="primary" type="submit">席を選ぶ</button></form>`;
  section.querySelector('#join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    setNotice('');
    try {
      await request('/api/join', { method: 'POST', body: JSON.stringify({ name: section.querySelector('#name').value }) });
      enteredThisVisit = true;
      await load();
    } catch (error) {
      setNotice(error.message);
    } finally {
      button.disabled = false;
    }
  });
  app.replaceChildren(section);
}

function renderVoting(state) {
  const mine = state.myParticipant;
  const section = document.createElement('section');
  section.className = 'card';
  const heading = document.createElement('div');
  heading.className = 'voter-name';
  heading.innerHTML = '<div><h2>希望する席を選ぶ</h2><p class="help">同じ席を希望した場合は抽選になります。変更は何度でもできます。</p></div>';
  const name = document.createElement('strong');
  name.textContent = mine.name;
  heading.append(name);
  section.append(heading, makeSeatGrid(state, mine.vote));
  const note = document.createElement('p');
  note.className = 'vote-note';
  note.textContent = mine.vote ? `現在の希望：${mine.vote}` : 'まだ席を選んでいません。';
  section.append(note);
  app.replaceChildren(section);
}

function renderResults(state) {
  const section = document.createElement('section');
  section.className = 'card';
  section.innerHTML = '<h2>席替え結果</h2><p class="help">管理者が抽選して結果を公開しました。</p>';
  const results = document.createElement('div');
  results.className = 'results';
  if (!state.results.length) results.innerHTML = '<p class="empty-state">参加者がいません。</p>';
  const table = document.createElement('table');
  table.className = 'results-table';
  table.innerHTML = '<thead><tr><th scope="col">名前</th><th scope="col">席</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const result of state.results) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = result.name;
    const seat = document.createElement('td');
    seat.className = 'result-seat';
    seat.textContent = result.seat || '未配置';
    row.append(name, seat);
    body.append(row);
  }
  table.append(body);
  if (state.results.length) results.append(table);
  section.append(results);
  app.replaceChildren(section);
}

function render(state) {
  titleElement.textContent = state.title;
  document.title = `${state.title} | 席替え投票`;
  statusElement.textContent = state.phase === 'results'
    ? `結果を公開中 · 参加者 ${state.participantCount} 人`
    : `投票受付中 · 参加者 ${state.participantCount} 人`;
  if (state.phase === 'results') return renderResults(state);
  if (!enteredThisVisit || !state.myParticipant) {
    // The public state is polled regularly.  Keep the existing form while the
    // user is entering their name so a poll never clears the draft.
    if (!app.querySelector('#join-form')) renderJoin(state);
    return;
  }
  renderVoting(state);
}

async function load(silent = false) {
  try {
    const state = await request('/api/state');
    render(state);
  } catch (error) {
    if (!silent) setNotice(error.message);
  }
}

load();
setInterval(() => load(true), 4000);
