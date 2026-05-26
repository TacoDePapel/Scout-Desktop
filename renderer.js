// Scout Desktop — renderer.js v1.0.0

// ---- Settings ----

async function getSetting(key, fallback) {
  const v = await window.electronAPI.getSettings(key)
  return v !== null ? v : fallback
}
async function setSetting(key, value) { return window.electronAPI.setSettings(key, value) }
async function getMicEnabled()    { return getSetting('mic_enabled', true) }
async function getRecordingMode() {
  const m = await getSetting('recording_mode', 'skill')
  return m === 'improvement' ? 'improvement' : 'skill'
}

// ---- Supabase ----

const SUPABASE_URL      = 'https://wmicxsafqbixedpjhchc.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtaWN4c2FmcWJpeGVkcGpoY2hjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2OTYyNjEsImV4cCI6MjA5MzI3MjI2MX0.sDw4CoqdmS5CvoRThd1bn1lzCH8Lp5_mRXzI0T3gZ1A'

let supabase    = null
let currentUser = null

async function initSupabase() {
  if (!window.supabase) return
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: true },
  })
  const saved = await getSetting('supabase_session', null)
  if (saved?.access_token) {
    const { data, error } = await supabase.auth.setSession(saved)
    if (!error && data.user) {
      currentUser = data.user
    } else {
      await setSetting('supabase_session', null)
    }
  }
  supabase.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user ?? null
    if (session) {
      await setSetting('supabase_session', {
        access_token:  session.access_token,
        refresh_token: session.refresh_token,
      })
    } else {
      await setSetting('supabase_session', null)
    }
  })
}

async function doSignOut() {
  if (!supabase) return
  await supabase.auth.signOut()
  currentUser = null
  await setSetting('supabase_session', null)
  view = { kind: 'auth', step: 'email', email: '' }
  render()
}

async function loadLibraryData() {
  if (!supabase || !currentUser) return MOCK_RECORDINGS
  try {
    const { data, error } = await supabase
      .from('recordings')
      .select('*, skills(*)')
      .order('started_at', { ascending: false })
      .limit(50)
    if (error) throw error
    return data?.length ? data : []
  } catch (e) {
    console.warn('Library fetch failed, using mock data:', e)
    return MOCK_RECORDINGS
  }
}

async function processRecording(rec, extraContext) {
  if (!supabase || !currentUser) {
    view = { kind: 'idle', tab: 'library' }
    render()
    return
  }

  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData?.session?.access_token
  if (!token) {
    view = { kind: 'idle', tab: 'library' }
    render()
    return
  }

  view = { kind: 'processing', recording: rec, stage: 'uploading', error: null }
  render()

  try {
    // 1. Insert recording row
    const { error: insertErr } = await supabase.from('recordings').insert({
      id:           rec.id,
      user_id:      currentUser.id,
      title:        rec.title,
      status:       'uploading',
      started_at:   rec.started_at,
      ended_at:     new Date().toISOString(),
      duration_ms:  rec.duration_ms,
      mode:         rec.mode,
      transcript:   { segments: [] },
      meta:         { platform: window.electronAPI.platform, ua: navigator.userAgent },
    })
    if (insertErr) throw insertErr

    // 2. Upload audio blob
    const audioPath = `${currentUser.id}/${rec.id}.webm`
    const { error: uploadErr } = await supabase.storage
      .from('audio')
      .upload(audioPath, rec._blob, { contentType: 'video/webm', upsert: true })
    if (uploadErr) throw uploadErr

    await supabase.from('recordings').update({ audio_path: audioPath, status: 'transcribing' }).eq('id', rec.id)

    view = { kind: 'processing', recording: rec, stage: 'transcribing', error: null }
    render()

    // 3. Transcribe
    const txRes = await fetch(`${SUPABASE_URL}/functions/v1/transcribe`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ recording_id: rec.id }),
    })
    if (!txRes.ok) {
      const body = await txRes.json().catch(() => ({}))
      throw new Error(body.error || `Transcription failed (${txRes.status})`)
    }

    view = { kind: 'processing', recording: rec, stage: 'drafting', error: null }
    render()

    // 4. Generate skill — SSE stream
    const skillRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-skill`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ recording_id: rec.id, ...(extraContext ? { extra: extraContext } : {}) }),
    })
    if (!skillRes.ok) {
      const body = await skillRes.json().catch(() => ({}))
      throw new Error(body.error || `Skill generation failed (${skillRes.status})`)
    }

    const ct = skillRes.headers.get('content-type') || ''
    let allSkills = [], finalSkill = null

    if (ct.includes('text/event-stream')) {
      const reader = skillRes.body.getReader()
      const dec = new TextDecoder()
      let buf = '', accumulated = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const evt = JSON.parse(line.slice(6))
            if (evt.type === 'skill_chunk') {
              accumulated += evt.text
              const el = document.getElementById('live-skill-text')
              if (el) el.textContent = accumulated
            } else if (evt.type === 'done') {
              finalSkill = evt; allSkills = evt.all || [evt]
            } else if (evt.type === 'error') {
              throw new Error(evt.message)
            }
          } catch {}
        }
      }
    } else {
      const json = await skillRes.json()
      allSkills = json.all || (json.id ? [json] : [])
      finalSkill = allSkills[0]
    }

    if (finalSkill) {
      const title = finalSkill.title || rec.title
      await supabase.from('recordings').update({ title, status: 'ready' }).eq('id', rec.id).catch(() => {})
      const updatedRec = { ...rec, title, status: 'ready', skills: allSkills }
      const primary    = allSkills.find(s => (s.kind ?? 'skill') === (rec.mode ?? 'skill')) ?? allSkills[0]
      view = { kind: 'skill', recording: updatedRec, skill: primary, allSkills }
    } else {
      view = { kind: 'processing', recording: rec, stage: 'drafting', error: 'Skill generation returned no content. The recording was saved — try again from the Library.' }
    }
    render()
  } catch (err) {
    console.error('Processing failed:', err)
    view = { kind: 'processing', recording: rec, stage: 'uploading', error: err.message }
    render()
  }
}

async function exportAllSkills() {
  if (!supabase || !currentUser) return
  try {
    const { data, error } = await supabase
      .from('skills')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    if (!data?.length) { alert('No skills to export yet.'); return }
    if (!window.fflate) { alert('Zip library not loaded — try again in a moment.'); return }
    const files = {}
    for (const skill of data) {
      const slug = (skill.title || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'skill'
      const name = `${slug}-v${skill.version || 1}.md`
      files[name] = window.fflate.strToU8(skill.body_md || '')
    }
    const zipped = window.fflate.zipSync(files)
    await window.electronAPI.saveFile({
      defaultName: `scout-skills-${new Date().toISOString().slice(0,10)}.zip`,
      buffer:      Array.from(zipped),
      mimeType:    'ZIP Archive',
      extensions:  ['zip'],
    })
  } catch (e) {
    console.error('Export failed:', e)
    alert('Export failed: ' + (e.message || 'Unknown error'))
  }
}

// ---- Mock data (shown when not signed in) ----

const MOCK_SKILL_WEBFLOW = `---
name: publish-webflow-blog-post
version: 2
description: Publish a new blog post in Webflow CMS, including slug setup, SEO metadata, and scheduling.
---

# Publish Blog Post in Webflow

## Goal
Create and publish a new blog post in Webflow CMS with correct SEO settings.

## When to use
Whenever you need to publish a new post to the company blog hosted on Webflow.

## Inputs
- \`{post_title}\` — The title of the blog post
- \`{publish_date}\` — The date to schedule publication (ISO format: YYYY-MM-DD)

## Steps
1. Navigate to **cms.webflow.com** and sign in with your Orage credentials.
2. Open the **Blog Posts** collection from the left sidebar panel.
3. Click **New Item** in the top-right corner.
4. Set the **Name** field to {post_title} — this auto-generates the URL slug.
5. Review the slug: convert to lowercase, replace spaces with hyphens.
6. Write or paste the post body in the rich-text editor.
7. Expand **SEO Settings** and fill in the meta description (150 chars max).
8. Set **Publish Date** to {publish_date}.
9. Click **Save & Publish** — confirm the green success toast appears.

## Done when
The post URL resolves without a 404 and the Webflow dashboard shows **Published** status.`

const MOCK_SKILL_SUPABASE = `---
name: add-supabase-edge-function
version: 1
description: Create and deploy a Deno TypeScript edge function on Supabase.
---

# Add Supabase Edge Function

## Goal
Deploy a new serverless function to handle API requests in Supabase.

## Steps
1. In the Supabase Dashboard, navigate to **Edge Functions** in the left sidebar.
2. Click **New Function**.
3. Enter the function name in kebab-case (e.g. \`process-webhook\`).
4. Start from the boilerplate handler:
\`\`\`typescript
Deno.serve(async (req) => {
  const { name } = await req.json()
  return new Response(JSON.stringify({ hello: name }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
\`\`\`
5. Click **Deploy** and wait for the build indicator to turn green (10–20s).

## Done when
\`curl -X POST {function_url}\` returns HTTP 200 with the expected JSON body.`

const MOCK_SKILL_EXPENSE = `---
name: submit-expensify-report
version: 1
description: Create and submit a monthly expense report in Expensify with receipts attached.
---

# Submit Expense Report in Expensify

## Goal
Compile and submit a monthly expense report in Expensify for manager approval.

## Inputs
- \`{report_name}\` — Name of the report, e.g. "May 2025 Expenses"

## Steps
1. Log in to **expensify.com** with your company SSO.
2. Click **New Report** in the top navigation bar.
3. Name the report {report_name}.
4. Click **Add Expenses** → **New Expense** for each line item.
5. Upload the receipt photo or PDF for each expense.
6. Once all items are added, click **Submit** → select your manager → **Submit Report**.

## Done when
You receive a confirmation email and the report shows **Submitted — Awaiting Approval**.`

const MOCK_SKILL_JIRA = `---
kind: improvement
version: 1
description: The Jira approval flow hides the reject button, causing users to accidentally approve tickets.
---

# Fix Hidden Reject Button in Jira Approval Flow

## What's broken
The **Reject** button is visually hidden below the fold on 13" screens inside a \`max-height: 60px\` container.

## Suggested fix
\`\`\`css
.approval-actions {
  display: flex;
  gap: 8px;
  overflow: visible;
}
.approval-actions .reject-btn {
  background: #ef4444;
  color: #fff;
}
\`\`\`

## Acceptance criteria
- [ ] Both buttons visible without scrolling on a 1280×800 viewport
- [ ] Reject button has a red/danger style`

const MOCK_RECORDINGS = [
  {
    id: 'mock-1', title: 'Publish a blog post on Webflow', status: 'ready',
    started_at: new Date(Date.now() - 2 * 86400000).toISOString(), duration_ms: 147000, mode: 'skill',
    transcript: { segments: [{ text: 'Opening Webflow editor…' }] },
    skills: [{ id: 's1', recording_id: 'mock-1', user_id: 'u1', version: 2, kind: 'skill', title: 'Publish Blog Post in Webflow', body_md: MOCK_SKILL_WEBFLOW, created_at: new Date(Date.now() - 2 * 86400000).toISOString() }],
  },
  {
    id: 'mock-2', title: 'Confusing approval flow in Jira', status: 'ready',
    started_at: new Date(Date.now() - 3 * 86400000).toISOString(), duration_ms: 78000, mode: 'improvement',
    transcript: { segments: [{ text: 'This approval screen keeps tripping everyone up…' }] },
    skills: [{ id: 's4', recording_id: 'mock-2', user_id: 'u1', version: 1, kind: 'improvement', title: 'Fix Jira Approval Flow', body_md: MOCK_SKILL_JIRA, created_at: new Date(Date.now() - 3 * 86400000).toISOString() }],
  },
  {
    id: 'mock-3', title: 'Add a new Supabase edge function', status: 'ready',
    started_at: new Date(Date.now() - 5 * 86400000).toISOString(), duration_ms: 93000, mode: 'skill',
    transcript: { segments: [{ text: 'Creating a new edge function in the Supabase dashboard…' }] },
    skills: [{ id: 's2', recording_id: 'mock-3', user_id: 'u1', version: 1, kind: 'skill', title: 'Add Supabase Edge Function', body_md: MOCK_SKILL_SUPABASE, created_at: new Date(Date.now() - 5 * 86400000).toISOString() }],
  },
  {
    id: 'mock-4', title: 'Submit expense report in Expensify', status: 'ready',
    started_at: new Date(Date.now() - 12 * 86400000).toISOString(), duration_ms: 210000, mode: 'skill',
    transcript: { segments: [{ text: 'Walking through the monthly expense report submission…' }] },
    skills: [{ id: 's3', recording_id: 'mock-4', user_id: 'u1', version: 1, kind: 'skill', title: 'Submit Expense Report', body_md: MOCK_SKILL_EXPENSE, created_at: new Date(Date.now() - 12 * 86400000).toISOString() }],
  },
]

// ---- App state ----

const root = document.getElementById('app')
let view = { kind: 'loading' }

// ---- Root render ----

function render() {
  root.innerHTML = ''

  if (view.kind === 'loading') { root.appendChild(loadingView()); return }
  if (view.kind === 'auth')    { root.appendChild(authView(view)); return }

  const wrap = document.createElement('div')
  wrap.className = 'animate-fade-in'
  wrap.style.cssText = 'display:flex;flex-direction:column;min-height:100vh;'
  wrap.appendChild(compactHeader())

  const divLine = document.createElement('div')
  divLine.className = 'divider-gold'
  divLine.style.cssText = 'margin:0 20px;'
  wrap.appendChild(divLine)

  const main = document.createElement('main')
  main.style.cssText = 'flex:1;overflow-y:auto;'

  switch (view.kind) {
    case 'idle':          main.appendChild(idleView(view.tab));                                                break
    case 'recording':     main.appendChild(recordingView(view.state));                                         break
    case 'extra_context': main.appendChild(extraContextView(view.recording));                                  break
    case 'processing':    main.appendChild(processingView(view.recording, view.stage, view.error));            break
    case 'skill':         main.appendChild(skillView(view.recording, view.skill, view.allSkills || []));       break
  }

  wrap.appendChild(main)
  if (view.kind === 'idle') wrap.appendChild(bottomNav(view.tab))
  root.appendChild(wrap)
}

// ---- Compact header ----

function compactHeader() {
  const h = document.createElement('header')
  h.style.cssText = 'padding:16px 20px 12px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;'
  h.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:8px;">
      <span class="display" style="font-size:26px;">SCOUT</span>
      <span class="label" style="font-size:8px;opacity:0.55;">v1.0</span>
    </div>
    <span class="label" style="font-size:8px;opacity:0.38;">Orage AI</span>
  `
  return h
}

// ---- Bottom nav ----

function bottomNav(active) {
  const nav = document.createElement('nav')
  nav.style.cssText = 'display:flex;border-top:1px solid rgba(182,128,57,0.12);background:linear-gradient(0deg,rgba(0,0,0,0.85) 0%,rgba(12,12,12,0.70) 100%);backdrop-filter:blur(20px);flex-shrink:0;'
  const tabs = [
    { id: 'record',   label: 'Record',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>` },
    { id: 'library',  label: 'Library', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>` },
    { id: 'settings', label: 'Account', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.58-7 8-7s8 3 8 7" stroke-linecap="round"/></svg>` },
  ]
  for (const t of tabs) {
    const btn = document.createElement('button')
    btn.className = `nav-tab${active === t.id ? ' active' : ''}`
    btn.innerHTML = `${t.icon}<span>${t.label}</span>`
    btn.onclick = () => { view = { kind: 'idle', tab: t.id }; render() }
    nav.appendChild(btn)
  }
  return nav
}

// ---- Loading splash ----

function loadingView() {
  const d = document.createElement('div')
  d.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#000;background-image:radial-gradient(ellipse 500px 420px at 105% -10%,rgba(182,128,57,0.13) 0%,transparent 62%),radial-gradient(ellipse 480px 480px at -10% 115%,rgba(228,175,122,0.07) 0%,transparent 62%);'
  d.innerHTML = `
    <div style="font-family:'Bebas Neue',Impact,sans-serif;font-size:52px;letter-spacing:0.05em;color:#E4AF7A;line-height:1;text-transform:uppercase;">SCOUT</div>
    <div style="font-family:'Bebas Neue',sans-serif;font-size:10px;letter-spacing:0.30em;color:rgba(182,128,57,0.55);text-transform:uppercase;margin-top:10px;">By Orage AI</div>
    <div style="margin-top:28px;width:36px;height:2px;background:linear-gradient(90deg,transparent,#B68039,transparent);animation:shimmer 1.4s ease infinite;"></div>
  `
  return d
}

// ---- Auth view (OTP) ----

function authView({ step, email }) {
  const d = document.createElement('div')
  d.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:32px 24px;background-image:radial-gradient(ellipse 500px 420px at 105% -10%,rgba(182,128,57,0.13) 0%,transparent 62%),radial-gradient(ellipse 480px 480px at -10% 115%,rgba(228,175,122,0.07) 0%,transparent 62%);'

  const logo = document.createElement('div')
  logo.style.cssText = 'text-align:center;margin-bottom:40px;'
  logo.innerHTML = `
    <div style="font-family:'Bebas Neue',Impact,sans-serif;font-size:48px;letter-spacing:0.05em;color:#E4AF7A;line-height:1;">SCOUT</div>
    <div style="font-size:9px;letter-spacing:0.28em;color:rgba(182,128,57,0.55);text-transform:uppercase;margin-top:6px;font-family:'Bebas Neue',sans-serif;">By Orage AI</div>
  `
  d.appendChild(logo)

  const card = document.createElement('div')
  card.className = 'glass'
  card.style.cssText = 'width:100%;max-width:320px;padding:24px;'

  if (step === 'email') {
    card.innerHTML = `
      <div class="display" style="font-size:16px;color:#E4AF7A;margin-bottom:4px;">Sign in</div>
      <p style="font-size:11px;color:rgba(255,232,199,0.45);margin-bottom:20px;line-height:1.6;">We'll send a 6-digit code to your inbox. No password needed.</p>
      <input id="auth-email" type="email" class="input" placeholder="you@orage.agency"
        style="font-size:13px;margin-bottom:12px;width:100%;" />
      <div id="auth-error" style="font-size:11px;color:#F87171;min-height:16px;margin-bottom:8px;"></div>
      <button id="auth-send" class="btn btn-primary" style="width:100%;">Continue →</button>
    `
    const sendOTP = async () => {
      const emailEl = card.querySelector('#auth-email')
      const errEl   = card.querySelector('#auth-error')
      const btn     = card.querySelector('#auth-send')
      const em      = emailEl.value.trim()
      if (!em || !emailEl.checkValidity()) { errEl.textContent = 'Please enter a valid email address.'; return }
      if (!supabase) { errEl.textContent = 'Could not connect to backend. Check your internet connection.'; return }
      btn.textContent = 'Sending…'; btn.disabled = true; errEl.textContent = ''
      const { error } = await supabase.auth.signInWithOtp({ email: em, options: { shouldCreateUser: true } })
      if (error) {
        errEl.textContent = error.message
        btn.disabled = false; btn.textContent = 'Continue →'
        return
      }
      view = { kind: 'auth', step: 'otp', email: em }
      render()
    }
    card.querySelector('#auth-send').onclick = sendOTP
    card.querySelector('#auth-email').addEventListener('keydown', e => { if (e.key === 'Enter') sendOTP() })
    setTimeout(() => card.querySelector('#auth-email').focus(), 60)

  } else {
    card.innerHTML = `
      <div class="display" style="font-size:16px;color:#E4AF7A;margin-bottom:4px;">Check your inbox</div>
      <p style="font-size:11px;color:rgba(255,232,199,0.45);margin-bottom:2px;line-height:1.6;">6-digit code sent to</p>
      <p style="font-size:12px;color:#FFE8C7;font-weight:600;margin-bottom:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(email)}</p>
      <input id="auth-otp" type="text" inputmode="numeric" class="input"
        placeholder="000000" maxlength="6"
        style="font-size:22px;letter-spacing:0.5em;text-align:center;font-family:'JetBrains Mono',monospace;margin-bottom:12px;width:100%;" />
      <div id="auth-error" style="font-size:11px;color:#F87171;min-height:16px;margin-bottom:8px;"></div>
      <button id="auth-verify" class="btn btn-primary" style="width:100%;margin-bottom:8px;">Verify →</button>
      <div style="display:flex;gap:8px;">
        <button id="auth-resend" class="btn" style="flex:1;font-size:11px;">Resend code</button>
        <button id="auth-back"   class="btn" style="flex:1;font-size:11px;">← Change email</button>
      </div>
    `
    const verify = async () => {
      const otpEl = card.querySelector('#auth-otp')
      const errEl = card.querySelector('#auth-error')
      const btn   = card.querySelector('#auth-verify')
      const token = otpEl.value.replace(/\D/g, '')
      if (token.length !== 6) return
      if (!supabase) { errEl.textContent = 'Not connected to backend.'; return }
      btn.textContent = 'Verifying…'; btn.disabled = true; errEl.textContent = ''
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
      if (error) {
        errEl.textContent = error.message
        btn.disabled = false; btn.textContent = 'Verify →'
        return
      }
      currentUser = data.user
      view = { kind: 'idle', tab: 'record' }
      render()
    }
    const otpInput = card.querySelector('#auth-otp')
    card.querySelector('#auth-verify').onclick = verify
    otpInput.addEventListener('keydown', e => { if (e.key === 'Enter') verify() })
    otpInput.addEventListener('input', e => { if (e.target.value.replace(/\D/g, '').length === 6) verify() })
    card.querySelector('#auth-resend').onclick = async () => {
      const btn = card.querySelector('#auth-resend')
      btn.textContent = 'Sending…'; btn.disabled = true
      await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
      btn.textContent = 'Sent ✓'
      setTimeout(() => { btn.textContent = 'Resend code'; btn.disabled = false }, 4000)
    }
    card.querySelector('#auth-back').onclick = () => { view = { kind: 'auth', step: 'email', email }; render() }
    setTimeout(() => card.querySelector('#auth-otp').focus(), 60)
  }

  d.appendChild(card)
  return d
}

// ---- Idle ----

function idleView(tab) {
  if (tab === 'record')  return recordTab()
  if (tab === 'library') return libraryTab()
  return settingsTab()
}

// ---- Source picker modal ----

function showSourcePickerModal() {
  return new Promise(async (resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.90);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px;'
    overlay.innerHTML = `
      <div class="glass" style="width:100%;padding:20px;display:flex;flex-direction:column;gap:14px;max-height:90vh;">
        <div>
          <div class="display" style="font-size:16px;color:#E4AF7A;">Choose a screen to record</div>
          <p style="font-size:11px;color:rgba(255,232,199,0.45);margin-top:4px;">Select a window or display.</p>
        </div>
        <div id="src-loading" style="font-size:12px;color:rgba(255,232,199,0.40);text-align:center;padding:20px 0;">Loading sources…</div>
        <div id="src-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;overflow-y:auto;max-height:360px;padding-right:2px;display:none;"></div>
        <button id="cancel-picker" class="btn" style="width:100%;font-size:12px;flex-shrink:0;">Cancel</button>
      </div>
    `
    document.body.appendChild(overlay)
    overlay.querySelector('#cancel-picker').onclick = () => { overlay.remove(); resolve(null) }

    let sources
    try { sources = await window.electronAPI.getSources() }
    catch (e) {
      overlay.querySelector('#src-loading').textContent = 'Could not load sources: ' + e.message
      overlay.querySelector('#cancel-picker').onclick = () => { overlay.remove(); resolve(null) }
      return
    }

    overlay.querySelector('#src-loading').style.display = 'none'
    const grid = overlay.querySelector('#src-grid')
    grid.style.display = 'grid'

    for (const src of sources) {
      const card = document.createElement('button')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(182,128,57,0.18);cursor:pointer;transition:all 0.12s ease;text-align:left;'
      const img = document.createElement('img')
      img.src = src.thumbnail
      img.style.cssText = 'width:100%;border-radius:4px;object-fit:cover;aspect-ratio:16/10;background:#0a0a0a;display:block;'
      const label = document.createElement('span')
      label.style.cssText = "font-size:9px;font-family:'Montserrat',sans-serif;color:rgba(255,232,199,0.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;"
      label.textContent = src.name
      card.appendChild(img); card.appendChild(label)
      card.onmouseenter = () => { card.style.borderColor = 'rgba(182,128,57,0.52)'; card.style.background = 'rgba(182,128,57,0.08)' }
      card.onmouseleave = () => { card.style.borderColor = 'rgba(182,128,57,0.18)'; card.style.background = 'rgba(255,255,255,0.04)' }
      card.onclick = () => { overlay.remove(); resolve(src.id) }
      grid.appendChild(card)
    }
  })
}

// ---- Record tab ----

function recordTab() {
  const d = document.createElement('div')
  d.style.cssText = 'display:flex;flex-direction:column;align-items:center;padding:28px 24px 20px;gap:20px;'

  d.innerHTML = `
    <div style="position:relative;display:flex;align-items:center;justify-content:center;width:140px;height:140px;">
      <div class="record-ring-pulse" style="position:absolute;inset:0;border:1.5px solid rgba(182,128,57,0.28);border-radius:50%;"></div>
      <div class="record-ring-pulse-delay" style="position:absolute;inset:0;border:1px solid rgba(182,128,57,0.16);border-radius:50%;"></div>
      <div style="position:absolute;inset:-10px;border:1px solid rgba(182,128,57,0.12);border-radius:50%;"></div>
      <button id="rec"
        style="width:108px;height:108px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#D4924A 0%,#9A6228 55%,#7A4A18 100%);border:1px solid rgba(228,175,122,0.65);box-shadow:0 1px 0 rgba(255,255,255,0.20) inset,0 -2px 0 rgba(0,0,0,0.32) inset,0 10px 40px rgba(182,128,57,0.44);animation:record-btn-idle 3s ease-in-out infinite;cursor:pointer;transition:transform 0.15s;">
        <span style="display:block;width:36px;height:36px;border-radius:50%;background:linear-gradient(180deg,#2a1506 0%,#1a0e02 100%);box-shadow:0 2px 8px rgba(0,0,0,0.60) inset;"></span>
      </button>
    </div>

    <div style="text-align:center;">
      <div class="display" style="font-size:20px;color:#E4AF7A;">Start Recording</div>
      <p id="mode-blurb" style="font-size:12px;line-height:1.65;margin-top:6px;color:rgba(255,232,199,0.50);max-width:240px;margin-inline:auto;"></p>
    </div>

    <div class="glass" style="width:100%;padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="label" style="font-size:9px;flex:1;">What are you making?</span>
        <div style="display:flex;gap:4px;">
          <button id="mode-skill"       class="tab-pill" style="font-size:10px;padding:4px 10px;">How-To Guide</button>
          <button id="mode-improvement" class="tab-pill" style="font-size:10px;padding:4px 10px;">Bug Report</button>
        </div>
      </div>
      <div class="divider-subtle"></div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span id="mic-icon" style="font-size:13px;flex-shrink:0;">🎙</span>
        <span style="font-size:12px;flex:1;color:rgba(255,232,199,0.60);">Narrate as you go</span>
        <button id="mic-toggle" class="tab-pill" style="font-size:10px;min-width:36px;padding:4px 10px;">ON</button>
      </div>
    </div>

    <div class="glass" id="how-card" style="width:100%;padding:14px 16px;display:flex;flex-direction:column;gap:8px;border-color:rgba(182,128,57,0.25);">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span class="label" style="font-size:9px;">HOW IT WORKS</span>
        <button id="dismiss-hw" style="font-size:16px;line-height:1;background:none;border:none;cursor:pointer;color:rgba(255,232,199,0.35);padding:0 2px;">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;flex-shrink:0;">🔴</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.65);">Hit record, pick a screen, do your task, narrate as you go.</span></div>
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;flex-shrink:0;">✨</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.65);">Scout turns your recording into a step-by-step guide your AI can follow.</span></div>
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;flex-shrink:0;">📚</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.65);">Find all your guides in Library. Download, copy, or use them anytime.</span></div>
      </div>
    </div>
  `

  void getSetting('hw_dismissed', false).then(v => { if (v) d.querySelector('#how-card')?.remove() })
  d.querySelector('#dismiss-hw').onclick = async () => { await setSetting('hw_dismissed', true); d.querySelector('#how-card')?.remove() }

  const micIcon   = d.querySelector('#mic-icon')
  const micToggle = d.querySelector('#mic-toggle')
  void getMicEnabled().then(enabled => {
    micToggle.textContent = enabled ? 'ON' : 'OFF'
    micToggle.className   = `tab-pill${enabled ? ' active' : ''}`
    micToggle.style.cssText = 'font-size:10px;min-width:36px;padding:4px 10px;'
    micIcon.style.opacity = enabled ? '1' : '0.3'
  })
  micToggle.onclick = async () => {
    const next = micToggle.textContent === 'OFF'
    await setSetting('mic_enabled', next)
    micToggle.textContent = next ? 'ON' : 'OFF'
    micToggle.className   = `tab-pill${next ? ' active' : ''}`
    micToggle.style.cssText = 'font-size:10px;min-width:36px;padding:4px 10px;'
    micIcon.style.opacity = next ? '1' : '0.3'
  }

  const modeSkillBtn   = d.querySelector('#mode-skill')
  const modeImproveBtn = d.querySelector('#mode-improvement')
  const blurb          = d.querySelector('#mode-blurb')
  const applyMode = mode => {
    const imp = mode === 'improvement'
    modeSkillBtn.className    = `tab-pill${!imp ? ' active' : ''}`
    modeSkillBtn.style.cssText  = 'font-size:10px;padding:4px 10px;'
    modeImproveBtn.className  = `tab-pill${imp ? ' active' : ''}`
    modeImproveBtn.style.cssText = 'font-size:10px;padding:4px 10px;'
    blurb.textContent = imp
      ? "Show what's broken or confusing. Scout will write a clear report your team can act on."
      : 'Do the task as you normally would. Scout will turn your recording into a step-by-step guide.'
  }
  void getRecordingMode().then(applyMode)
  modeSkillBtn.onclick   = async () => { await setSetting('recording_mode', 'skill');       applyMode('skill') }
  modeImproveBtn.onclick = async () => { await setSetting('recording_mode', 'improvement'); applyMode('improvement') }

  d.querySelector('#rec').onclick = startRecording
  return d
}

// ---- Start recording ----

async function startRecording() {
  const mode       = await getRecordingMode()
  const micEnabled = await getMicEnabled()

  const sourceId = await showSourcePickerModal()
  if (!sourceId) return

  await window.electronAPI.setSelectedSource(sourceId)

  let screenStream
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  } catch (e) {
    console.error('Screen capture failed:', e)
    return
  }

  let micStream = null
  if (micEnabled) {
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) }
    catch (e) { console.warn('Mic unavailable:', e) }
  }

  const tracks   = [...screenStream.getVideoTracks(), ...(micStream ? micStream.getAudioTracks() : [])]
  const combined = new MediaStream(tracks)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm'
  const recorder = new MediaRecorder(combined, { mimeType })
  const chunks   = []
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
  recorder.start(5000)

  view = {
    kind: 'recording',
    state: {
      recording_id: crypto.randomUUID(),
      started_at:   Date.now(),
      paused_ms:    0,
      is_paused:    false,
      mic_enabled:  micEnabled,
      audio_supported: micStream !== null,
      mode,
      _recorder: recorder, _chunks: chunks, _screenStream: screenStream, _micStream: micStream,
    },
  }

  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (view.kind === 'recording') void doStopRecording()
  })

  render()
}

// ---- Stop recording ----

async function doStopRecording() {
  if (view.kind !== 'recording') return
  const { _recorder, _chunks, _screenStream, _micStream, recording_id, started_at, paused_ms, mode } = view.state

  _screenStream?.getTracks().forEach(t => t.stop())
  _micStream?.getTracks().forEach(t => t.stop())

  await new Promise(resolve => {
    _recorder.onstop = resolve
    if (_recorder.state !== 'inactive') _recorder.stop()
  })

  const blob     = new Blob(_chunks, { type: 'video/webm' })
  const duration = Date.now() - started_at - (paused_ms || 0)

  const rec = {
    id:          recording_id,
    title:       'New recording',
    status:      'ready',
    started_at:  new Date(started_at).toISOString(),
    duration_ms: duration,
    mode,
    transcript:  { segments: [] },
    skills:      [],
    _blob:       blob,
  }

  view = { kind: 'extra_context', recording: rec }
  render()
}

// ---- Recording view ----

function recordingView(s) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:16px;'

  const audioBadge = s.mic_enabled && s.audio_supported
    ? `<span style="display:inline-flex;align-items:center;gap:4px;font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#4ADE80;"><span style="width:6px;height:6px;border-radius:50%;background:#4ADE80;animation:pulse-dot 1.6s ease-in-out infinite;display:inline-block;"></span>MIC LIVE</span>`
    : s.mic_enabled
    ? `<span class="badge badge-orange">🎙 denied</span>`
    : `<span class="badge badge-muted">🎙 off</span>`

  d.innerHTML = `
    <div class="glass-hero" style="padding:20px;text-align:center;">
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:12px;">
        <span class="record-dot"></span>
        <span class="display" style="font-size:13px;color:#E4AF7A;">${s.mode === 'improvement' ? 'Critiquing' : 'Recording'}</span>
        ${audioBadge}
      </div>
      <div id="t" class="display" style="font-size:54px;color:#FFE8C7;letter-spacing:0.04em;font-variant-numeric:tabular-nums;">00:00</div>
      <div style="font-size:11px;margin-top:8px;color:rgba(255,232,199,0.45);">capturing your screen</div>
    </div>

    <div style="display:flex;gap:8px;">
      <button id="pause" class="btn" style="flex:1;">${s.is_paused ? 'Resume' : 'Pause'}</button>
      <button id="stop"  class="btn btn-primary" style="flex:1;">Stop & Generate</button>
    </div>
    <button id="discard" class="btn" style="width:100%;color:rgba(239,68,68,0.75);border-color:rgba(239,68,68,0.30);font-size:11px;">Cancel recording</button>

    <div class="glass" style="padding:12px;">
      <div class="label" style="font-size:8px;margin-bottom:4px;">Tip</div>
      <div id="tip-text" style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.55);transition:opacity 0.4s;"></div>
    </div>
  `

  const startedMs = s.started_at
  const tEl = d.querySelector('#t')
  const timerInterval = setInterval(() => {
    if (view.kind !== 'recording') { clearInterval(timerInterval); return }
    if (view.state.is_paused) return
    const ms  = Math.max(0, Date.now() - startedMs - (view.state.paused_ms ?? 0))
    const sec = Math.floor(ms / 1000) % 60
    const min = Math.floor(ms / 60000)
    tEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }, 500)

  const TIPS = s.mode === 'improvement'
    ? ["Say what you expected, then show what actually happened.", "Name the component — \"This button on the Leads table doesn't…\"", "Show error messages or loading states you think are wrong.", "Narrate impact — \"This makes it impossible to submit.\""]
    : ["Say what you're doing as you do it.", "Mention the why — \"We always skip this field for EU contacts\".", "Note exceptions — \"If it's red, it needs approval first\".", "Call out decision points — \"Here I check if the total is over $500\"."]
  let tipIdx = 0
  const tipEl = d.querySelector('#tip-text')
  tipEl.textContent = TIPS[0]; tipIdx = 1
  const tipInterval = setInterval(() => {
    if (!d.isConnected) { clearInterval(tipInterval); return }
    tipEl.style.opacity = '0'
    setTimeout(() => { if (d.isConnected) { tipEl.textContent = TIPS[tipIdx % TIPS.length]; tipEl.style.opacity = '1'; tipIdx++ } }, 400)
  }, 7000)

  d.querySelector('#pause').onclick = () => {
    view.state.is_paused = !view.state.is_paused
    if (view.state._recorder?.state === 'recording') view.state._recorder.pause()
    else if (view.state._recorder?.state === 'paused') view.state._recorder.resume()
    render()
  }

  d.querySelector('#stop').onclick = async () => {
    clearInterval(timerInterval); clearInterval(tipInterval)
    await doStopRecording()
  }

  let discardConfirming = false
  const discardBtn = d.querySelector('#discard')
  discardBtn.onclick = () => {
    if (!discardConfirming) {
      discardConfirming = true
      discardBtn.textContent = 'Tap again to confirm'
      setTimeout(() => { discardConfirming = false; discardBtn.textContent = 'Cancel recording' }, 3000)
    } else {
      clearInterval(timerInterval); clearInterval(tipInterval)
      view.state._screenStream?.getTracks().forEach(t => t.stop())
      view.state._micStream?.getTracks().forEach(t => t.stop())
      if (view.state._recorder?.state !== 'inactive') view.state._recorder?.stop()
      view = { kind: 'idle', tab: 'record' }
      render()
    }
  }

  return d
}

// ---- Extra context view ----

function extraContextView(rec) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:12px;'

  const dur        = rec.duration_ms ? `${Math.round(rec.duration_ms / 1000)}s` : ''
  const canGenerate = !!(supabase && currentUser)
  const primaryLabel   = canGenerate ? 'Generate Skill ✦' : 'Save to disk'
  const secondaryLabel = canGenerate ? 'Discard recording' : 'Discard'
  const infoText = canGenerate
    ? 'Scout will upload your recording, transcribe the narration, then generate a SKILL.md using Claude.'
    : 'Sign in on the Account tab to enable automatic skill generation. The recording will be discarded if you continue.'

  d.innerHTML = `
    <div class="glass" style="padding:20px;display:flex;flex-direction:column;gap:12px;">
      <div>
        <div class="display" style="font-size:18px;">Anything else to add?</div>
        ${dur ? `<div style="font-size:10px;margin-top:4px;color:rgba(255,232,199,0.40);">${dur} recorded</div>` : ''}
      </div>
      <p style="font-size:12px;line-height:1.65;color:rgba(255,232,199,0.60);">
        Any context that's hard to see on screen — a rule, an exception, a reason you chose one option over another.
      </p>
      <textarea id="ec" class="input" rows="4"
        placeholder="e.g. We always pick the earliest delivery date for California — it's a legal thing."
        style="resize:vertical;min-height:80px;"></textarea>
      <div style="display:flex;gap:8px;">
        <button id="ec-save" class="btn btn-primary" style="flex:1;">${primaryLabel}</button>
        <button id="ec-skip" class="btn"             style="flex:1;">${secondaryLabel}</button>
      </div>
    </div>
    <div class="glass" style="padding:12px;display:flex;align-items:start;gap:10px;border-color:rgba(182,128,57,0.15);">
      <span style="color:#B68039;font-size:13px;flex-shrink:0;margin-top:1px;">ⓘ</span>
      <div style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.45);">${infoText}</div>
    </div>
  `

  d.querySelector('#ec-save').onclick = async () => {
    const extra = d.querySelector('#ec').value.trim()
    if (canGenerate) {
      await processRecording(rec, extra)
    } else {
      view = { kind: 'idle', tab: 'library' }
      render()
    }
  }
  d.querySelector('#ec-skip').onclick = () => {
    if (canGenerate && rec._blob) {
      if (!confirm('Discard this recording? It will not be saved.')) return
    }
    view = { kind: 'idle', tab: 'library' }
    render()
  }
  setTimeout(() => d.querySelector('#ec').focus(), 50)
  return d
}

// ---- Processing view ----

function processingView(rec, stage, error) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:16px;'

  const stages = [
    { id: 'uploading',    label: 'Uploading',    sub: 'audio + metadata' },
    { id: 'transcribing', label: 'Transcribing', sub: 'voice narration' },
    { id: 'drafting',     label: 'Drafting',     sub: rec.mode === 'improvement' ? 'improvement brief' : 'skill file' },
  ]
  const currentIdx = stages.findIndex(s => s.id === stage)
  const pct = stage === 'uploading' ? 18 : stage === 'transcribing' ? 52 : 80
  const stepsHtml = stages.map((s, i) => {
    const done = i < currentIdx, active = i === currentIdx
    const dot  = done ? 'step-dot done' : active ? 'step-dot active' : 'step-dot pending'
    return `<div class="step-row"><span class="${dot}"></span><div><div style="font-size:13px;color:${done?'rgba(255,232,199,0.65)':active?'#FFE8C7':'rgba(255,232,199,0.28)'};font-weight:600;">${s.label}</div><div style="font-size:10px;color:${active?'rgba(255,232,199,0.50)':'rgba(255,232,199,0.20)'};">${s.sub}</div></div></div>`
  }).join('')

  const liveBlock = (!error && stage === 'drafting') ? `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(182,128,57,0.12);">
      <div class="label" style="font-size:8px;margin-bottom:6px;">GENERATING</div>
      <div id="live-skill-text" style="font-size:10px;line-height:1.6;color:rgba(255,232,199,0.38);font-family:'JetBrains Mono',monospace;white-space:pre-wrap;word-break:break-word;max-height:110px;overflow-y:auto;"></div>
    </div>` : ''

  d.innerHTML = `
    <div class="glass" style="padding:20px;">
      <div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:4px;">
        <div class="display" style="font-size:18px;">${error ? 'Something went wrong' : 'Building your skill'}</div>
        ${!error ? `<span style="font-size:11px;color:rgba(255,232,199,0.35);">${pct}%</span>` : ''}
      </div>
      <div style="font-size:11px;margin-bottom:12px;color:rgba(255,232,199,0.45);">${rec.duration_ms ? Math.round(rec.duration_ms/1000)+'s recording' : 'Processing'} · usually 30–60s</div>
      ${!error ? `<div style="height:2px;background:rgba(255,255,255,0.05);border-radius:1px;margin-bottom:16px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#9A6228,#E4AF7A);border-radius:1px;transition:width 0.6s ease;"></div></div>` : ''}
      ${error
        ? `<div class="glass-strong" style="padding:12px;margin-bottom:12px;border-radius:8px;"><p style="font-size:12px;color:#F87171;margin-bottom:12px;">${escapeHtml(error)}</p><button id="proc-back" class="btn" style="font-size:11px;width:100%;">← Back to Library</button></div>`
        : stepsHtml}
      ${liveBlock}
    </div>
  `
  if (error) d.querySelector('#proc-back').onclick = () => { view = { kind: 'idle', tab: 'library' }; render() }
  return d
}

// ---- Library tab ----

function libraryTab() {
  const d = document.createElement('div')
  d.style.cssText = 'display:flex;flex-direction:column;padding:16px 20px;flex:1;'

  const searchWrap = document.createElement('div')
  searchWrap.style.marginBottom = '8px'
  searchWrap.innerHTML = `
    <div style="position:relative;">
      <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:0.38;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#FFD69C" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35" stroke-linecap="round"/></svg>
      </span>
      <input id="search" type="text" placeholder="Search recordings and skills…" class="input" style="padding-left:30px;font-size:12px;" />
    </div>`
  d.appendChild(searchWrap)

  const controlBar = document.createElement('div')
  controlBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;'
  controlBar.innerHTML = `
    <span id="lib-stats" style="font-size:10px;color:rgba(255,232,199,0.28);">Loading…</span>
    <div style="display:flex;gap:4px;">
      <button data-sort="newest"     class="tab-pill active" style="font-size:9px;padding:3px 7px;">Newest</button>
      <button data-sort="oldest"     class="tab-pill"        style="font-size:9px;padding:3px 7px;">Oldest</button>
      <button data-sort="most-skills" class="tab-pill"       style="font-size:9px;padding:3px 7px;">Most</button>
    </div>`
  d.appendChild(controlBar)

  const list = document.createElement('div')
  list.id = 'list'
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;flex:1;'
  d.appendChild(list)

  let allRecordings = [], currentSort = 'newest'
  const getSorted = () => {
    const copy = [...allRecordings]
    if (currentSort === 'oldest') return copy.reverse()
    if (currentSort === 'most-skills') return copy.sort((a, b) => (b.skills?.length ?? 0) - (a.skills?.length ?? 0))
    return copy
  }
  const renderList = query => {
    const words    = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const sorted   = getSorted()
    const filtered = words.length ? sorted.filter(r => {
      const hay = [r.title ?? '', ...(r.skills ?? []).map(s => s.body_md ?? '')].join(' ').toLowerCase()
      return words.every(w => hay.includes(w))
    }) : sorted
    renderCards(list, filtered, query)
  }

  searchWrap.querySelector('#search').oninput = e => renderList(e.target.value)
  controlBar.querySelectorAll('[data-sort]').forEach(btn => {
    btn.onclick = () => {
      currentSort = btn.getAttribute('data-sort')
      controlBar.querySelectorAll('[data-sort]').forEach(b => {
        b.className = `tab-pill${b === btn ? ' active' : ''}`
        b.style.cssText = 'font-size:9px;padding:3px 7px;'
      })
      renderList(searchWrap.querySelector('#search').value)
    }
  })

  void loadLibraryData().then(data => {
    if (!data) return
    allRecordings = data
    const total = allRecordings.reduce((n, r) => n + (r.skills?.length ?? 0), 0)
    const sampleBadge = !currentUser ? '<span style="color:rgba(255,232,199,0.28);"> · sample data</span>' : ''
    controlBar.querySelector('#lib-stats').innerHTML = `${allRecordings.length} recording${allRecordings.length !== 1 ? 's' : ''} · ${total} skill${total !== 1 ? 's' : ''}${sampleBadge}`
    renderCards(list, allRecordings, '')
  })

  return d
}

function renderCards(container, rows, query) {
  container.innerHTML = ''
  if (!rows.length) {
    container.innerHTML = query
      ? `<div class="glass" style="padding:20px;margin-top:8px;text-align:center;"><div class="display" style="font-size:13px;margin-bottom:4px;">No results</div><p style="font-size:11px;color:rgba(255,232,199,0.40);">Nothing matched <strong style="color:#E4AF7A;">"${escapeHtml(query)}"</strong></p></div>`
      : `<div class="glass" style="padding:24px;text-align:center;"><div class="display" style="font-size:15px;color:#E4AF7A;margin-bottom:8px;">Your first skill is 3 clicks away.</div><p style="font-size:12px;color:rgba(255,232,199,0.45);">Hit Record, do your task, stop. Scout does the rest.</p></div>`
    return
  }
  for (const r of rows) {
    const card    = document.createElement('button')
    card.className = 'glass library-card'
    card.style.cssText = 'width:100%;padding:12px 14px;cursor:pointer;text-align:left;'
    const title     = r.title || 'Untitled recording'
    const date      = new Date(r.started_at).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    const dur       = r.duration_ms ? `${Math.round(r.duration_ms/1000)}s` : '—'
    const hasSkill  = (r.skills?.length ?? 0) > 0
    const maxVer    = hasSkill ? Math.max(...r.skills.map(s => s.version ?? 1)) : 1
    const kinds     = new Set((r.skills ?? []).map(s => s.kind ?? 'skill'))
    const kindBadge = r.mode === 'improvement' ? `<span class="badge badge-orange" style="margin-left:4px;">brief</span>` : ''
    const skillBadge = hasSkill ? `<span class="badge badge-gold">✦ Skill${maxVer > 1 ? ` · v${maxVer}` : ''}</span>` : ''
    const primary = (r.skills ?? []).find(s => (s.kind ?? 'skill') === 'skill') ?? (r.skills ?? [])[0]
    let excerpt = ''
    if (primary?.body_md) {
      const { body } = splitFrontmatter(primary.body_md)
      excerpt = body.replace(/^#+\s+.*/gm,'').replace(/\*\*/g,'').replace(/\n+/g,' ').trim().slice(0, 90)
    }
    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:10px;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#FFE8C7;">${escapeHtml(title)}</span>${kindBadge}
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
            <span style="font-size:10px;color:rgba(255,232,199,0.38);">${escapeHtml(date)} · ${dur}</span>${skillBadge}
          </div>
          ${excerpt ? `<div style="font-size:10px;margin-top:6px;line-height:1.5;color:rgba(255,232,199,0.30);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(excerpt)}…</div>` : ''}
        </div>
        <span class="${statusColor(r.status)}" style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;flex-shrink:0;">${r.status}</span>
      </div>`
    card.onclick = () => {
      const sorted  = [...(r.skills ?? [])].sort((a, b) => (b.version ?? 1) - (a.version ?? 1))
      const primary = sorted.find(s => (s.kind ?? 'skill') === (r.mode ?? 'skill')) ?? sorted[0] ?? null
      view = { kind: 'skill', recording: r, skill: primary, allSkills: sorted }
      render()
    }
    container.appendChild(card)
  }
}

// ---- Settings tab ----

function settingsTab() {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:12px;'

  const initials   = (currentUser?.email || 'OA').slice(0, 2).toUpperCase()
  const shortcutHtml = ['Alt','+','Shift','+','R'].map((k,i) => i%2===0
    ? `<span style="background:rgba(182,128,57,0.15);border:1px solid rgba(182,128,57,0.28);border-radius:4px;padding:2px 7px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#E4AF7A;">${k}</span>`
    : `<span style="color:rgba(255,232,199,0.35);font-size:10px;">${k}</span>`).join('')

  d.innerHTML = `
    <div class="glass" style="padding:16px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#C68A41,#7A4F1E);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'Bebas Neue',sans-serif;font-size:16px;color:#1a0a00;letter-spacing:0.08em;">${initials}</div>
        <div style="flex:1;min-width:0;">
          <div class="label" style="font-size:9px;margin-bottom:2px;">Signed in as</div>
          <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#FFE8C7;">${escapeHtml(currentUser?.email || '')}</div>
        </div>
      </div>
      <button id="signout-btn" class="btn" style="width:100%;">Sign out</button>
    </div>

    <div class="glass" style="padding:16px;">
      <div class="label" style="font-size:9px;margin-bottom:12px;">Export</div>
      <button id="export-btn" class="btn" style="width:100%;font-size:12px;margin-bottom:8px;">Download all skills (.zip)</button>
      <p style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.38);">All your SKILL.md files in one zip — drop into <code style="font-family:monospace;font-size:10px;background:rgba(182,128,57,0.12);padding:1px 4px;border-radius:3px;color:#E4AF7A;">~/.claude/skills/</code>.</p>
    </div>

    <div class="glass" style="padding:16px;">
      <div class="label" style="font-size:9px;margin-bottom:12px;">Global keyboard shortcut</div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:12px;color:rgba(255,232,199,0.65);">Toggle recording</span>
        <div style="display:flex;gap:4px;align-items:center;">${shortcutHtml}</div>
      </div>
      <p style="font-size:10px;margin-top:8px;line-height:1.6;color:rgba(255,232,199,0.30);">Works anywhere on your desktop — even when Scout is in the background.</p>
    </div>

    <div class="glass" style="padding:16px;">
      <div class="label" style="font-size:9px;margin-bottom:4px;">Version</div>
      <div style="font-size:12px;color:rgba(255,232,199,0.45);">Scout v1.0.0 · Orage AI Agency · Desktop</div>
    </div>
  `

  d.querySelector('#signout-btn').onclick = doSignOut
  d.querySelector('#export-btn').onclick  = exportAllSkills
  return d
}

// ---- Skill view ----

function skillView(rec, skill, allSkills) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:16px 20px;'

  const topRow = document.createElement('div')
  topRow.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:12px;'
  topRow.innerHTML = `
    <button id="back" class="btn btn-ghost" style="padding:5px 8px;font-size:11px;">← Library</button>
    <span class="${statusColor(rec.status)}" style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;">${rec.status}</span>`
  topRow.querySelector('#back').onclick = () => { view = { kind: 'idle', tab: 'library' }; render() }
  d.appendChild(topRow)

  const wordCount = skill ? skill.body_md.replace(/^---[\s\S]*?---\n?/m,'').replace(/[#*`[\]()]/g,'').split(/\s+/).filter(Boolean).length : 0
  const readMins  = wordCount > 0 ? Math.ceil(wordCount / 200) : 0
  const qScore    = skill ? skillQualityScore(rec, skill) : null

  const meta = document.createElement('div')
  meta.className = 'glass'
  meta.style.cssText = 'padding:16px;margin-bottom:12px;'
  meta.innerHTML = `
    <div class="display" style="font-size:17px;color:#E4AF7A;margin-bottom:4px;">${escapeHtml(rec.title || 'Untitled')}</div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
      <span style="font-size:11px;color:rgba(255,232,199,0.40);">${new Date(rec.started_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} · ${rec.duration_ms ? Math.round(rec.duration_ms/1000)+'s' : '—'}</span>
      ${qScore ? `<span style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${qScore.color};background:rgba(0,0,0,0.28);border:1px solid currentColor;border-radius:3px;padding:1px 5px;">${qScore.label}</span>` : ''}
    </div>
    ${wordCount > 0 ? `<div style="font-size:10px;color:rgba(255,232,199,0.28);">${wordCount} words · ${readMins} min read · v${skill?.version ?? 1}</div>` : ''}`
  d.appendChild(meta)

  if (!skill) {
    const gen = document.createElement('div'); gen.className = 'glass'; gen.style.cssText = 'padding:16px;'
    gen.innerHTML = `<div style="font-size:13px;margin-bottom:12px;color:#FFE8C7;">No skill generated yet.</div>`
    d.appendChild(gen); return d
  }

  const isImprovement = skill.kind === 'improvement' || rec.mode === 'improvement'
  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px;'

  if (isImprovement) {
    actions.innerHTML = `
      <button id="cc-copy" class="btn btn-primary" style="width:100%;">Copy for Claude Code</button>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button id="cp" class="btn" style="font-size:11px;">Copy raw</button>
        <button id="dl" class="btn" style="font-size:11px;">Save .md</button>
      </div>`
  } else {
    actions.innerHTML = `
      <button id="cc-copy" class="btn btn-primary" style="width:100%;">Copy for Claude Code — use right now</button>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button id="cp" class="btn" style="font-size:11px;">Copy raw</button>
        <button id="dl" class="btn" style="font-size:11px;">Save .md</button>
      </div>`
  }

  actions.querySelector('#cc-copy').onclick = async () => {
    const btn  = actions.querySelector('#cc-copy')
    const desc = (skill.body_md.match(/^description:\s*(.+)$/m)?.[1] ?? 'this workflow').trim()
    const text = isImprovement
      ? `You are about to make a change based on a Scout recording. Read the brief, ask if anything is unclear, then make the change.\n\n---\n\n${skill.body_md.trim()}\n\n---\n\nSummarise the files you changed and any decisions you made.`
      : `I'm sharing a skill with you so you can use it in this session. Learn it and confirm you understand it.\n\n---\n\n${skill.body_md.trim()}\n\n---\n\nWhen I ask you to perform tasks matching this skill's description ("${desc}"), follow the steps above.`
    await navigator.clipboard.writeText(text)
    btn.textContent = 'Copied — paste into Claude Code'
    setTimeout(() => { btn.textContent = isImprovement ? 'Copy for Claude Code' : 'Copy for Claude Code — use right now' }, 2500)
  }

  actions.querySelector('#cp').onclick = async () => {
    const btn = actions.querySelector('#cp')
    await navigator.clipboard.writeText(skill.body_md)
    btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = 'Copy raw' }, 1500)
  }

  actions.querySelector('#dl').onclick = async () => {
    const filename = `${(skill.title || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`
    await window.electronAPI.saveFile({
      defaultName: filename,
      buffer:      Array.from(new TextEncoder().encode(skill.body_md)),
      mimeType:    'Markdown',
      extensions:  ['md'],
    })
  }

  d.appendChild(actions)

  const slug = (skill.body_md.match(/^name:\s*(.+)$/m)?.[1] ?? 'skill').trim()
  const hint = document.createElement('div')
  hint.className = 'glass'; hint.style.cssText = 'padding:12px;margin-bottom:12px;'
  hint.innerHTML = `
    <div class="label" style="font-size:8px;margin-bottom:4px;">Install</div>
    <div style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.55);">
      Save .md and move to <code style="font-family:monospace;font-size:10px;background:rgba(182,128,57,0.13);padding:1px 5px;border-radius:3px;color:#E4AF7A;">~/.claude/skills/</code>
      — Claude Code picks up <span style="color:#E4AF7A;font-weight:600;">${escapeHtml(slug)}</span> on next session.
    </div>`
  d.appendChild(hint)

  const { frontmatter, body } = splitFrontmatter(stripImageRefs(skill.body_md))
  if (frontmatter) {
    const fm = document.createElement('div')
    fm.className = 'glass'; fm.style.cssText = "padding:12px;margin-bottom:12px;font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.6;color:rgba(255,232,199,0.48);white-space:pre-wrap;word-break:break-word;"
    fm.textContent = frontmatter; d.appendChild(fm)
  }

  const mdWrap = document.createElement('div'); mdWrap.style.position = 'relative'
  const md = document.createElement('article'); md.className = 'skill-md text-primary'
  md.innerHTML = renderSkillMd(body)
  const fade = document.createElement('div'); fade.className = 'skill-body-fade'
  mdWrap.appendChild(md); mdWrap.appendChild(fade); d.appendChild(mdWrap)

  const cta = document.createElement('div')
  cta.className = 'glass'; cta.style.cssText = 'padding:16px;margin-top:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;'
  cta.innerHTML = `
    <div>
      <div style="font-size:12px;font-weight:600;color:#FFE8C7;">Capture another workflow?</div>
      <div style="font-size:10px;margin-top:2px;color:rgba(255,232,199,0.40);">Each recording sharpens your AI agent.</div>
    </div>
    <button id="cta-rec" class="btn btn-primary" style="font-size:11px;padding:6px 12px;white-space:nowrap;">Record →</button>`
  cta.querySelector('#cta-rec').onclick = () => { view = { kind: 'idle', tab: 'record' }; render() }
  d.appendChild(cta)
  return d
}

// ---- Utilities ----

function escapeHtml(s) {
  if (!s) return ''
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}
function statusColor(s) {
  if (s === 'ready')                               return 'status-ready'
  if (s === 'failed')                              return 'status-failed'
  if (s === 'transcribing' || s === 'uploading')   return 'status-progress'
  return 'status-idle'
}
function splitFrontmatter(md) {
  const m = md?.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { frontmatter: '', body: md || '' }
  return { frontmatter: m[1].trim(), body: md.slice(m[0].length) }
}
function stripImageRefs(md) {
  return (md || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[ \t]+\n/g, '\n')
}
function highlightVariables(html) {
  return html.replace(/(?<![="a-zA-Z0-9])\{([a-z_][a-z0-9_]*)\}/g, (_, n) => `<span class="skill-var">{${n}}</span>`)
}
function renderSkillMd(bodyMd) {
  if (window.marked) return highlightVariables(window.marked.parse(bodyMd))
  return escapeHtml(bodyMd).replace(/\n/g, '<br>')
}
function skillQualityScore(rec, skill) {
  let pts = 0
  const dur = rec.duration_ms ?? 0
  if (dur >= 120000) pts += 30; else if (dur >= 30000) pts += 20; else if (dur >= 5000) pts += 10
  const words = (rec.transcript?.segments ?? []).reduce((n, s) => n + (s.text?.split(/\s+/).filter(Boolean).length ?? 0), 0)
  if (words >= 100) pts += 30; else if (words >= 20) pts += 20; else if (words > 0) pts += 10
  const bodyLen = skill.body_md?.length ?? 0
  if (bodyLen >= 2000) pts += 40; else if (bodyLen >= 800) pts += 25; else if (bodyLen >= 200) pts += 15
  const score = Math.min(100, pts)
  if (score >= 85) return { score, label: 'Excellent', color: '#4ADE80' }
  if (score >= 65) return { score, label: 'Strong',    color: '#E4AF7A' }
  if (score >= 40) return { score, label: 'Good',      color: 'rgba(255,232,199,0.65)' }
  return              { score, label: 'Minimal',        color: 'rgba(255,232,199,0.35)' }
}

// ---- Boot ----

void (async () => {
  render()

  try {
    await Promise.all([
      initSupabase(),
      new Promise(r => setTimeout(r, 800)),
    ])
  } catch (e) {
    console.error('Boot error:', e)
  }

  view = currentUser ? { kind: 'idle', tab: 'record' } : { kind: 'auth', step: 'email', email: '' }
  render()

  // Global hotkey — toggles recording from anywhere on the desktop
  window.electronAPI.onHotkeyRecord(() => {
    if (view.kind === 'recording') {
      void doStopRecording()
    } else if (view.kind === 'idle') {
      if (view.tab !== 'record') { view = { kind: 'idle', tab: 'record' }; render() }
      setTimeout(() => startRecording(), 80)
    }
  })
})()
