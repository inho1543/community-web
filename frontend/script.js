const $ = (s) => document.querySelector(s);
const postsEl = $('#posts');
let currentPostId = null;
const visitorIdKey = 'community_visitor_id';
let visitorId = localStorage.getItem(visitorIdKey);
if (!visitorId) {
  visitorId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function')
      ? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(visitorIdKey, visitorId);
}
const likedKey = 'community_likes';
let likedPosts;
try { likedPosts = new Set(JSON.parse(localStorage.getItem(likedKey) || '[]')); } catch { likedPosts = new Set(); }
const rememberLikes = () => localStorage.setItem(likedKey, JSON.stringify([...likedPosts]));
const fmtDate = (value) => new Date(value).toLocaleString('ko-KR', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
function el(tag, className, text) { const n=document.createElement(tag); if(className)n.className=className; if(text!==undefined)n.textContent=text; return n; }
function toast(msg) { const t=$('#toast'); t.textContent=msg;t.style.display='block';clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.style.display='none',2700); }
async function api(path, options={}) { const r=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}}); let data;try{data=await r.json()}catch{throw Error('서버 응답을 읽을 수 없습니다.')}if(!r.ok)throw Error(data.error||'요청에 실패했습니다.');return data; }
function showError(where, error){ $(where).textContent=error.message||'요청에 실패했습니다.'; }
function openDialog(id){$('#'+id).showModal();}
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>$('#'+b.dataset.close).close()));
$('#write-button').addEventListener('click',()=>{ $('#post-error').textContent='';openDialog('post-dialog'); });
async function loadPosts(){try{const posts=await api('/api/posts');$('#post-count').textContent=`게시글 ${posts.length}개`;postsEl.replaceChildren();if(!posts.length){postsEl.append(el('div','empty','아직 게시글이 없습니다. 첫 번째 글을 작성해 보세요.'));return;}for(const p of posts){const card=el('article','post-card');card.tabIndex=0;card.setAttribute('role','button');card.setAttribute('aria-label',`${p.title} 자세히 보기`);card.append(el('h3','',p.title),el('p','',p.content));const meta=el('div','post-meta');meta.append(el('span','',p.nickname),el('span','',fmtDate(p.created_at)));card.append(meta);const bottom=el('div','post-bottom');bottom.append(el('span','',`♡ 좋아요 ${p.like_count}`),el('span','',`▢ 댓글 ${p.comment_count}`));card.append(bottom);card.addEventListener('click',()=>openPost(p.id));card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPost(p.id);}});postsEl.append(card);}}catch(e){postsEl.replaceChildren(el('div','empty',`게시글 불러오기 실패: ${e.message}`));}}
$('#post-form').addEventListener('submit',async e=>{e.preventDefault();$('#post-error').textContent='';const form=e.currentTarget;const data=Object.fromEntries(new FormData(form));try{await api('/api/posts',{method:'POST',body:JSON.stringify(data)});form.reset();$('#post-dialog').close();toast('게시글이 등록되었습니다.');await loadPosts();}catch(error){showError('#post-error',error);}});
async function openPost(id){currentPostId=id;$('#comment-error').textContent='';$('#comment-form').reset();openDialog('detail-dialog');await loadDetail();}
async function loadDetail(){if(!currentPostId)return;try{const {post,comments}=await api(`/api/posts/${currentPostId}`);const box=$('#detail-content');box.replaceChildren();box.append(el('h2','detail-title',post.title),el('div','detail-meta',`${post.nickname} · ${fmtDate(post.created_at)}`),el('div','detail-body',post.content));const like=el('button',`like-button ${likedPosts.has(post.id)?'active':''}`,`${likedPosts.has(post.id)?'♥':'♡'} 좋아요 ${post.like_count}`);like.type='button';like.addEventListener('click',async()=>{like.disabled=true;try{const result=await api(`/api/posts/${post.id}/like`,{method:'PUT',body:JSON.stringify({visitor_id:visitorId})});if(result.liked)likedPosts.add(post.id);else likedPosts.delete(post.id);rememberLikes();await loadDetail();await loadPosts();}catch(e){toast(e.message)}finally{like.disabled=false;}});box.append(like);$('#comments-heading').textContent=`댓글 ${comments.length}`;const list=$('#comments-list');list.replaceChildren();if(!comments.length)list.append(el('p','muted','아직 댓글이 없습니다.'));for(const c of comments){const row=el('div','comment');row.append(el('strong','',c.nickname),el('small','',fmtDate(c.created_at)),el('p','',c.content));list.append(row);}$('#comment-form').elements.post_id.value=post.id;}catch(e){$('#detail-content').replaceChildren(el('p','error',e.message));}}
$('#comment-form').addEventListener('submit',async e=>{e.preventDefault();$('#comment-error').textContent='';const form=e.currentTarget;const data=Object.fromEntries(new FormData(form));const id=Number(data.post_id);delete data.post_id;try{await api(`/api/posts/${id}/comments`,{method:'POST',body:JSON.stringify(data)});form.elements.content.value='';toast('댓글이 등록되었습니다.');await loadDetail();await loadPosts();}catch(error){showError('#comment-error',error);}});
loadPosts();
