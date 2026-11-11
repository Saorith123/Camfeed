const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
require('dotenv').config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'camfeed_uploads',
    resource_type: 'auto',
    // 🎯 បន្ថែម webm, ogg, wav ចូលទីនេះ ដើម្បីអនុញ្ញាតឱ្យ Cloudinary ទទួលយកសារសំឡេង (Voice Messages)
    allowed_formats: ['jpg', 'png', 'jpeg', 'mp4', 'mov', 'webm', 'ogg', 'wav', 'mp3']
  }
});

const upload = multer({ storage: storage });

module.exports = { cloudinary, upload };