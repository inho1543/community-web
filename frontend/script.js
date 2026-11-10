const $ = (s) => document.querySelector(s);
const postsEl = $('#posts');
let currentPostId = null;
let currentUser = null;
let csrfToken = '';
let authMode = 'login';
async function refreshAuth(){
  const data=await api('/api/auth/me');
  currentUser=data.user;
  csrfToken=data.csrf;
  $('#account-status').textContent=currentUser?`${currentUser.username}님`:'로그인하지 않음';
  $('#login-button').hidden=!!currentUser;
  $('#logout-button').hidden=!currentUser;
}
function requireAccount(){
  if(currentUser)return true;
  toast('로그인 후 이용해 주세요.');
  $('#auth-dialog').showModal();
  return false;
}
function setAuthMode(mode){
  authMode=mode;
  $('#auth-submit').textContent=mode==='login'?'로그인':'회원가입';
  $('#auth-login-tab').classList.toggle('selected',mode==='login');
  $('#auth-register-tab').classList.toggle('selected',mode==='register');
  $('#auth-form').elements.password.autocomplete=mode==='login'?'current-password':'new-password';
  $('#auth-error').textContent='';
}
$('#login-button').addEventListener('click',()=>{$('#auth-dialog').showModal();setAuthMode('login');});
$('#logout-button').addEventListener('click',async()=>{try{const d=await api('/api/auth/logout',{method:'POST'});currentUser=null;csrfToken=d.csrf;await refreshAuth();await loadPosts();if(currentPostId)await loadDetail();toast('로그아웃했습니다.');}catch(e){toast(e.message)}});
$('#auth-login-tab').addEventListener('click',()=>setAuthMode('login'));
$('#auth-register-tab').addEventListener('click',()=>setAuthMode('register'));
$('#auth-form').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget;try{const data=Object.fromEntries(new FormData(form));const result=await api(`/api/auth/${authMode}`,{method:'POST',body:JSON.stringify(data)});currentUser=result.user;csrfToken=result.csrf;form.reset();$('#auth-dialog').close();await refreshAuth();await loadPosts();if(currentPostId)await loadDetail();toast(`${currentUser.username}님 환영합니다.`);}catch(err){$('#auth-error').textContent=err.message;}});
const fmtDate = (value) => new Date(value).toLocaleString('ko-KR', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
function el(tag, className, text) { const n=document.createElement(tag); if(className)n.className=className; if(text!==undefined)n.textContent=text; return n; }
function toast(msg) { const t=$('#toast'); t.textContent=msg;t.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.style.display='none',2700); }
async function api(path, options={}) { const r=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{}), ...(options.method && options.method !== 'GET' ? {'X-CSRF-Token': csrfToken} : {})}}); let data;try{data=await r.json()}catch{throw Error('서버 응답을 읽을 수 없습니다.')}if(!r.ok)throw Error(data.error||'요청에 실패했습니다.');return data; }
function showError(where, error){ $(where).textContent=error.message||'요청에 실패했습니다.'; }
function openDialog(id){$('#'+id).showModal();}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$('#'+b.dataset.close).close()));
$('#write-button').addEventListener('click',()=>{ if(!requireAccount())return; $('#post-error').textContent='';openDialog('post-dialog'); });
async function loadPosts(){try{const posts=await api('/api/posts');$('#post-count').textContent=`게시글 ${posts.length}개`;postsEl.replaceChildren();if(!posts.length){postsEl.append(el('div','empty','아직 게시글이 없습니다. 첫 번째 글을 작성해 보세요.'));return;}for(const p of posts){const card=el('article','post-card');card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`${p.title} 자세히 보기`);card.append(el('h3','',p.title),el('p','',p.content));const meta=el('div','post-meta');meta.append(el('span','',p.nickname),el('span','',fmtDate(p.created_at)));card.append(meta);const bottom=el('div','post-bottom');bottom.append(el('span','',`♡ 좋아요 ${p.like_count}`),el('span','',`▢ 댓글 ${p.comment_count}`));card.append(bottom);card.addEventListener('click',()=>openPost(p.id));card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPost(p.id);}});postsEl.append(card);}}catch(e){postsEl.replaceChildren(el('div','empty',`게시글 불러오기 실패: ${e.message}`));}}
$('#post-form').addEventListener('submit',async e=>{e.preventDefault();$('#post-error').textContent='';if(!requireAccount())return;const form=e.currentTarget;const data=Object.fromEntries(new FormData(form));try{await api('/api/posts',{method:'POST',body:JSON.stringify(data)});form.reset();$('#post-dialog').close();toast('게시글이 등록되었습니다.');await loadPosts();}catch(error){showError('#post-error',error);}});
async function openPost(id){currentPostId=id;$('#comment-error').textContent='';$('#comment-form').reset();openDialog('detail-dialog');await loadDetail();}
async function loadDetail(){if(!currentPostId)return;try{const [{post,comments},myLike]=await Promise.all([api(`/api/posts/${currentPostId}`),api(`/api/posts/${currentPostId}/my-like`)]);const box=$('#detail-content');box.replaceChildren();box.append(el('h2','detail-title',post.title),el('div','detail-meta',`${post.nickname} · ${fmtDate(post.created_at)}`),el('div','detail-body',post.content));const like=el('button',`like-button ${myLike.liked?'active':''}`,`${myLike.liked?'♥':'♡'} 좋아요 ${post.like_count}`);like.type='button';like.addEventListener('click',async()=>{if(!requireAccount())return;like.disabled=true;try{const result=await api(`/api/posts/${post.id}/like`,{method:'PUT',body:JSON.stringify({})});await loadDetail();await loadPosts();}catch(e){toast(e.message)}finally{like.disabled=false;}});box.append(like);$('#comments-heading').textContent=`댓글 ${comments.length}`;const list=$('#comments-list');list.replaceChildren();if(!comments.length)list.append(el('p','muted','아직 댓글이 없습니다.'));for(const c of comments){const row=el('div','comment');row.append(el('strong','',c.nickname),el('small','',fmtDate(c.created_at)),el('p','',c.content));list.append(row);}$('#comment-form').elements.post_id.value=post.id;}catch(e){$('#detail-content').replaceChildren(el('p','error',e.message));}}
$('#comment-form').addEventListener('submit',async e=>{e.preventDefault();$('#comment-error').textContent='';if(!requireAccount())return;const form=e.currentTarget;const data=Object.fromEntries(new FormData(form));const id=Number(data.post_id);delete data.post_id;try{await api(`/api/posts/${id}/comments`,{method:'POST',body:JSON.stringify(data)});form.elements.content.value='';toast('댓글이 등록되었습니다.');await loadDetail();await loadPosts();}catch(error){showError('#comment-error',error);}});
refreshAuth().then(loadPosts).catch(e=>{postsEl.replaceChildren(el('div','empty',`초기화 실패: ${e.message}`));});
