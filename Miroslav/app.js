function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

let placesData = [];
let modalMap = null;

async function checkAuth() {
    const { data: { session } } = await db.auth.getSession();
    if (!session) window.location.href = '../Denis/login.html';
    return session;
}

// ── MODAL ────────────────────────────────────────────────────────────────────

function openModal(place) {
    const modal  = document.getElementById('placeModal');
    const img    = document.getElementById('modalImg');
    const body   = document.getElementById('modalBody');
    const mapEl  = document.getElementById('modalMap');
    if (!modal) return;

    if (place.image_url) {
        img.src = place.image_url;
        img.style.display = 'block';
    } else {
        img.style.display = 'none';
    }

    body.innerHTML = `
        <span class="card-tag">${esc(place.category)}</span>
        <h2 class="modal-title">${esc(place.title)}</h2>
        <p class="modal-desc">${esc(place.description)}</p>
        ${place.user_email
            ? `<p class="modal-meta">📧 <strong>${esc(place.user_email)}</strong></p>`
            : ''}
        ${(!place.lat || !place.lng)
            ? `<p class="modal-no-loc">Няма добавена локация.</p>`
            : ''}
    `;

    modal.classList.add('open');
    document.body.style.overflow = 'hidden';

    if (modalMap) { modalMap.remove(); modalMap = null; }

    if (place.lat && place.lng) {
        mapEl.style.display = 'block';
        setTimeout(() => {
            modalMap = L.map('modalMap').setView([place.lat, place.lng], 13);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            }).addTo(modalMap);
            L.marker([place.lat, place.lng]).addTo(modalMap);
        }, 50);
    } else {
        mapEl.style.display = 'none';
    }
}

function closeModal() {
    const modal = document.getElementById('placeModal');
    if (modal) modal.classList.remove('open');
    document.body.style.overflow = '';
    if (modalMap) { modalMap.remove(); modalMap = null; }
}

const modalClose = document.getElementById('modalClose');
if (modalClose) modalClose.addEventListener('click', closeModal);

const placeModal = document.getElementById('placeModal');
if (placeModal) {
    placeModal.addEventListener('click', e => {
        if (e.target === placeModal) closeModal();
    });
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
});

// ── COMMENTS ─────────────────────────────────────────────────────────────────

async function loadComments(placeId) {
    const list = document.getElementById(`clist-${placeId}`);
    if (!list) return;

    const { data: comments, error } = await db
        .from('place_comments')
        .select('*')
        .eq('place_id', placeId)
        .order('created_at', { ascending: true });

    if (error) {
        list.innerHTML = `<p class="c-empty">Грешка: ${esc(error.message)}</p>`;
        return;
    }

    if (!comments.length) {
        list.innerHTML = `<p class="c-empty">Все още няма коментари. Бъди първи!</p>`;
        return;
    }

    list.innerHTML = comments.map(c => `
        <div class="comment-item">
            <span class="comment-author">${esc(c.user_email)}</span>
            <p class="comment-text">${esc(c.content)}</p>
        </div>
    `).join('');

    list.scrollTop = list.scrollHeight;
}

// ── FEED ─────────────────────────────────────────────────────────────────────

async function loadPlaces(session) {
    const grid = document.getElementById('placesGrid');
    if (!grid) return;

    const currentEmail = session?.user?.email;

    const { data: places, error } = await db
        .from('places')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) {
        grid.innerHTML = `<p class="error">Грешка при зареждане: ${esc(error.message)}</p>`;
        return;
    }

    if (!places.length) {
        grid.innerHTML = `<p class="loader">Все още няма добавени места.</p>`;
        return;
    }

    placesData = places;

    grid.innerHTML = places.map(p => `
        <div class="place-card" data-id="${esc(p.id)}">
            ${p.image_url
                ? `<img src="${esc(p.image_url)}" class="card-img" onerror="this.style.display='none';this.insertAdjacentHTML('afterend','<div class=\\"card-no-img\\"><span>Няма снимка</span></div>')">`
                : `<div class="card-no-img"><span>Няма добавена снимка</span></div>`
            }
            <div class="card-info">
                <span class="card-tag">${esc(p.category)}</span>
                <h3>${esc(p.title)}</h3>
                <p>${esc(p.description)}</p>
            </div>
            <div class="card-footer">
                <button class="discuss-btn" data-id="${esc(p.id)}">💬 Коментари</button>
                ${currentEmail && p.user_email === currentEmail
                    ? `<button class="delete-btn" data-id="${esc(p.id)}">Изтрий</button>`
                    : ''}
            </div>
            <div class="comments-section" id="comments-${esc(p.id)}">
                <div class="comments-list" id="clist-${esc(p.id)}">
                    <p class="c-empty">Зареждане...</p>
                </div>
                <form class="comment-form" data-id="${esc(p.id)}">
                    <input type="text" class="comment-input" placeholder="Напиши коментар..." autocomplete="off">
                    <button type="submit" class="comment-submit">Изпрати</button>
                </form>
            </div>
        </div>
    `).join('');

    grid.addEventListener('click', async e => {
        // Comments toggle
        const discussBtn = e.target.closest('.discuss-btn');
        if (discussBtn) {
            const id = discussBtn.dataset.id;
            const section = document.getElementById(`comments-${id}`);
            const isOpen = section.classList.contains('open');
            section.classList.toggle('open', !isOpen);
            discussBtn.classList.toggle('active', !isOpen);
            if (!isOpen) await loadComments(id);
            return;
        }

        // Delete
        const deleteBtn = e.target.closest('.delete-btn');
        if (deleteBtn) {
            if (!confirm('Сигурен ли си, че искаш да изтриеш това място?')) return;
            const id = deleteBtn.dataset.id;
            deleteBtn.disabled = true;
            deleteBtn.textContent = '...';
            const { error } = await db.from('places').delete().eq('id', id);
            if (!error) {
                document.querySelector(`.place-card[data-id="${id}"]`).remove();
            } else {
                deleteBtn.disabled = false;
                deleteBtn.textContent = 'Изтрий';
            }
            return;
        }

        // Open modal — only when clicking card body (not footer/comments)
        if (!e.target.closest('.card-footer') && !e.target.closest('.comments-section')) {
            const card = e.target.closest('.place-card');
            if (card) {
                const place = placesData.find(p => p.id === card.dataset.id);
                if (place) openModal(place);
            }
        }
    });

    grid.addEventListener('submit', async e => {
        if (!e.target.classList.contains('comment-form')) return;
        e.preventDefault();
        const form = e.target;
        const id = form.dataset.id;
        const input = form.querySelector('.comment-input');
        const text = input.value.trim();
        if (!text) return;

        input.disabled = true;
        const { data: { session: s } } = await db.auth.getSession();
        const { error } = await db.from('place_comments').insert([{
            place_id: id,
            content: text,
            user_email: s?.user?.email || 'Анонимен'
        }]);

        input.disabled = false;
        if (!error) {
            input.value = '';
            await loadComments(id);
        }
    });
}

// ── ADD PLACE FORM ────────────────────────────────────────────────────────────

const placeForm = document.getElementById('placeForm');
if (placeForm) {
    placeForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('saveBtn');
        const msg = document.getElementById('statusMsg');

        const title       = document.getElementById('pTitle').value;
        const category    = document.getElementById('pCategory').value;
        const image_url   = document.getElementById('pImg').value;
        const description = document.getElementById('pDesc').value;
        const lat         = document.getElementById('pLat').value || null;
        const lng         = document.getElementById('pLng').value || null;

        btn.disabled = true;
        btn.textContent = 'Публикуване...';

        const { data: { session } } = await db.auth.getSession();
        const { error } = await db.from('places').insert([{
            title,
            category,
            image_url: image_url || null,
            description,
            user_email: session?.user?.email || null,
            lat: lat ? parseFloat(lat) : null,
            lng: lng ? parseFloat(lng) : null
        }]);

        btn.disabled = false;
        btn.textContent = 'Публикувай';

        if (error) {
            msg.textContent = 'Грешка: ' + error.message;
            msg.className = 'msg error';
        } else {
            msg.textContent = 'Успешно добавено!';
            msg.className = 'msg success';
            setTimeout(() => window.location.href = 'index.html', 1500);
        }
    });
}

// ── MAP PICKER (add-place page) ───────────────────────────────────────────────

const pickMapEl = document.getElementById('pickMap');
if (pickMapEl && typeof L !== 'undefined') {
    const pickMap = L.map('pickMap').setView([42.7339, 25.4858], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(pickMap);

    let pickMarker = null;
    pickMap.on('click', e => {
        const { lat, lng } = e.latlng;
        document.getElementById('pLat').value = lat;
        document.getElementById('pLng').value = lng;
        document.getElementById('mapHint').textContent =
            `Маркирано: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;

        if (pickMarker) pickMarker.setLatLng(e.latlng);
        else pickMarker = L.marker(e.latlng).addTo(pickMap);
    });
}

// ── LOGOUT ────────────────────────────────────────────────────────────────────

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        await db.auth.signOut();
        window.location.href = '../Denis/login.html';
    });
}

checkAuth().then(session => loadPlaces(session));
