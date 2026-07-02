const app = document.querySelector('#app');
const titleElement = document.querySelector('#title');
const statusElement = document.querySelector('#status');
const notice = document.querySelector('#notice');
let enteredThisVisit = false;
let lastSeenResultCount = 0;

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
  for (let row = 1; row <= state.rows; row += 1) {
    for (let column = 1; column <= state.columns; column += 1) {
      const code = `${row}-${column}`;
      const isExcluded = state.excludedSeats.includes(code);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `seat${code === selected ? ' selected' : ''}${isExcluded ? ' excluded' : ''}`;
      button.innerHTML = `<span class="seat-number">${code}</span>`;
      button.disabled = isExcluded;
      button.title = isExcluded ? `${row}行 ${column}列：使用しない席` : `${row}行 ${column}列`;
      button.setAttribute('aria-pressed', String(code === selected));
      button.setAttribute('aria-label', isExcluded ? `${row}行 ${column}列：使用しない席` : `${row}行 ${column}列を希望する`);
      if (!isExcluded) button.addEventListener('click', () => castVote(code, button));
      grid.append(button);
    }
  }
  return grid;
}

function makeClassroomLayout(state, selected) {
  const scroll = document.createElement('div');
  scroll.className = 'classroom-scroll';
  const layout = document.createElement('div');
  layout.className = 'classroom-layout';
  layout.style.setProperty('--columns', state.columns);
  layout.style.setProperty('--grid-min-width', `${state.columns * 40 + Math.max(0, state.columns - 1) * 5}px`);
  const teacherDesk = document.createElement('div');
  teacherDesk.className = 'teacher-desk';
  teacherDesk.textContent = '教卓';
  layout.append(teacherDesk, makeSeatGrid(state, selected));
  scroll.append(layout);
  return scroll;
}

function makeResultGrid(state) {
  const resultBySeat = new Map(state.results.map((result) => [result.seat, result]));
  const grid = document.createElement('div');
  grid.className = 'seat-grid result-seat-grid';
  for (let row = 1; row <= state.rows; row += 1) {
    for (let column = 1; column <= state.columns; column += 1) {
      const code = `${row}-${column}`;
      const isExcluded = state.excludedSeats.includes(code);
      const result = resultBySeat.get(code);
      const seat = document.createElement('div');
      seat.className = `seat seat-card${isExcluded ? ' excluded' : ''}${result ? ' assigned' : ''}`;
      seat.title = isExcluded ? `${row}行 ${column}列：使用しない席` : `${row}行 ${column}列`;
      seat.setAttribute('aria-label', isExcluded ? `${row}行 ${column}列：使用しない席` : `${row}行 ${column}列：${result?.name || '未発表'}`);
      const number = document.createElement('span');
      number.className = 'seat-number';
      number.textContent = code;
      const occupant = document.createElement('strong');
      occupant.className = 'seat-person';
      occupant.textContent = isExcluded ? '使用しない' : (result?.name || '未発表');
      seat.append(number, occupant);
      grid.append(seat);
    }
  }
  return grid;
}

function makeResultClassroomLayout(state) {
  const scroll = document.createElement('div');
  scroll.className = 'classroom-scroll';
  const layout = document.createElement('div');
  layout.className = 'classroom-layout result-layout';
  layout.style.setProperty('--columns', state.columns);
  layout.style.setProperty('--grid-min-width', `${state.columns * 76 + Math.max(0, state.columns - 1) * 5}px`);
  const teacherDesk = document.createElement('div');
  teacherDesk.className = 'teacher-desk';
  teacherDesk.textContent = '教卓';
  layout.append(teacherDesk, makeResultGrid(state));
  scroll.append(layout);
  return scroll;
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
  section.append(heading, makeClassroomLayout(state, mine.vote));
  const note = document.createElement('p');
  note.className = 'vote-note';
  note.textContent = mine.vote ? `現在の希望：${mine.vote}` : 'まだ席を選んでいません。';
  section.append(note);
  app.replaceChildren(section);
}

function renderResults(state) {
  const section = document.createElement('section');
  section.className = 'card';
  const revealedCount = state.results.length;
  if (revealedCount > lastSeenResultCount) {
    setNotice(`${revealedCount - lastSeenResultCount}人分の結果が発表されました。`, true);
  }
  lastSeenResultCount = revealedCount;
  const pendingText = state.pendingResultCount
    ? `未発表 ${state.pendingResultCount} 人。順番に発表中です。`
    : 'すべての結果を発表しました。';
  section.innerHTML = `<h2>席替え結果</h2><p class="help">管理者が抽選して結果を公開しました。${pendingText}</p>`;
  section.append(makeResultClassroomLayout(state));
  const results = document.createElement('div');
  results.className = 'results';
  if (!state.results.length) {
    results.innerHTML = state.resultCount
      ? '<p class="empty-state">まだ発表されていません。</p>'
      : '<p class="empty-state">参加者がいません。</p>';
  }
  const table = document.createElement('table');
  table.className = 'results-table';
  table.innerHTML = '<thead><tr><th scope="col">発表順</th><th scope="col">名前</th><th scope="col">席</th></tr></thead>';
  const body = document.createElement('tbody');
  state.results.forEach((result, index) => {
    const row = document.createElement('tr');
    const order = document.createElement('td');
    order.textContent = String(index + 1);
    const name = document.createElement('td');
    name.textContent = result.name;
    const seat = document.createElement('td');
    seat.className = 'result-seat';
    seat.textContent = result.seat || '未配置';
    row.append(order, name, seat);
    body.append(row);
  });
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
  lastSeenResultCount = 0;
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
