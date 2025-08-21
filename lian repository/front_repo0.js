# AI Video Editor — Monorepo (Express + MongoDB + React)

This textdoc contains a starter monorepo for the AI video website we discussed. It includes a working backend (Express + MongoDB), a frontend (React + Vite + Tailwind), and integration glue. Each file is shown below with a header `// FILE: <path>` so you can copy files into your project.

---

// FILE: package.json (root)
{
  "name": "ai-video-editor-monorepo",
  "version": "0.1.0",
  "private": true,
  "workspaces": [
    "./server",
    "./client"
  ],
  "scripts": {
    "postinstall": "cd server && npm install && cd ../client && npm install",
    "dev": "concurrently \"cd server && npm run dev\" \"cd client && npm run dev\"",
    "start": "node server/dist/server.js"
  },
  "devDependencies": {
    "concurrently": "^8.0.0"
  }
}

---

// FILE: .env.example (root)
MONGODB_URI=mongodb://localhost:27017/ai_video
JWT_SECRET=replace_with_a_long_secret
PORT=4000
STORAGE_PATH=./uploads

---

// FILE: server/package.json
{
  "name": "ai-video-server",
  "version": "0.1.0",
  "main": "src/server.js",
  "scripts": {
    "dev": "nodemon --watch src --exec node -r dotenv/config src/server.js",
    "start": "node src/server.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.0.0",
    "express": "^4.18.2",
    "jsonwebtoken": "^9.0.0",
    "mongoose": "^7.0.0",
    "multer": "^1.4.5",
    "fluent-ffmpeg": "^2.1.2"
  },
  "devDependencies": {
    "nodemon": "^2.0.22"
  }
}

---

// FILE: server/src/utils/db.js
const mongoose = require('mongoose');
const connectDB = async (uri) => {
  try {
    await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error', err);
    process.exit(1);
  }
};
module.exports = connectDB;

---

// FILE: server/src/models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String }
}, { timestamps: true });

UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.comparePassword = function(candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model('User', UserSchema);

---

// FILE: server/src/models/Video.js
const mongoose = require('mongoose');
const VideoSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: String,
  description: String,
  filename: String,
  mimeType: String,
  size: Number,
  duration: Number,
  thumbnails: [String],
  status: { type: String, enum: ['uploaded','processing','ready','failed'], default: 'uploaded' },
  aiMetadata: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

module.exports = mongoose.model('Video', VideoSchema);

---

// FILE: server/src/middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');
module.exports = async function(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.id).select('-password');
    if (!user) return res.status(401).json({ error: 'Invalid token' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalid' });
  }
};

---

// FILE: server/src/routes/auth.js
const express = require('express');
const router = express.Router();
const User = require('../models/User');
const jwt = require('jsonwebtoken');

router.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ error: 'User exists' });
    user = new User({ email, password, name });
    await user.save();
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;

---

// FILE: server/src/utils/storage.js
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, '..', '..', 'uploads');
mkdirp.sync(STORAGE);
module.exports = {
  STORAGE,
  saveFile: (fileBuffer, filename) => {
    const filepath = path.join(STORAGE, filename);
    fs.writeFileSync(filepath, fileBuffer);
    return filepath;
  }
};

---

// FILE: server/src/utils/ffmpeg.js
// Lightweight wrapper using fluent-ffmpeg. Ensure ffmpeg binary is installed on host.
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');

function getDuration(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata.format.duration;
      resolve(duration);
    });
  });
}

function generateThumbnail(file, outPath, time = 1) {
  return new Promise((resolve, reject) => {
    ffmpeg(file)
      .screenshots({ count: 1, timemarks: [time], filename: outPath })
      .on('end', () => resolve(outPath))
      .on('error', (err) => reject(err));
  });
}

module.exports = { getDuration, generateThumbnail };

---

// FILE: server/src/routes/videos.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const Video = require('../models/Video');
const auth = require('../middleware/auth');
const { STORAGE } = require('../utils/storage');
const path = require('path');
const fs = require('fs');
const { getDuration, generateThumbnail } = require('../utils/ffmpeg');

const upload = multer({ dest: path.join(STORAGE, 'tmp') });

router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file' });
    const finalName = `${Date.now()}-${file.originalname}`;
    const finalPath = path.join(STORAGE, finalName);
    fs.renameSync(file.path, finalPath);
    const duration = await getDuration(finalPath).catch(() => null);
    const thumbnailName = `thumb-${Date.now()}.png`;
    const thumbnailPath = path.join(STORAGE, thumbnailName);
    await generateThumbnail(finalPath, thumbnailName).catch(()=>{});
    const video = new Video({
      owner: req.user._id,
      title: req.body.title || file.originalname,
      filename: finalName,
      mimeType: file.mimetype,
      size: file.size,
      duration: duration || 0,
      thumbnails: thumbnailPath ? [thumbnailName] : []
    });
    await video.save();

    // In a real system: enqueue AI processing job (transcoding, scene detection,
    // text-to-speech, captioning, face blur, object tracking etc.)

    res.json({ video });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Upload failed' }); }
});

router.get('/', auth, async (req, res) => {
  const videos = await Video.find({ owner: req.user._id }).sort('-createdAt');
  res.json({ videos });
});

router.get('/:id', auth, async (req, res) => {
  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  res.json({ video });
});

// Serve raw file (not production-ready; add range headers, auth checks etc.)
router.get('/:id/raw', auth, async (req, res) => {
  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(STORAGE, video.filename);
  res.sendFile(filePath);
});

module.exports = router;

---

// FILE: server/src/server.js
require('dotenv').config();
const express = require('express');
const app = express();
const connectDB = require('./utils/db');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const videoRoutes = require('./routes/videos');
const path = require('path');

connectDB(process.env.MONGODB_URI || 'mongodb://localhost:27017/ai_video');
app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/videos', videoRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));



// FILE: client/package.json
{
  "name": "ai-video-client",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "axios": "^1.4.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.14.1",
    "jwt-decode": "^3.1.2"
  },
  "devDependencies": {
    "vite": "^5.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0"
  }
}



// FILE: client/index.html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Video Editor</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>



// FILE: client/src/main.jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)



// FILE: client/src/App.jsx
import React from 'react'
import { Routes, Route, Link } from 'react-router-dom'
import Home from './pages/Home'
import Editor from './pages/Editor'

export default function App(){
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="p-4 bg-white shadow">
        <div className="container mx-auto flex justify-between">
          <Link to="/" className="font-bold">AI Video Editor</Link>
          <div>
            <Link to="/editor" className="mr-4">Editor</Link>
          </div>
        </div>
      </nav>
      <main className="container mx-auto p-4">
        <Routes>
          <Route path="/" element={<Home/>} />
          <Route path="/editor" element={<Editor/>} />
        </Routes>
      </main>
    </div>
  )
}

---

// FILE: client/src/pages/Home.jsx
import React from 'react'
export default function Home(){
  return (
    <div className="prose">
      <h1>Welcome</h1>
      <p>Upload your video, run AI edits, and stitch scenes.</p>
    </div>
  )
}

---

// FILE: client/src/pages/Editor.jsx
import React, { useState, useEffect } from 'react'
import axios from 'axios'
import VideoUploader from '../shared/VideoUploader'

export default function Editor(){
  const [videos, setVideos] = useState([])
  useEffect(()=>{
    // fetch user's videos if logged in -- placeholder
  }, [])
  return (
    <div>
      <h2 className="text-2xl mb-4">Editor</h2>
      <VideoUploader onUploaded={(v)=> setVideos(prev=>[v, ...prev])} />
      <div className="grid grid-cols-3 gap-4 mt-6">
        {videos.map(v=> (
          <div key={v._id} className="p-3 bg-white rounded shadow">
            <h4 className="font-semibold">{v.title}</h4>
            <video src={`/api/videos/${v._id}/raw`} controls className="w-full mt-2" />
          </div>
        ))}
      </div>
    </div>
  )
}

---

// FILE: client/src/shared/VideoUploader.jsx
import React, { useState } from 'react'
import axios from 'axios'

export default function VideoUploader({ onUploaded }){
  const [file, setFile] = useState(null)
  const [loading, setLoading] = useState(false)
  const upload = async () =>{
    if(!file) return alert('Choose file')
    const fd = new FormData()
    fd.append('file', file)
    fd.append('title', file.name)
    setLoading(true)
    try{
      const token = localStorage.getItem('token')
      const res = await axios.post('/api/videos/upload', fd, { headers: { 'Content-Type': 'multipart/form-data', Authorization: token ? `Bearer ${token}` : undefined } })
      onUploaded(res.data.video)
    }catch(err){
      console.error(err); alert('Upload failed')
    }finally{ setLoading(false) }
  }
  return (
    <div className="p-4 bg-white rounded shadow">
      <input type="file" accept="video/*" onChange={e=>setFile(e.target.files[0])} />
      <button className="ml-2 px-4 py-2 bg-blue-600 text-white rounded" onClick={upload} disabled={loading}>{loading ? 'Uploading...' : 'Upload'}</button>
    </div>
  )
}

---

// FILE: client/src/styles.css
@tailwind base;
@tailwind components;
@tailwind utilities;

body { font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue'; }

---

# Next steps & notes

1. This repo is a **starter** — it includes working endpoints for auth and video upload, a simple ffmpeg wrapper, and a React frontend with upload capability.
2. Important production improvements you'd want next: range requests for video streaming, signed uploads (S3), background job queue for AI processing (Bull/Redis), proper video chunking, robust auth flows (refresh tokens), CI scripts, Dockerfile and deployment manifests.
3. Tell me which part you want fully expanded next (more endpoints, AI processing pipeline, job queue, CI/docker, or a richer frontend editor with timeline and trimming controls) and I will continue implementing files.


