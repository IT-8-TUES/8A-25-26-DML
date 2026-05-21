/**
 * МестаБГ — Форуми
 * - Ако в Supabase съществуват таблиците forum_threads / forum_messages (виж supabase_forums.sql),
 *   данните се пазят там и са споделени между всички потребители.
 * - Иначе: локален режим с localStorage в браузъра.
 */

const STORAGE_KEY = 'mestabg_forums_v1';

/** @type {'supabase' | 'local' | null} */
let forumBackendResolved = null;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { threads: [] };
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.threads)) return { threads: [] };
    return data;
  } catch {
    return { threads: [] };
  }
}

function saveStore(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function nowIso() {
  return new Date().toISOString();
}

function formatBgDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('bg-BG', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

async function requireSession() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) {
    window.location.href = '../Denis/login.html';
    return null;
  }
  return session;
}

function userLabel(session) {
  const u = session.user;
  return (
    u.user_metadata?.full_name ||
    u.user_metadata?.name ||
    u.email?.split('@')[0] ||
    'Потребител'
  );
}

function wireLogout() {
  const btn = document.getElementById('logoutBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await db.auth.signOut();
    window.location.href = '../Denis/login.html';
  });
}

function newId() {
  return crypto.randomUUID();
}

async function resolveForumBackend() {
  if (forumBackendResolved) return forumBackendResolved;
  const { error } = await db.from('forum_threads').select('id').limit(1);
  if (!error) {
    forumBackendResolved = 'supabase';
    return forumBackendResolved;
  }
  const blob = [error.message, error.details, error.hint, String(error.code || '')].join(' ');
  const tableMissing =
    /Could not find the table|schema cache|does not exist|42P01/i.test(blob) ||
    error.code === 'PGRST205' ||
    error.code === '42P01';
  if (tableMissing) {
    forumBackendResolved = 'local';
    return forumBackendResolved;
  }
  console.warn('[forums] Supabase недостъпен, ползвам localStorage:', error);
  forumBackendResolved = 'local';
  return forumBackendResolved;
}

function mapMessageRow(m) {
  return {
    id: m.id,
    authorId: m.author_id,
    authorLabel: m.author_label,
    body: m.body,
    createdAt: m.created_at,
  };
}

// ── Supabase: list ──────────────────────────────────────────────────────────

async function sbLoadThreadSummaries() {
  const { data, error } = await db
    .from('forum_threads')
    .select(
      `
      id,
      title,
      author_label,
      created_at,
      updated_at,
      forum_messages ( count )
    `
    )
    .order('updated_at', { ascending: false })
    .limit(150);

  if (error) throw error;

  return (data || []).map((t) => {
    const rawCount = t.forum_messages?.[0]?.count;
    const messageCount = typeof rawCount === 'number' ? rawCount : parseInt(rawCount, 10) || 0;
    return {
      id: t.id,
      title: t.title,
      authorLabel: t.author_label,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      messageCount,
    };
  });
}

async function sbCreateThread(title, firstBody, session) {
  const label = userLabel(session);
  const { data: row, error: e1 } = await db
    .from('forum_threads')
    .insert({
      title,
      author_id: session.user.id,
      author_label: label,
    })
    .select('id')
    .single();

  if (e1) throw e1;

  if (firstBody) {
    const { error: e2 } = await db.from('forum_messages').insert({
      thread_id: row.id,
      author_id: session.user.id,
      author_label: label,
      body: firstBody,
    });
    if (e2) throw e2;
  }

  return row.id;
}

// ── Supabase: thread view ───────────────────────────────────────────────────

async function sbLoadThread(threadId) {
  const { data: thread, error: e1 } = await db
    .from('forum_threads')
    .select('id, title, author_label, created_at')
    .eq('id', threadId)
    .maybeSingle();

  if (e1) throw e1;
  if (!thread) return null;

  const { data: messages, error: e2 } = await db
    .from('forum_messages')
    .select('id, author_id, author_label, body, created_at')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: true });

  if (e2) throw e2;

  return {
    id: thread.id,
    title: thread.title,
    authorLabel: thread.author_label,
    createdAt: thread.created_at,
    messages: (messages || []).map(mapMessageRow),
  };
}

async function sbAddMessage(threadId, body, session) {
  const { error } = await db.from('forum_messages').insert({
    thread_id: threadId,
    author_id: session.user.id,
    author_label: userLabel(session),
    body,
  });
  if (error) throw error;
}

async function sbDeleteMessage(msgId) {
  const { error } = await db.from('forum_messages').delete().eq('id', msgId);
  if (error) throw error;
}

// ── List page ───────────────────────────────────────────────────────────────

async function initForumsList() {
  const root = document.getElementById('threadsRoot');
  if (!root) return;

  wireLogout();
  const session = await requireSession();
  if (!session) return;

  const backend = await resolveForumBackend();
  const form = document.getElementById('newThreadForm');
  const listEl = document.getElementById('threadList');
  const msgEl = document.getElementById('listMessage');
  const btn = document.getElementById('createThreadBtn');

  function showMsg(text, kind) {
    msgEl.hidden = false;
    msgEl.textContent = text;
    msgEl.className = 'msg ' + (kind === 'error' ? 'error' : 'success');
  }

  async function renderList() {
    if (backend === 'supabase') {
      try {
        const rows = await sbLoadThreadSummaries();
        if (rows.length === 0) {
          listEl.innerHTML =
            '<p class="empty-state">Все още няма теми. Създай първия въпрос по-горе.</p>';
          return;
        }
        listEl.innerHTML = rows
          .map((t) => {
            const excerpt =
              t.messageCount > 0
                ? 'Има отговори в разговора — отвори темата за целия текст.'
                : 'Няма съобщения още.';
            return `
          <button type="button" class="thread-card" data-id="${esc(t.id)}">
            <h3>${esc(t.title)}</h3>
            <p class="excerpt">${esc(excerpt)}</p>
            <div class="meta">
              <span>${esc(formatBgDate(t.createdAt))}</span>
              <span>${t.messageCount} съобщени${t.messageCount === 1 ? 'е' : 'я'}</span>
            </div>
          </button>`;
          })
          .join('');
      } catch (err) {
        console.error(err);
        listEl.innerHTML =
          '<p class="empty-state">Грешка при зареждане от Supabase. Провери RLS и таблиците.</p>';
        return;
      }
    } else {
      const { threads } = loadStore();
      const sorted = [...threads].sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt)
      );

      if (sorted.length === 0) {
        listEl.innerHTML =
          '<p class="empty-state">Все още няма теми. Създай първия въпрос по-горе. (Локален режим — добави таблиците в Supabase за споделен форум.)</p>';
        return;
      }

      listEl.innerHTML = sorted
        .map((t) => {
          const count = Array.isArray(t.messages) ? t.messages.length : 0;
          const last = t.messages?.length ? t.messages[t.messages.length - 1] : null;
          const excerpt = last
            ? last.body.slice(0, 140) + (last.body.length > 140 ? '…' : '')
            : 'Няма съобщения още.';
          return `
          <button type="button" class="thread-card" data-id="${esc(t.id)}">
            <h3>${esc(t.title)}</h3>
            <p class="excerpt">${esc(excerpt)}</p>
            <div class="meta">
              <span>${esc(formatBgDate(t.createdAt))}</span>
              <span>${count} съобщени${count === 1 ? 'е' : 'я'}</span>
            </div>
          </button>`;
        })
        .join('');
    }

    listEl.querySelectorAll('.thread-card').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        window.location.href = 'thread.html?id=' + encodeURIComponent(id);
      });
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msgEl.hidden = true;

    const title = document.getElementById('threadTitle').value.trim();
    const first = document.getElementById('threadFirstMsg').value.trim();

    if (!title) {
      showMsg('Моля въведи заглавие.', 'error');
      return;
    }

    const { data: { session: s } } = await db.auth.getSession();
    if (!s) {
      window.location.href = '../Denis/login.html';
      return;
    }

    btn.disabled = true;

    try {
      if (backend === 'supabase') {
        const id = await sbCreateThread(title, first, s);
        document.getElementById('threadTitle').value = '';
        document.getElementById('threadFirstMsg').value = '';
        window.location.href = 'thread.html?id=' + encodeURIComponent(id);
      } else {
        const store = loadStore();
        const threadId = newId();
        const authorId = s.user.id;
        const authorLabel = userLabel(s);
        const ts = nowIso();

        const messages = [];
        if (first) {
          messages.push({
            id: newId(),
            authorId,
            authorLabel,
            body: first,
            createdAt: ts,
          });
        }

        store.threads.push({
          id: threadId,
          title,
          authorId,
          authorLabel,
          createdAt: ts,
          updatedAt: ts,
          messages,
        });
        saveStore(store);

        document.getElementById('threadTitle').value = '';
        document.getElementById('threadFirstMsg').value = '';
        window.location.href = 'thread.html?id=' + encodeURIComponent(threadId);
      }
    } catch (err) {
      console.error(err);
      showMsg(err.message || 'Грешка при запис.', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  await renderList();
}

// ── Thread page ───────────────────────────────────────────────────────────────

async function initThreadView() {
  const root = document.getElementById('threadRoot');
  if (!root) return;

  wireLogout();
  const session = await requireSession();
  if (!session) return;

  const backend = await resolveForumBackend();
  const params = new URLSearchParams(window.location.search);
  const threadId = params.get('id');
  const missingEl = document.getElementById('threadMissing');
  const liveEl = document.getElementById('threadLive');
  const titleH = document.getElementById('threadTitleH');
  const metaEl = document.getElementById('threadMeta');
  const chatLog = document.getElementById('chatLog');
  const replyBody = document.getElementById('replyBody');
  const sendBtn = document.getElementById('sendReplyBtn');
  const replyMsg = document.getElementById('replyMessage');
  const replyHint = document.getElementById('replyHint');

  const myId = session.user.id;
  replyHint.textContent =
    (backend === 'supabase' ? '[Supabase] ' : '[Локално] ') + 'Влязъл като: ' + userLabel(session);

  function showReplyMsg(text, kind) {
    replyMsg.hidden = false;
    replyMsg.textContent = text;
    replyMsg.className = 'msg ' + (kind === 'error' ? 'error' : 'success');
    if (!text) replyMsg.hidden = true;
  }

  async function renderChat() {
    let thread = null;

    if (backend === 'supabase') {
      try {
        thread = await sbLoadThread(threadId);
      } catch (err) {
        console.error(err);
        missingEl.hidden = false;
        liveEl.hidden = true;
        missingEl.querySelector('p').textContent =
          'Грешка при зареждане от Supabase: ' + (err.message || '');
        document.title = 'МестаБГ — Грешка';
        return;
      }
    } else {
      const store = loadStore();
      thread = store.threads.find((t) => t.id === threadId) || null;
    }

    if (!thread) {
      missingEl.hidden = false;
      liveEl.hidden = true;
      document.title = 'МестаБГ — Темата не е намерена';
      return;
    }

    missingEl.hidden = true;
    liveEl.hidden = false;
    titleH.textContent = thread.title;
    metaEl.textContent =
      'Създадена от ' +
      thread.authorLabel +
      ' · ' +
      formatBgDate(thread.createdAt);

    const msgs = thread.messages || [];
    if (msgs.length === 0) {
      chatLog.innerHTML =
        '<p class="empty-state" style="margin:0;">Няма съобщения. Напиши първия отговор по-долу.</p>';
      return;
    }

    chatLog.innerHTML = msgs
      .map((m) => {
        const own = m.authorId === myId;
        const delBtn = own
          ? `<div class="bubble-actions"><button type="button" class="btn-delete" data-msg-id="${esc(m.id)}">Изтрий моя отговор</button></div>`
          : '';
        return `
          <article class="bubble ${own ? 'bubble--own' : ''}" data-msg-id="${esc(m.id)}">
            <div class="bubble-top">
              <span class="bubble-author">${esc(m.authorLabel)}</span>
              <time class="bubble-time" datetime="${esc(m.createdAt)}">${esc(formatBgDate(m.createdAt))}</time>
            </div>
            <div class="bubble-body">${esc(m.body)}</div>
            ${delBtn}
          </article>`;
      })
      .join('');

    chatLog.querySelectorAll('.btn-delete').forEach((b) => {
      b.addEventListener('click', () => {
        const msgId = b.getAttribute('data-msg-id');
        deleteMessage(msgId);
      });
    });

    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function deleteMessage(msgId) {
    if (!window.confirm('Да изтриеш това съобщение?')) return;

    try {
      if (backend === 'supabase') {
        const thread = await sbLoadThread(threadId);
        const m = thread?.messages?.find((x) => x.id === msgId);
        if (!m) return;
        if (m.authorId !== myId) {
          showReplyMsg('Можеш да изтриваш само собствените си съобщения.', 'error');
          return;
        }
        await sbDeleteMessage(msgId);
      } else {
        const store = loadStore();
        const idx = store.threads.findIndex((t) => t.id === threadId);
        if (idx === -1) return;
        const th = store.threads[idx];
        const messages = th.messages || [];
        const mi = messages.findIndex((m) => m.id === msgId);
        if (mi === -1) return;
        if (messages[mi].authorId !== myId) {
          showReplyMsg('Можеш да изтриваш само собствените си съобщения.', 'error');
          return;
        }
        messages.splice(mi, 1);
        th.messages = messages;
        th.updatedAt = nowIso();
        saveStore(store);
      }
      showReplyMsg('', 'success');
      await renderChat();
    } catch (err) {
      console.error(err);
      showReplyMsg(err.message || 'Изтриването не успя.', 'error');
    }
  }

  sendBtn.addEventListener('click', async () => {
    showReplyMsg('', 'success');
    const body = replyBody.value.trim();
    if (!body) {
      showReplyMsg('Напиши текст на отговора.', 'error');
      return;
    }

    const { data: { session: s } } = await db.auth.getSession();
    if (!s) {
      window.location.href = '../Denis/login.html';
      return;
    }

    sendBtn.disabled = true;
    try {
      if (backend === 'supabase') {
        await sbAddMessage(threadId, body, s);
      } else {
        const store = loadStore();
        const th = store.threads.find((t) => t.id === threadId);
        if (!th) {
          showReplyMsg('Темата не съществува.', 'error');
          return;
        }
        if (!Array.isArray(th.messages)) th.messages = [];
        th.messages.push({
          id: newId(),
          authorId: s.user.id,
          authorLabel: userLabel(s),
          body,
          createdAt: nowIso(),
        });
        th.updatedAt = nowIso();
        saveStore(store);
      }
      replyBody.value = '';
      await renderChat();
    } catch (err) {
      console.error(err);
      showReplyMsg(err.message || 'Грешка при изпращане.', 'error');
    } finally {
      sendBtn.disabled = false;
    }
  });

  if (!threadId) {
    missingEl.hidden = false;
    liveEl.hidden = true;
    return;
  }

  await renderChat();
}

// ── Boot ─────────────────────────────────────────────────────────────────────

if (document.getElementById('threadsRoot')) {
  initForumsList();
}
if (document.getElementById('threadRoot')) {
  initThreadView();
}
