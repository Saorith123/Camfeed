# CamFeed Security Update — ការណែនាំដាក់ឱ្យប្រើ

## អ្វីដែលបានកែ
1. **ពាក្យសម្ងាត់ត្រូវបាន hash** (scrypt) មិនរក្សាទុកជាអត្ថបទធម្មតាទៀតទេ។ ពាក្យសម្ងាត់ចាស់ត្រូវបានប្តូរដោយស្វ័យប្រវត្តិពេលអ្នកប្រើចូលលើកក្រោយ។
2. **Server លែងផ្ញើ password ត្រឡប់ទៅ browser** (រាល់ JSON ត្រូវបានលុប field `password` ចេញ)។
3. **Token (JWT)**៖ ទាំង Like, Comment, សារ, Follow, Admin... ឥឡូវ server ប្រើអត្តសញ្ញាណពី token មិនមែនពី email ដែល browser ផ្ញើទេ។ ការបន្លំជាអ្នកផ្សេងលែងអាចធ្វើបាន។
4. **ការពារការទាយពាក្យសម្ងាត់**៖ ខុស 8 ដង → រង់ចាំ 15 នាទី។
5. **Admin PIN**៖ លែងមានតម្លៃលំនាំដើមក្នុងកូដ ត្រូវកំណត់ `ADMIN_SECRET_KEY`។
6. ទំព័រ **Settings** (ប្តូរឈ្មោះ / ពាក្យសម្ងាត់ / លុបគណនី) ដំណើរការពិតប្រាកដ (មុននេះ server មិនមាន route ទាំងនេះទេ)។ លុបគណនីលុបទិន្នន័យទាំងអស់ និងឯកសារ R2។
7. ប្តូរពាក្យសម្ងាត់ ឬ Ban → ឧបករណ៍ផ្សេងទៀតត្រូវចូលម្តងទៀតភ្លាម។

## ជំហានដាក់ឱ្យប្រើ
1. **Render → Environment** បន្ថែម៖
   - `JWT_SECRET` = អក្សរចៃដន្យវែង (≥ 32 តួ)
   - `ADMIN_SECRET_KEY` = PIN របស់ Admin
2. ជំនួស `server.js` ហើយបន្ថែម `auth.js` និង `migrate-passwords.js` ក្នុងថតដូចគ្នា (មិនត្រូវការ `npm install` អ្វីថ្មីទេ)។
3. ដាក់ `public/auth-client.js` ហើយក្នុងទំព័រ HTML ទាំង 10 (admin, feed, friends, index, messages, monetization, profile, settings, upload, videos) បន្ថែមមួយបន្ទាត់ភ្លាមក្រោម `<head>`៖
   `<script src="auth-client.js"></script>`
   (ឬជំនួសឯកសារ HTML ទាំងមូលដោយឯកសារក្នុង zip)
4. Deploy។ **អ្នកប្រើទាំងអស់ត្រូវចូលម្តងទៀត 1 ដង** (ធម្មតា)។
5. បន្ទាប់ពី deploy រួច រត់ម្តងគត់៖ `node migrate-passwords.js` (ដើម្បី hash គណនីដែលមិនទាន់ចូល)។

## សាកល្បងមុន (សំខាន់)
ខ្ញុំបានសាកល្បង auth.js និង auth-client.js ដោយស្វ័យប្រវត្តិ ប៉ុន្តែ **មិនទាន់បានរត់ server ទាំងមូលជាមួយ database របស់អ្នកទេ**។ សូមសាកល្បង៖ ចុះឈ្មោះថ្មី, ចូល, បង្ហោះ, Like/Comment, ផ្ញើសារ, ផ្ទុកវីដេអូ, Settings, Admin។

## ត្រឡប់ក្រោយ (rollback)
រក្សា `server.js` ចាស់ទុក។ បើមានបញ្ហា ជំនួសមកវិញ។ ប៉ុន្តែបន្ទាប់ពីរត់ `migrate-passwords.js` ហើយ server ចាស់នឹងចូលមិនបាន (password ត្រូវបាន hash) ដូច្នេះសាកល្បងឱ្យច្បាស់មុនរត់វា។

## មិនទាន់កែ (ជំហានបន្ទាប់)
- XSS៖ escape អត្ថបទអ្នកប្រើក្នុង `innerHTML` (imageModal.js, notification.js, feed...)
- `monetization.html` ហៅ `/api/monetization/*` ដែលមិនមានក្នុង server.js
- Admin លុបអ្នកប្រើមិនទាន់លុប comments/likes/messages ជាប់ទាក់ទង
- `ssl: { rejectUnauthorized: false }` និង `ffmpeg-static` ក្នុង package.json
