// 🎯 មុខងារទាញយក និងគ្រប់គ្រង Notifications
async function loadNotifications() {
    const currentUser = JSON.parse(localStorage.getItem('camfeed_user'));
    if (!currentUser) return;

    try {
        const res = await fetch(`/api/notifications?email=${currentUser.email}`);
        const data = await res.json();
        if (data.success) {
            const badge = document.getElementById('notifBadge');
            const list = document.getElementById('notifList');
            const notifs = data.notifications;

            if (notifs.length > 0) {
                if (badge) {
                    badge.innerText = notifs.length;
                    badge.classList.remove('hidden');
                }
                if (list) {
                    list.innerHTML = notifs.map(n => {
                        // កំណត់ទិសដៅពេលចុចលើ Notification (ຖ້າມี post_id ឱ្យរត់ទៅ jumpToComment)
                        let clickAction = n.post_id ? `jumpToComment(${n.post_id}, ${n.comment_id || 0})` : `window.location.href='profile.html?email=${n.sender_email}'`;
                        return `
                            <div class="notification-item" onclick="${clickAction}; event.stopPropagation();">
                                <img src="${n.profile_pic || 'https://via.placeholder.com/35'}" style="width:35px; height:35px; border-radius:50%; object-fit:cover;">
                                <div>
                                    <div style="color: #050505;">${n.message}</div>
                                    <div style="font-size: 10px; color: #90949c; margin-top: 2px;">${new Date(n.created_at).toLocaleString()}</div>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            } else {
                if (list) list.innerHTML = `<div style="padding: 15px; text-align: center; color: #65676b; font-size: 13px;">No notifications yet</div>`;
            }
        }
    } catch (err) { console.error(err); }
}

// 🎯 មុខងាររត់ទៅរក Post និង Comment គោលដៅ ពេលចុចលើ Notification
async function jumpToComment(postId, commentId) {
    const notifDropdown = document.getElementById('notifDropdown');
    if (notifDropdown) notifDropdown.style.display = 'none';
    
    // បើក Tab Feed ឡើងវិញបើកស្ថិតនៅ tab ផ្សេង
    if (typeof switchTab === 'function') {
        switchTab('feed');
    }

    // ទាញយក Post នោះមកបង្ហាញដាច់ដោយឡែក ឬផ្ទុកក្នុង Feed
    const currentUser = JSON.parse(localStorage.getItem('camfeed_user'));
    try {
        const res = await fetch(`/api/posts/${postId}?email=${currentUser.email}`);
        const data = await res.json();
        if (data.success && data.post) {
            if (typeof renderPosts === 'function') {
                renderPosts([data.post], 'postsContainer');
            }
        }
    } catch (err) { console.error(err); }

    // រង់ចាំបន្តិចឱ្យ DOM Render រួច ទើប Scroll ចំគោលដៅ
    setTimeout(() => {
        const postElem = document.getElementById(`post-${postId}`);
        if (postElem) {
            postElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
            postElem.classList.add('highlight-post');
            setTimeout(() => postElem.classList.remove('highlight-post'), 2500);

            // បើក Comment Section ឱ្យលេចចេញមក
            const sec = document.getElementById(`commentsSection-${postId}`);
            if (sec && sec.classList.contains('hidden')) {
                if (typeof toggleCommentBox === 'function') {
                    toggleCommentBox(postId);
                }
            }

            // ប្រសិនបើមាន commentId ឱ្យរត់ទៅ Highlight Comment នោះ
            if (commentId && commentId !== 0) {
                setTimeout(() => {
                    const bubble = document.getElementById(`bubble-${commentId}`);
                    if (bubble) {
                        bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        bubble.classList.add('highlight-comment');
                        setTimeout(() => bubble.classList.remove('highlight-comment'), 3000);
                    }
                }, 500);
            }
        }
    }, 400);
}