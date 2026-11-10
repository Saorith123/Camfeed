// 🎯 មុខងារបង្ហាញ Lightbox Modal ប្លង់បញ្ឈរ (រូបភាពលើ អត្ថបទ និង Comment នៅក្រោម ដូច Facebook ដើម)
function openImageModal(postId, mediaUrl, authorName, authorPic, postContent, createdAt, likesCount, commentsCount) {
    let modal = document.getElementById('fbImageLightboxModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'fbImageLightboxModal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.95); z-index: 9999; display: flex;
            flex-direction: column; overflow-y: auto; backdrop-filter: blur(5px);
        `;
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <!-- Top Navigation Bar ក្នុង Modal (ប៊ូតុងបិទ ✕ និង Menu ចុចបី ⋯) -->
        <div style="position: sticky; top: 0; left: 0; width: 100%; display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; background: rgba(0,0,0,0.6); z-index: 10000; box-sizing: border-box;">
            <button onclick="closeImageModal()" style="background: none; color: white; border: none; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; width: 40px; height: 40px;">✕</button>
            
            <div style="position: relative;">
                <button onclick="toggleImageMenu(event)" style="background: none; color: white; border: none; font-size: 24px; cursor: pointer; display: flex; align-items: center; justify-content: center; width: 40px; height: 40px;">⋮</button>
                <div id="imageDropdownMenu" style="position: absolute; right: 0; top: 45px; background: white; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); width: 180px; display: none; overflow: hidden; font-size: 14px; color: #050505; z-index: 11000;">
                    <a href="${mediaUrl}" download="camfeed-photo.jpg" style="padding: 12px 16px; display: flex; align-items: center; gap: 10px; text-decoration: none; color: #050505;" onclick="closeImageMenu()">📥 Save to phone</a>
                    <div onclick="shareExternalPhoto('${mediaUrl}')" style="padding: 12px 16px; cursor: pointer; display: flex; align-items: center; gap: 10px;" onmouseover="this.style.background='#f2f2f2'" onmouseout="this.style.background='white'">🔗 Share external</div>
                    <div onclick="alert('Photo reported successfully.'); closeImageMenu();" style="padding: 12px 16px; cursor: pointer; display: flex; align-items: center; gap: 10px; color: #fa383e;" onmouseover="this.style.background='#f2f2f2'" onmouseout="this.style.background='white'">⚠️ Report photo</div>
                </div>
            </div>
        </div>

        <!-- Container សម្រាប់បង្ហាញរូបភាព និងផ្នែកអត្ថបទ/Comment នៅផ្នែកខាងក្រោម -->
        <div style="max-width: 680px; width: 100%; margin: 0 auto; display: flex; flex-direction: column; padding-bottom: 50px;">
            <!-- ផ្នែករូបភាពនៅចំកណ្តាល -->
            <div style="display: flex; align-items: center; justify-content: center; padding: 10px 0; background: black;">
                <img src="${mediaUrl}" style="max-width: 100%; max-height: 80vh; object-fit: contain;">
            </div>

            <!-- ផ្នែកព័ត៌មាន Post និង Comment នៅខាងក្រោម -->
            <div style="background: white; border-radius: 8px; margin-top: 10px; padding: 15px;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                    <img src="${authorPic || 'https://via.placeholder.com/40'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">
                    <div>
                        <div style="font-weight: bold; color: #050505; font-size: 14px;">${authorName}</div>
                        <div style="font-size: 11px; color: #65676b;">${createdAt}</div>
                    </div>
                </div>

                <div style="font-size: 15px; color: #1c1e21; margin-bottom: 15px; white-space: pre-wrap;">
                    ${postContent}
                </div>

                <!-- Reactions & Comments Count Bar (អាចចុចមើលបញ្ជីអ្នក Like បាន) -->
                <div style="display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #65676b; padding: 8px 0; border-top: 1px solid #e4e6eb; border-bottom: 1px solid #e4e6eb; cursor: pointer;" onclick="openReactionsList(${postId})">
                    <span>👍 ❤️ <span id="modalLikesCount">${likesCount || 0}</span> Reactions</span>
                    <span>${commentsCount || 0} Comments</span>
                </div>

                <hr style="border: none; border-top: 1px solid #e4e6eb; margin: 15px 0;">

                <!-- Comment List Area -->
                <div id="modalCommentList" style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 15px;">
                    <div style="text-align: center; color: #65676b; font-size: 13px;">Loading comments...</div>
                </div>

                <!-- Input សម្រាប់វាយ Comment បន្ថែម -->
                <div style="display: flex; gap: 8px; padding-top: 10px; border-top: 1px solid #f0f2f5;">
                    <input type="text" id="modalCommentInput" placeholder="Write a comment..." style="flex: 1; padding: 10px 14px; border: 1px solid #dddfe2; border-radius: 20px; outline: none; font-size: 14px;" onkeypress="if(event.key==='Enter') addModalComment(${postId})">
                    <button onclick="addModalComment(${postId})" style="background: #1877f2; color: white; border: none; border-radius: 20px; padding: 0 20px; font-weight: bold; cursor: pointer; font-size: 14px;">Send</button>
                </div>
            </div>
        </div>

        <!-- 🎯 Reactions List Bottom Sheet Modal (បង្ហាញអ្នក Like ទាំងអស់) -->
        <div id="reactionsBottomSheet" style="position: fixed; bottom: 0; left: 0; width: 100%; height: 60vh; background: white; border-radius: 20px 20px 0 0; box-shadow: 0 -4px 20px rgba(0,0,0,0.2); display: none; flex-direction: column; z-index: 10500; color: #050505;">
            <div style="text-align: center; padding: 10px; cursor: pointer; color: #65676b;" onclick="closeReactionsList()">➖</div>
            <div style="padding: 0 15px 10px 15px; border-bottom: 1px solid #e4e6eb; font-weight: bold; font-size: 14px;">Reactions (<span id="sheetTotalLikes">0</span>)</div>
            <div id="reactionsUserContainer" style="flex: 1; overflow-y: auto; padding: 10px 15px; display: flex; flex-direction: column; gap: 12px;">
                <!-- User list dynamically loaded here -->
            </div>
        </div>
    `;

    modal.style.display = 'flex';
    loadModalComments(postId);
}

// មុខងារបើកផ្ទាំងអ្នក Like (Reactions Sheet)
async function openReactionsList(postId) {
    const sheet = document.getElementById('reactionsBottomSheet');
    if (sheet) sheet.style.display = 'flex';

    try {
        const res = await fetch(`/api/posts/${postId}/reactions`);
        const data = await res.json();
        if (data.success) {
            const container = document.getElementById('reactionsUserContainer');
            document.getElementById('sheetTotalLikes').innerText = data.reactions.length;
            
            if (data.reactions.length === 0) {
                container.innerHTML = '<p style="text-align:center; color:#65676b;">No reactions yet.</p>';
                return;
            }

            container.innerHTML = data.reactions.map(u => `
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="display: flex; align-items: center; gap: 10px; cursor: pointer;" onclick="window.location.href='profile.html?email=${u.email}'">
                        <img src="${u.profile_pic || 'https://via.placeholder.com/40'}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;">
                        <div>
                            <div style="font-weight: bold; font-size: 14px; color: #050505;">${u.first_name} ${u.last_name}</div>
                            <div style="font-size: 11px; color: #65676b;">${u.mutual_friends || '1 mutual friend'}</div>
                        </div>
                    </div>
                    <button style="background: #1877f2; color: white; border: none; border-radius: 6px; padding: 6px 14px; font-weight: bold; font-size: 12px; cursor: pointer;">Add friend</button>
                </div>
            `).join('');
        }
    } catch (err) { console.error(err); }
}

function closeReactionsList() {
    const sheet = document.getElementById('reactionsBottomSheet');
    if (sheet) sheet.style.display = 'none';
}

// មុខងារបើក/បិទ Menu សញ្ញាចុចបី (...)
function toggleImageMenu(event) {
    event.stopPropagation();
    const menu = document.getElementById('imageDropdownMenu');
    if (menu) {
        menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
    }
}

function closeImageMenu() {
    const menu = document.getElementById('imageDropdownMenu');
    if (menu) menu.style.display = 'none';
}

// មុខងារ Share External (Copy Link រូបភាព)
function shareExternalPhoto(mediaUrl) {
    closeImageMenu();
    const fullUrl = `${window.location.origin}${mediaUrl}`;
    navigator.clipboard.writeText(fullUrl).then(() => {
        alert('Image link copied to clipboard!');
    });
}

// មុខងារបិទ Modal
function closeImageModal() {
    const modal = document.getElementById('fbImageLightboxModal');
    if (modal) {
        modal.style.display = 'none';
    }
}

// ទាញយក Comments មកបង្ហាញក្នុង Modal
async function loadModalComments(postId) {
    try {
        const res = await fetch(`/api/comments/${postId}`);
        const data = await res.json();
        if (data.success) {
            const list = document.getElementById('modalCommentList');
            if (!list) return;
            if (data.comments.length === 0) {
                list.innerHTML = '<p style="text-align:center; color:#65676b; font-size:13px;">No comments yet.</p>';
                return;
            }
            list.innerHTML = data.comments.map(c => `
                <div style="display: flex; gap: 8px; font-size: 13px;">
                    <img src="${c.profile_pic || 'https://via.placeholder.com/32'}" style="width: 32px; height: 32px; border-radius: 50%; object-fit: cover;">
                    <div style="background: #f0f2f5; padding: 8px 12px; border-radius: 16px; max-width: 85%;">
                        <span style="font-weight: bold; display: block; font-size: 12.5px; color: #050505;">${c.first_name} ${c.last_name}</span>
                        <div style="color: #050505;">${c.content}</div>
                    </div>
                </div>
            `).join('');
        }
    } catch (err) { console.error(err); }
}

// បន្ថែម Comment ថ្មីក្នុង Modal
async function addModalComment(postId) {
    const input = document.getElementById('modalCommentInput');
    if (!input || !input.value.trim()) return;
    const content = input.value;
    const currentUser = JSON.parse(localStorage.getItem('camfeed_user'));

    await fetch('/api/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId, email: currentUser.email, content })
    });
    input.value = '';
    loadModalComments(postId);
}