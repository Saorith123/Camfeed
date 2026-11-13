// 🎯 មុខងារទាញយក និងគ្រប់គ្រង Notifications (រាប់តែសារមិនទាន់អាន + Deep-Link ទៅកាន់ Profile/Video/Post/Comment)
async function loadNotifications() {
    const currentUser = JSON.parse(localStorage.getItem('camfeed_user'));
    if (!currentUser) return;

    try {
        const res = await fetch(`/api/notifications?email=${encodeURIComponent(currentUser.email)}`);
        const data = await res.json();
        if (data.success) {
            const badge = document.getElementById('notifBadge');
            const list = document.getElementById('notifList');
            const notifs = data.notifications || [];

            // រាប់តែចំនួន Notification ដែលមិនទាន់អាន (is_read === false)
            const unreadCount = notifs.filter(n => !n.is_read).length;

            if (badge) {
                if (unreadCount > 0) {
                    badge.innerText = unreadCount;
                    badge.classList.remove('hidden');
                } else {
                    badge.innerText = '0';
                    badge.classList.add('hidden');
                }
            }

            if (list) {
                if (notifs.length === 0) {
                    list.innerHTML = `<div id="notifEmptyText" style="padding: 15px; text-align: center; color: #65676b; font-size: 13px;">មិនទាន់មានការជូនដំណឹងនៅឡើយទេ</div>`;
                    return;
                }

                list.innerHTML = notifs.map(n => {
                    const isUnread = !n.is_read;
                    const bgStyle = isUnread ? 'background-color: #e7f3ff; font-weight: 600;' : 'background-color: #ffffff;';
                    const mediaType = n.post_media_type || '';
                    const clickAction = n.post_id
                        ? `openNotificationTarget(${n.id}, ${n.post_id}, ${n.comment_id || 0}, '${mediaType}')`
                        : `openSenderProfileFromNotif(${n.id}, '${encodeURIComponent(n.sender_email)}')`;

                    return `
                        <div class="notification-item" style="${bgStyle}" onclick="${clickAction}; event.stopPropagation();">
                            <img src="${n.profile_pic || 'https://via.placeholder.com/38'}"
                                 class="notif-avatar"
                                 title="ចុចដើម្បីមើល Profile របស់ ${esc(n.first_name || '')}"
                                 style="width:38px; height:38px; border-radius:50%; object-fit:cover; flex-shrink:0;"
                                 onclick="event.stopPropagation(); openSenderProfileFromNotif(${n.id}, '${encodeURIComponent(n.sender_email)}')">
                            <div style="flex: 1;">
                                <div style="color: #050505; line-height: 1.35;">${esc(n.message)}</div>
                                <div style="font-size: 10.5px; color: ${isUnread ? '#1877f2' : '#90949c'}; margin-top: 3px;">
                                    ${new Date(n.created_at).toLocaleString()} ${isUnread ? '· ថ្មី' : ''}
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }
    } catch (err) {
        console.error('Error loading notifications:', err);
    }
}

// 🎯 សម្គាល់ថាបានអាន Notification ទាំងអស់ ពេលចុចបើកកណ្ដឹង 🔔 (លេខក្រហមនឹងបាត់ភ្លាម ហើយមិនលោតទៀតពេល Reload)
async function markAllNotificationsAsRead() {
    const currentUser = JSON.parse(localStorage.getItem('camfeed_user'));
    if (!currentUser) return;

    const badge = document.getElementById('notifBadge');
    if (badge) {
        badge.innerText = '0';
        badge.classList.add('hidden');
    }

    try {
        await fetch('/api/notifications/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentUser.email })
        });
    } catch (err) {
        console.error(err);
    }
}

// ភ្ជាប់ជាមួយប៊ូតុងកណ្ដឹង 🔔 នៅលើ Top Bar
function toggleNotifications(event) {
    if (event) event.stopPropagation();
    const menuDrop = document.getElementById('menuDropdown');
    if (menuDrop) menuDrop.style.display = 'none';

    const dropdown = document.getElementById('notifDropdown');
    if (!dropdown) return;

    const willOpen = dropdown.style.display !== 'block';
    dropdown.style.display = willOpen ? 'block' : 'none';

    if (willOpen) {
        markAllNotificationsAsRead();
    }
}

// ចុចលើរូប Profile ក្នុង Notification -> បើកទំព័រ Profile របស់អ្នកផ្ញើ
async function openSenderProfileFromNotif(notifId, encodedEmail) {
    const currentUser = JSON.parse(localStorage.getItem('camfeed_user'));
    if (currentUser && notifId) {
        fetch('/api/notifications/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentUser.email, notificationId: notifId })
        }).catch(() => {});
    }
    window.location.href = `profile.html?email=${encodedEmail}`;
}

// 🎯 ចុចលើខ្លឹមសារ Notification -> រត់ចូលទៅបើក Video ឬ Post & Comment គោលដៅផ្ទាល់
async function openNotificationTarget(notifId, postId, commentId, mediaType) {
    const currentUser = JSON.parse(localStorage.getItem('camfeed_user'));
    const notifDropdown = document.getElementById('notifDropdown');
    if (notifDropdown) notifDropdown.style.display = 'none';

    if (currentUser && notifId) {
        fetch('/api/notifications/mark-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: currentUser.email, notificationId: notifId })
        }).catch(() => {});
    }

    // ប្រសិនបើកំពុងនៅទំព័រផ្សេងក្រៅពី feed.html ឱ្យបញ្ជូនទៅ feed.html?post=ID&comment=CID
    const isOnFeedPage = window.location.pathname.includes('feed.html') || window.location.pathname === '/' || window.location.pathname.endsWith('/');
    if (!isOnFeedPage) {
        window.location.href = `feed.html?post=${postId}${commentId ? `&comment=${commentId}` : ''}`;
        return;
    }

    // ពិនិត្យមើលថា Post នោះមាននៅលើអេក្រង់ស្រាប់ឬអត់ បើមិនទាន់មាន ទាញមកដាក់ខាងលើគេ
    let postElem = document.getElementById(`post-${postId}`);
    if (!postElem && currentUser) {
        try {
            const res = await fetch(`/api/posts/${postId}?email=${encodeURIComponent(currentUser.email)}`);
            const data = await res.json();
            if (data.success && data.post && typeof renderPosts === 'function') {
                renderPosts([data.post], 'postsContainer', postId);
            }
        } catch (err) { console.error(err); }
    }

    setTimeout(() => {
        postElem = document.getElementById(`post-${postId}`);
        if (postElem) {
            document.querySelectorAll('.post-item').forEach(p => p.classList.remove('highlight-target'));
            postElem.classList.add('highlight-target');
            postElem.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // បើមាន commentId ឬជាប្រភេទមតិយោបល់ ឱ្យបើកប្រអប់ Comment និង Highlight Comment នោះ
            if (commentId && commentId !== 0) {
                const sec = document.getElementById(`commentsSection-${postId}`);
                if (sec && !sec.classList.contains('open') && typeof toggleCommentBox === 'function') {
                    toggleCommentBox(postId);
                }
                setTimeout(() => {
                    const commentEl = document.getElementById(`comment-${commentId}`);
                    if (commentEl) {
                        commentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        commentEl.style.backgroundColor = '#e7f3ff';
                        commentEl.style.borderRadius = '12px';
                        setTimeout(() => { commentEl.style.backgroundColor = ''; }, 3000);
                    }
                }, 500);
            }
        }
    }, 300);
}