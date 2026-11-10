const $ = (selector) => document.querySelector(selector);
const postsEl = $('#posts');
const AUTH_EVENT_KEY = 'community-web-auth-changed';
const AUTH_NOTICE_KEY = 'community-web-auth-notice';
let currentPostId = null;
let currentUser = null;
let csrfToken = '';
let authMode = 'login';
let checkingOtherTab = false;

function showAuthState() {
  $('#account-status').textContent = currentUser ? `${currentUser.username}님` : '로그인하지 않음';
  $('#login-button').hidden = !!currentUser;
  $('#logout-button').hidden = !currentUser;
}

// 세션 쿠키는 같은 브라우저의 여러 탭에서 공유한다. 항상 서버에서 현재 계정을 확인한다.
async function refreshAuth() {
  const response = await fetch('/api/auth/me', {cache: 'no-store', credentials: 'same-origin'});
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '로그인 상태를 확인하지 못했습니다.');
  currentUser = data.user;
  csrfToken = data.csrf;
  showAuthState();
  return data;
}

function requireAccount() {
  if (currentUser) return true;
  toast('로그인 후 이용해 주세요.');
  setAuthMode('login');
  $('#auth-dialog').showModal();
  return false;
}

function setAuthMode(mode) {
  authMode = mode;
  $('#auth-submit').textContent = mode === 'login' ? '로그인' : '회원가입';
  $('#auth-login-tab').classList.toggle('selected', mode === 'login');
  $('#auth-register-tab').classList.toggle('selected', mode === 'register');
  $('#auth-form').elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-error').textContent = '';
}

function broadcastAuthChange() {
  try { localStorage.setItem(AUTH_EVENT_KEY, String(Date.now()) + '-' + Math.random()); } catch (_) {}
}

function reloadAfterAuth(message) {
  try { sessionStorage.setItem(AUTH_NOTICE_KEY, message); } catch (_) {}
  broadcastAuthChange();
  // 수동 새로고침 대신 실제 로그인 세션이 반영된 화면을 자동으로 다시 불러온다.
  window.location.reload();
}

// 다른 탭에서 로그인·로그아웃하면 현재 탭의 표시도 실제 쿠키 세션에 맞춘다.
async function synchronizeOtherTab() {
  if (checkingOtherTab) return;
  checkingOtherTab = true;
  const previousId = currentUser?.id ?? null;
  try {
    await refreshAuth();
    const nextId = currentUser?.id ?? null;
    if (previousId !== nextId) {
      const postDialog = $('#post-dialog');
      if (postDialog.open) postDialog.close();
      await loadPosts();
      if ($('#detail-dialog').open && currentPostId) await loadDetail();
      toast(`다른 탭에서 로그인 상태가 변경됐습니다. 현재: ${currentUser ? currentUser.username : '로그아웃'}`);
    }
  } catch (e) { console.warn('로그인 상태 동기화 실패:', e); }
  finally { checkingOtherTab = false; }
}
window.addEventListener('storage', (event) => {
  if (event.key === AUTH_EVENT_KEY) void synchronizeOtherTab();
});
window.addEventListener('focus', () => { void synchronizeOtherTab(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void synchronizeOtherTab();
});

$('#login-button').addEventListener('click', () => {
  setAuthMode('login');
  $('#auth-dialog').showModal();
});
$('#logout-button').addEventListener('click', async () => {
  const button = $('#logout-button');
  button.disabled = true;
  try {
    await api('/api/auth/logout', {method: 'POST'});
    reloadAfterAuth('로그아웃했습니다.');
  } catch (e) {
    toast(e.message);
    button.disabled = false;
  }
});
$('#auth-login-tab').addEventListener('click', () => setAuthMode('login'));
$('#auth-register-tab').addEventListener('click', () => setAuthMode('register'));
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#auth-submit');
  const mode = authMode;
  const data = Object.fromEntries(new FormData(form));
  data.username = data.username.trim();
  $('#auth-error').textContent = '';
  button.disabled = true;
  try {
    const result = await api(`/api/auth/${mode}`, {method: 'POST', body: JSON.stringify(data)});
    if (!result.user || result.user.username !== data.username) {
      throw Error('입력한 아이디와 서버의 로그인 계정이 일치하지 않습니다.');
    }
    reloadAfterAuth(`${result.user.username} 계정으로 ${mode === 'login' ? '로그인' : '회원가입'}했습니다.`);
  } catch (error) {
    $('#auth-error').textContent = error.message;
    button.disabled = false;
  }
});
const fmtDate = (value) => new Date(value).toLocaleString('ko-KR', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
function el(tag, className, text) { const n=document.createElement(tag); if(className)n.className=className; if(text!==undefined)n.textContent=text; return n; }
function toast(msg) { const t=$('#toast'); t.textContent=msg;t.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.style.display='none',2700); }
// 다른 탭에서 세션 쿠키가 변경되어 CSRF 토큰이 오래되었으면 자동 갱신 후 1회 재시도.
async function api(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const mutating = method !== 'GET' && method !== 'HEAD';
  for (let attempt = 0; attempt < 2; attempt++) {
    const userBeforeRequest = currentUser?.id ?? null;
    const response = await fetch(path, {
      ...options,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
        ...(mutating ? {'X-CSRF-Token': csrfToken} : {})
      }
    });
    let data;
    try { data = await response.json(); }
    catch (_) { throw Error('서버 응답을 읽을 수 없습니다.'); }
    if (response.status === 403 && data.code === 'CSRF_STALE' && attempt === 0) {
      await refreshAuth();
      // 글·댓글·좋아요 요청을 다른 계정 명의로 몰래 재전송하지 않는다.
      if (!path.startsWith('/api/auth/') && userBeforeRequest !== (currentUser?.id ?? null)) {
        throw Error('다른 탭에서 로그인 계정이 변경되었습니다. 계정을 확인하고 다시 시도해 주세요.');
      }
      continue;
    }
    if (!response.ok) throw Error(data.error || '요청에 실패했습니다.');
    return data;
  }
  throw Error('인증 정보를 갱신하지 못했습니다. 로그인 상태를 확인해 주세요.');
}
function showError(where, error){ $(where).textContent=error.message||'요청에 실패했습니다.'; }
function openDialog(id){$('#'+id).showModal();}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$('#'+b.dataset.close).close()));
$('#write-button').addEventListener('click',()=>{ if(!requireAccount())return; $('#post-error').textContent='';openDialog('post-dialog'); });
async function loadPosts(){try{const posts=await api('/api/posts');$('#post-count').textContent=`게시글 ${posts.length}개`;postsEl.replaceChildren();if(!posts.length){postsEl.append(el('div','empty','아직 게시글이 없습니다. 첫 번째 글을 작성해 보세요.'));return;}for(const p of posts){const card=el('article','post-card');card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`${p.title} 자세히 보기`);card.append(el('h3','',p.title),el('p','',p.content));const meta=el('div','post-meta');meta.append(el('span','',p.nickname),el('span','',fmtDate(p.created_at)));card.append(meta);const bottom=el('div','post-bottom');bottom.append(el('span','',`♡ 좋아요 ${p.like_count}`),el('span','',`▢ 댓글 ${p.comment_count}`));card.append(bottom);card.addEventListener('click',()=>openPost(p.id));card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPost(p.id);}});postsEl.append(card);}}catch(e){postsEl.replaceChildren(el('div','empty',`게시글 불러오기 실패: ${e.message}`));}}
$('#post-form').addEventListener('submit',async e=>{e.preventDefault();$('#post-error').textContent='';if(!requireAccount())return;const form=e.currentTarget;const data=Object.fromEntries(new FormData(form));try{await api('/api/posts',{method:'POST',body:JSON.stringify(data)});form.reset();$('#post-dialog').close();toast('게시글이 등록되었습니다.');await loadPosts();}catch(error){showError('#post-error',error);}});
async function openPost(id){currentPostId=id;$('#comment-error').textContent='';$('#comment-form').reset();openDialog('detail-dialog');await loadDetail();}
async function loadDetail(){if(!currentPostId)return;try{const [{post,comments},myLike]=await Promise.all([api(`/api/posts/${currentPostId}`),api(`/api/posts/${currentPostId}/my-like`)]);const box=$('#detail-content');box.replaceChildren();box.append(el('h2','detail-title',post.title),el('div','detail-meta',`${post.nickname} · ${fmtDate(post.created_at)}`),el('div','detail-body',post.content));const like=el('button',`like-button ${myLike.liked?'active':''}`,`${myLike.liked?'♥':'♡'} 좋아요 ${post.like_count}`);like.type='button';like.addEventListener('click',async()=>{if(!requireAccount())return;like.disabled=true;try{const result=await api(`/api/posts/${post.id}/like`,{method:'PUT',body:JSON.stringify({})});await loadDetail();await loadPosts();}catch(e){toast(e.message)}finally{like.disabled=false;}});box.append(like);$('#comments-heading').textContent=`댓글 ${comments.length}`;const list=$('#comments-list');list.replaceChildren();if(!comments.length)list.append(el('p','muted','아직 댓글이 없습니다.'));for(const c of comments){const row=el('div','comment');row.append(el('strong','',c.nickname),el('small','',fmtDate(c.created_at)),el('p','',c.content));list.append(row);}$('#comment-form').elements.post_id.value=post.id;}catch(e){$('#detail-content').replaceChildren(el('p','error',e.message));}}
$('#comment-form').addEventListener('submit',async e=>{e.preventDefault();$('#comment-error').textContent='';if(!requireAccount())return;const form=e.currentTarget;const data=Object.fromEntries(new FormData(form));const id=Number(data.post_id);delete data.post_id;try{await api(`/api/posts/${id}/comments`,{method:'POST',body:JSON.stringify(data)});form.elements.content.value='';toast('댓글이 등록되었습니다.');await loadDetail();await loadPosts();}catch(error){showError('#comment-error',error);}});
refreshAuth().then(async () => {
  await loadPosts();
  try {
    const notice = sessionStorage.getItem(AUTH_NOTICE_KEY);
    if (notice) { sessionStorage.removeItem(AUTH_NOTICE_KEY); toast(notice); }
  } catch (_) {}
}).catch(e => { postsEl.replaceChildren(el('div','empty',`초기화 실패: ${e.message}`)); });
