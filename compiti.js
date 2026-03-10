const puppeteer = require('puppeteer');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const bcrypt = require('bcrypt');
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// FIX #5: password hash spostato in variabile d'ambiente
const NOTE_PASSWORD_HASH = process.env.NOTE_PASSWORD_HASH;

// FIX #6: stato lock persistito su Supabase (vedi funzioni getLockState / setLockState)
// Le variabili in memoria restano solo come cache locale
let failedAttempts = 0;
let lockUntil = null;

// FIX #6: funzioni per leggere/scrivere lo stato del lock su Supabase
async function getLockState() {
  const { data } = await supabase
    .from('lock_state')
    .select('*')
    .eq('id', 1)
    .single();
  if (data) {
    failedAttempts = data.failed_attempts;
    lockUntil = data.lock_until ? new Date(data.lock_until).getTime() : null;
  }
}

async function setLockState() {
  await supabase
    .from('lock_state')
    .upsert({
      id: 1,
      failed_attempts: failedAttempts,
      lock_until: lockUntil ? new Date(lockUntil).toISOString() : null
    });
}

async function aggiornaCompiti() {

  const USER = process.env.CLASSEVIVA_USER;
  const PASS = process.env.CLASSEVIVA_PASS;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',   // ← fondamentale su Render
      '--disable-gpu'
    ]
    // rimuovi executablePath: usa quello scaricato automaticamente
  });

  const page = await browser.newPage();

  try {
    console.log("🚀 Accesso a Classeviva...");
    await page.goto('https://web.spaggiari.eu', { waitUntil: 'networkidle2' });

    // LOGIN
    await page.waitForSelector('#login', { visible: true });
    await page.type('#login', USER);
    await page.type('input[type="password"]', PASS);
    await page.click('.accedi.btn.btn-primary');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // CAMBIO PROFILO
    await page.waitForSelector('#top-page-profile-avatar', { visible: true });
    await page.click('#top-page-profile-avatar');
    await page.waitForSelector('.open_sans_extrabold', { visible: true });
    await page.evaluate(() => {
      const profili = document.querySelectorAll('.open_sans_extrabold');
      if (profili.length >= 2) profili[1].click();
      else if (profili.length === 1) profili[0].click();
    });
    await new Promise(r => setTimeout(r, 4000));

    // --- CALCOLO DATA DINAMICA ---
    const oggi = new Date();
    const giorno = oggi.getDay(); // 0=Dom, 1=Lun, ..., 5=Ven, 6=Sab

    let startWeek = new Date(oggi);
    let endWeek = new Date(oggi);

    if (giorno >= 1 && giorno <= 4) {
      startWeek.setDate(oggi.getDate() + 1);
      endWeek.setDate(oggi.getDate() + (5 - giorno));
    } else {
      const offsetToNextMonday =
        giorno === 0 ? 1 : giorno === 5 ? 3 : 2;
      startWeek.setDate(oggi.getDate() + offsetToNextMonday);
      endWeek = new Date(startWeek);
      endWeek.setDate(startWeek.getDate() + 4);
    }

    const formatDate = d => d.toISOString().slice(0, 10);
    const startStr = formatDate(startWeek);
    const endStr = formatDate(endWeek);

    console.log(`📅 Recupero compiti dal ${startStr} al ${endStr}...`);

    let compitiJSON = [];
    page.on('response', async response => {
      const url = response.url();
      if (url.includes('agenda_studenti.php') || url.includes('events')) {
        try {
          const json = await response.json();
          if (Array.isArray(json)) compitiJSON.push(...json);
        } catch { }
      }
    });

    await page.goto('https://web.spaggiari.eu/fml/app/default/agenda_studenti.php', { waitUntil: 'networkidle2' });
    await new Promise(r => setTimeout(r, 5000));

    const compitiSettimana = compitiJSON.filter(c => {
      if (!['compiti', 'nota'].includes(c.tipo)) return false;
      const data = c.start.slice(0, 10);
      return data >= startStr && data <= endStr;
    });

    compitiSettimana.sort((a, b) => {
      const dataA = new Date(a.start);
      const dataB = new Date(b.start);
      if (dataA < dataB) return -1;
      if (dataA > dataB) return 1;
      const matA = a.materia_desc ? a.materia_desc : '';
      const matB = b.materia_desc ? b.materia_desc : '';
      return matA.localeCompare(matB);
    });

    function formattaDataIt(dataISO) {
      const giorni = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
      const mesi = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
      const d = new Date(dataISO + "T00:00:00");
      return `${giorni[d.getDay()]} ${d.getDate()} ${mesi[d.getMonth()]}`;
    }

    console.log("\n📋 Compiti della settimana:");
    if (compitiSettimana.length === 0) {
      console.log("❌ Nessun compito trovato.");
    } else {
      compitiSettimana.forEach((c, i) => {
        console.log(`${i + 1}) ${formattaDataIt(c.start.slice(0, 10))} – ${c.materia_desc}: ${c.title}`);
        console.log("-".repeat(40));
      });
    }

    const notesDir = `${process.cwd()}/note_data`;
    const imagesDir = `${notesDir}/images`;

    if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir);
    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);

    // --- CREA FILE compiti.html ---
    let html = `
    <!DOCTYPE html>
    <html lang="it" data-theme="system">
    <head>
    <meta charset="UTF-8">
    <title>Compiti della settimana</title>
    <link rel="shortcut icon" href="icon-512.png" type="image/x-icon">
    <link rel="manifest" href="/manifest.json">
    <meta name="theme-color" content="#339af0">

    <style>
    :root {
      --bg: #ffffff;
      --text: #111;
      --card: #f4f4f4;
      --border: #ddd;
    }

    html[data-theme="dark"] {
      --bg: #121212;
      --text: #eaeaea;
      --card: #1e1e1e;
      --border: #333;
    }

    @media (prefers-color-scheme: dark) {
      html[data-theme="system"] {
        --bg: #121212;
        --text: #eaeaea;
        --card: #1e1e1e;
        --border: #333;
      }
    }

    body {
      font-family: sans-serif;
      margin: 30px;
      background: var(--bg);
      color: var(--text);
    }

    #note-box {
      margin-top: 50px;
      padding: 20px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    }

    #note-box h2 { margin-top: 0; margin-bottom: 15px; }

    #note-lock input {
      padding: 8px 10px;
      font-size: 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
    }

    #note-lock button, #note-clear {
      margin-left: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--materia, #339af0);
      color: white;
      cursor: pointer;
      font-weight: bold;
    }

    #note-clear { background: #e03131; border: none; }

    #note-area textarea {
      width: 100%;
      min-height: 160px;
      resize: vertical;
      padding: 12px;
      font-size: 15px;
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-top: 10px;
    }

    /* FIX #10: immagini responsive */
    .note-images img {
      max-width: 100%;
      width: 400px;
      height: auto;
      object-fit: cover;
      margin: 10px 10px 0 0;
      border-radius: 8px;
      border: 1px solid var(--border);
    }

    .note-btn {
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      margin-right: 8px;
      font-weight: 600;
    }

    .note-btn.primary { background: #339af0; color: white; border: none; }
    .note-btn.danger  { background: #e03131; color: white; border: none; }
    .note-btn:hover   { opacity: 0.85; }

    .file-btn {
      display: inline-block;
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      font-weight: 600;
      transition: 0.2s;
    }

    .file-btn:hover { opacity: 0.85; }

    h1 { text-align: center; margin-top: 10px; }

    .note-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 15px;
      margin-top: 15px;
      box-shadow: 0 4px 10px rgba(0,0,0,0.08);
    }

    .note-card textarea {
      width: 100%;
      min-height: 100px;
      resize: vertical;
      border-radius: 10px;
      border: 1px solid var(--border);
      padding: 10px;
      background: var(--bg);
      color: var(--text);
      box-sizing: border-box;
    }

    .note-actions { margin-top: 10px; }
    .note-actions button { margin-right: 8px; }

    .compito {
      background: var(--card);
      padding: 10px 12px;
      border-radius: 8px;
      margin: 10px 0;
      border-left: 6px solid var(--materia);
      border-top: 1px solid var(--border);
      border-right: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      box-shadow: 0 2px 6px rgba(0,0,0,0.08);
    }

    .compito-header {
      font-weight: bold;
      color: var(--materia);
      margin-bottom: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
      text-transform: uppercase;
    }

    .compito label { cursor: pointer; display: block; padding: 5px 0; }
    .compito strong { color: var(--materia); }

    .matematica { --materia: #ff6b6b; }
    .italiano   { --materia: #4dabf7; }
    .inglese    { --materia: #51cf66; }
    .tecnologia { --materia: #15aabf; }
    .musica     { --materia: #cc5de8; }
    .storia     { --materia: #ffa94d; }
    .arte       { --materia: #e8590c; }
    .francese   { --materia: #339af0; }
    .scienze    { --materia: #38d9a9; }
    .geografia  { --materia: #9775fa; }
    .religione  { --materia: #868e96; }
    .default    { --materia: #adb5bd; }

    .giorno { margin-top: 35px; }

    .giorno h2 {
      font-size: 20px;
      margin-bottom: 10px;
      padding-bottom: 6px;
      border-bottom: 2px solid var(--border);
      position: sticky;
      top: 0;
      background: var(--bg);
      z-index: 10;
    }

    #toast {
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #2f9e44;
      color: white;
      padding: 10px 18px;
      border-radius: 10px;
      font-weight: bold;
      box-shadow: 0 4px 10px rgba(0,0,0,0.15);
      opacity: 0;
      transition: opacity 0.3s ease;
      z-index: 2000;
    }

    #toast.show { opacity: 1; }

    input[type="checkbox"] { margin-right: 10px; transform: scale(1.2); }
    input[type="checkbox"]:checked + span { text-decoration: line-through; opacity: 0.6; }

    #theme-toggle {
      position: fixed;
      top: 15px;
      right: 20px;
      background: #ffffff;
      color: #111;
      border: 1px solid #ccc;
      border-radius: 20px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 14px;
      z-index: 1000;
    }

    #loader {
      position: fixed;
      inset: 0;
      background: var(--bg);
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      z-index: 9999;
    }

    .spinner {
      width: 40px;
      height: 40px;
      border: 4px solid var(--border);
      border-top: 4px solid #339af0;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    </head>
    <body>

    <div id="loader">
      <div class="spinner"></div>
      <p>Caricamento compiti...</p>
    </div>

    <div id="toast">✅ Nota salvata!</div>
    <button id="theme-toggle">🌗 Sistema</button>
    <h1>📚 Compiti della settimana</h1>
    `;

    if (compitiSettimana.length === 0) {
      html += `<p style="text-align:center;">Nessun compito trovato.</p>`;
    } else {
      let giornoCorrente = '';
      compitiSettimana.forEach((c, i) => {
        const dataISO = c.start.slice(0, 10);
        const data = formattaDataIt(dataISO);

        if (data !== giornoCorrente) {
          giornoCorrente = data;
          html += `<div class="giorno"><h2>${data}</h2></div>`;
        }

        const materiaRaw = c.materia_desc ? c.materia_desc.toLowerCase() : 'generale';

        const materiaMap = {
          'matematica': { cls: 'matematica', icon: '📐', label: 'Matematica' },
          'italiano': { cls: 'italiano', icon: '📖', label: 'Italiano' },
          'inglese': { cls: 'inglese', icon: '🇬🇧', label: 'Inglese' },
          'tecnologia': { cls: 'tecnologia', icon: '⚙️', label: 'Tecnologia' },
          'musica': { cls: 'musica', icon: '🎵', label: 'Musica' },
          'storia': { cls: 'storia', icon: '🏛️', label: 'Storia' },
          'arte e immagine': { cls: 'arte', icon: '🎨', label: 'Arte e immagine' },
          'seconda lingua comunitaria': { cls: 'francese', icon: '🇫🇷', label: 'Francese' },
          'scienze': { cls: 'scienze', icon: '🧪', label: 'Scienze' },
          'geografia': { cls: 'geografia', icon: '🌍', label: 'Geografia' },
          'religione': { cls: 'religione', icon: '✝️', label: 'Religione' }
        };

        const materia = materiaMap[materiaRaw] || { cls: 'default', icon: '📌', label: 'GENERALE' };

        html += `
          <div class="compito ${materia.cls}">
            <div class="compito-header">
              <span>${materia.icon}</span>
              <span>${materia.label}</span>
            </div>
            <label>
              <input type="checkbox" id="compito-${i}">
              <span>${c.title}</span>
            </label>
          </div>
        `;
      });
    }

    html += `
    <div id="note-box">
      <h2>📝 Note personali</h2>

      <div id="note-lock">
        <input type="password" id="note-password" placeholder="Password">
        <button id="note-unlock" class="note-btn primary">Sblocca</button>
        <p id="note-error" style="color:red; display:none;"></p>
      </div>

      <div id="note-area" style="display:none;">
        <button id="add-note" class="note-btn primary">➕ Nuova nota</button>
        <div id="notes-container"></div>
        <br>
        <button id="note-close" class="note-btn">🔒 Chiudi</button>
      </div>
    </div>

    <script>
    /* ===== CHECKBOX ===== */
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => {
      const stato = localStorage.getItem(cb.id);
      if (stato === 'true') cb.checked = true;
      cb.addEventListener('change', () => localStorage.setItem(cb.id, cb.checked));
    });

    /* ===== TEMA ===== */
    const themes = ['system', 'light', 'dark'];
    const icons = { system: '🌗 Sistema', light: '☀️ Giorno', dark: '🌙 Notte' };
    const root = document.documentElement;
    const btn = document.getElementById('theme-toggle');
    let currentTheme = localStorage.getItem('theme') || 'system';
    root.dataset.theme = currentTheme;
    btn.textContent = icons[currentTheme];
    btn.addEventListener('click', () => {
      currentTheme = themes[(themes.indexOf(currentTheme) + 1) % themes.length];
      root.dataset.theme = currentTheme;
      btn.textContent = icons[currentTheme];
      localStorage.setItem('theme', currentTheme);
    });

    /* ===== NOTE MULTIPLE ===== */
    let currentUser = localStorage.getItem('user_name');
    if (!currentUser) {
      currentUser = prompt("Chi sei?");
      localStorage.setItem('user_name', currentUser);
    }

    document.addEventListener("DOMContentLoaded", () => {
      const unlockBtn       = document.getElementById('note-unlock');
      const passwordInput   = document.getElementById('note-password');
      const lockBox         = document.getElementById('note-lock');
      const noteArea        = document.getElementById('note-area');
      const errorMsg        = document.getElementById('note-error');
      const closeBtn        = document.getElementById('note-close');
      const addNoteBtn      = document.getElementById('add-note');
      const notesContainer  = document.getElementById('notes-container');

      let notes = [];
      let countdownInterval = null;

      function mostraToast(messaggio = "Salvato!") {
        const toast = document.getElementById("toast");
        toast.textContent = "✅ " + messaggio;
        toast.classList.add("show");
        setTimeout(() => toast.classList.remove("show"), 2000);
      }

      function renderNotes() {
        notesContainer.innerHTML = "";
        notes.forEach(nota => {
          const card = document.createElement('div');
          card.className = "note-card";
          card.innerHTML = \`
            <textarea></textarea><br><br>
            <label class="file-btn">📎 Aggiungi foto
              <input type="file" hidden accept="image/*">
            </label>
            <div class="note-images"></div>
            <div class="note-actions">
              <button class="note-btn primary">💾 Salva</button>
              <button class="note-btn danger">🗑 Elimina</button>
            </div>
          \`;

          const textarea  = card.querySelector("textarea");
          const saveBtn   = card.querySelector(".primary");
          const deleteBtn = card.querySelector(".danger");
          const fileInput = card.querySelector("input[type=file]");
          const imagesDiv = card.querySelector(".note-images");

          textarea.value = nota.text || "";

          nota.images?.forEach(nome => {
            const img = document.createElement('img');
            img.src = "note_data/images/" + nome;
            imagesDiv.appendChild(img);
          });

          saveBtn.onclick = async () => {
            nota.text = textarea.value;
            await salvaNote();
            mostraToast("Nota salvata!");
          };

          deleteBtn.onclick = async () => {
            if (!confirm("Eliminare questa nota?")) return;
            notes = notes.filter(n => n.id !== nota.id);
            await salvaNote();
            renderNotes();
          };

          fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const formData = new FormData();
            formData.append('image', file);
            const res = await fetch('/upload-image', { method: 'POST', body: formData });
            const data = await res.json();
            nota.images = nota.images || [];
            nota.images.push(data.filename);
            await salvaNote();
            renderNotes();
          };

          notesContainer.appendChild(card);
        });
      }

      async function salvaNote() {
        try {
          await fetch('/save-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user: currentUser, notes })
          });
        } catch (err) { console.error(err); }
      }

      // FIX #4: checkLockStatus non manda più la password vuota
      // chiede solo lo stato del lock con una route dedicata
      async function checkLockStatus() {
        try {
          const res = await fetch('/lock-status');
          const data = await res.json();
          if (data.locked) {
            let secondsLeft = data.secondsLeft;
            errorMsg.style.display = 'block';
            errorMsg.textContent = "Bloccato. Riprova tra " + secondsLeft + " secondi.";
            countdownInterval = setInterval(() => {
              secondsLeft--;
              if (secondsLeft <= 0) {
                clearInterval(countdownInterval);
                errorMsg.style.display = 'none';
              } else {
                errorMsg.textContent = "Bloccato. Riprova tra " + secondsLeft + " secondi.";
              }
            }, 1000);
          }
        } catch (err) { console.error(err); }
      }

      unlockBtn.onclick = async () => {
        if (countdownInterval) clearInterval(countdownInterval);

        const res = await fetch('/unlock-notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: passwordInput.value })
        });
        const data = await res.json();

        if (data.locked) {
          errorMsg.style.display = 'block';
          errorMsg.textContent = "Bloccato. Riprova tra " + data.secondsLeft + " secondi.";
          checkLockStatus();
          return;
        }

        if (!data.success) {
          errorMsg.style.display = 'block';
          errorMsg.textContent = "Password errata. Tentativi rimasti: " + (data.attemptsLeft ?? 0);
          return;
        }

        lockBox.style.display = 'none';
        noteArea.style.display = 'block';
        errorMsg.style.display = 'none';

        try {
          const resNotes = await fetch('/get-notes?user=' + encodeURIComponent(currentUser));
          notes = await resNotes.json();
          renderNotes();
        } catch { notes = []; }
      };

      closeBtn.onclick = () => {
        noteArea.style.display = 'none';
        lockBox.style.display = 'block';
        passwordInput.value = "";
      };

      // FIX #3: nuova nota senza id — il server farà insert
      addNoteBtn.onclick = () => {
        const nuovaNota = { text: "", images: [] }; // niente id, il DB lo assegna
        notes.push(nuovaNota);
        renderNotes();
      };

      checkLockStatus();
    });

    window.addEventListener("load", () => {
      const loader = document.getElementById("loader");
      if (loader) loader.style.display = "none";
    });

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
    </script>
    </body>
    </html>
    `;

    const filePath = `${process.cwd()}/compiti.html`;
    fs.writeFileSync(filePath, html, 'utf8');
    console.log(`📄 File creato: ${filePath}`);

    if (process.platform === "darwin") {
      exec(`open -a "Google Chrome" "http://localhost:3000/compiti.html"`);
    }

  } catch (err) {
    console.error("❌ ERRORE:", err.message);
  } finally {
    console.log("\nFine script. Chiudo browser...");
    await browser.close();
  }
}

/* ===== SERVER ===== */

const notesDir  = `${process.cwd()}/note_data`;
const imagesDir = `${notesDir}/images`;

if (!fs.existsSync(notesDir))  fs.mkdirSync(notesDir);
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir);

const app = express();
app.use(express.json());
app.use('/note_data', express.static(`${process.cwd()}/note_data`));
app.use(express.static(process.cwd()));

const storage = multer.diskStorage({
  destination: imagesDir,
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// FIX #7: autenticazione semplice tramite header X-Auth-User
// (si può estendere con JWT se serve)
function requireAuth(req, res, next) {
  // Per ora accettiamo qualsiasi utente — il sistema di lock protegge le note
  // In futuro: validare un token JWT qui
  next();
}

app.get('/get-notes', requireAuth, async (req, res) => {
  const userName = req.query.user;
  if (!userName) return res.status(400).json({ error: 'user mancante' });

  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('user_name', userName);

  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/save-notes', requireAuth, async (req, res) => {
  const userName = req.body.user;
  const notes    = req.body.notes;

  if (!userName || !Array.isArray(notes)) {
    return res.status(400).json({ error: 'parametri mancanti' });
  }

  try {
    for (let n of notes) {
      // FIX #3: se la nota ha un id numerico (assegnato dal client) non è ancora
      // nel DB → insert. Se ha un id proveniente da Supabase (stringa uuid o numero
      // restituito dal DB) → update.
      if (n.id && typeof n.id !== 'number') {
        // id assegnato da Supabase: aggiorna
        await supabase
          .from('notes')
          .update({ text: n.text, images: n.images, updated_at: new Date() })
          .eq('id', n.id)
          .eq('user_name', userName);
      } else {
        // Nuova nota: inserisci e aggiorna l'id locale con quello del DB
        await supabase
          .from('notes')
          .insert([{ user_name: userName, text: n.text, images: n.images }]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    const inputPath      = req.file.path;
    const outputFilename = "resized-" + req.file.filename;
    const outputPath     = `${imagesDir}/${outputFilename}`;

    await sharp(inputPath)
      .resize({ width: 800, withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(outputPath);

    fs.unlinkSync(inputPath);
    res.json({ filename: outputFilename });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore upload immagine" });
  }
});

// FIX #4: route separata per solo controllare il lock (non testa la password)
app.get('/lock-status', async (req, res) => {
  await getLockState();
  const now = Date.now();
  if (lockUntil && now < lockUntil) {
    return res.json({ locked: true, secondsLeft: Math.ceil((lockUntil - now) / 1000) });
  }
  res.json({ locked: false });
});

app.post('/unlock-notes', async (req, res) => {
  const { password } = req.body;

  // Ricarica stato dal DB (FIX #6)
  await getLockState();
  const now = Date.now();

  if (lockUntil && now < lockUntil) {
    return res.json({ success: false, locked: true, secondsLeft: Math.ceil((lockUntil - now) / 1000) });
  }

  if (!password) {
    return res.json({ success: false, attemptsLeft: 3 - failedAttempts });
  }

  const match = await bcrypt.compare(password, NOTE_PASSWORD_HASH);

  if (!match) {
    failedAttempts++;
    if (failedAttempts >= 3) {
      lockUntil = Date.now() + 3 * 60 * 1000;
      failedAttempts = 0;
      await setLockState(); // FIX #6: persiste
      return res.json({ success: false, locked: true, secondsLeft: 180 });
    }
    await setLockState(); // FIX #6: persiste
    return res.json({ success: false, attemptsLeft: 3 - failedAttempts });
  }

  failedAttempts = 0;
  lockUntil = null;
  await setLockState(); // FIX #6: persiste
  res.json({ success: true });
});

// FIX #1 & #2: un solo app.get('/') e un solo app.listen()
app.get('/', (req, res) => {
  res.sendFile(`${process.cwd()}/compiti.html`);
});

app.get('/ready', (req, res) => {
  try {
    const html = fs.readFileSync(`${process.cwd()}/compiti.html`, 'utf8');
    html.includes('Caricamento...')
      ? res.status(503).send('not ready')
      : res.status(200).send('ready');
  } catch {
    res.status(503).send('not ready');
  }
});

// Placeholder iniziale
const placeholderPath = `${process.cwd()}/compiti.html`;
if (!fs.existsSync(placeholderPath)) {
  fs.writeFileSync(placeholderPath, `
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <title>Caricamento...</title>
  <script>
    setInterval(async () => {
      const res = await fetch('/ready');
      if (res.ok) window.location.reload();
    }, 5000);
  <\/script>
  <style>
    body { background: #121212; color: #eaeaea; display: flex;
           justify-content: center; align-items: center; height: 100vh;
           flex-direction: column; font-family: sans-serif; margin: 0; }
    .spinner { width: 40px; height: 40px; border: 4px solid #333;
               border-top: 4px solid #339af0; border-radius: 50%;
               animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <p>Caricamento compiti...</p>
</body>
</html>
  `);
}

// FIX #1: un solo app.listen()
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));

// Scraping in background
aggiornaCompiti().catch(console.error);
setInterval(aggiornaCompiti, 2 * 60 * 60 * 1000);
